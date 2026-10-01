import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commands, resolveCliArgv } from "jeopi-cli/cli-commands";
import * as sdk from "jeopi-cli/sdk";
import { runMessengerCommand } from "../src/cli/messenger-cli";
import * as telegram from "../src/messenger/telegram";
import { type MessengerAdapter, MessengerFatalError } from "../src/messenger/types";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(content?: string) {
	const directory = await mkdtemp(join(tmpdir(), "messenger-cli-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const config = join(directory, "private-config.json");
	await writeFile(
		config,
		content ??
			JSON.stringify({
				cwd: directory,
				sessionDir: "sessions",
				toolNames: ["read"],
				platforms: { telegram: { tokenEnv: "MESSENGER_CLI_TEST_TOKEN", allowedUserIds: ["private-sender"] } },
			}),
	);
	const previous = process.env.MESSENGER_CLI_TEST_TOKEN;
	process.env.MESSENGER_CLI_TEST_TOKEN = "not-a-real-token-DO-NOT-PRINT";
	cleanups.push(() => {
		if (previous === undefined) delete process.env.MESSENGER_CLI_TEST_TOKEN;
		else process.env.MESSENGER_CLI_TEST_TOKEN = previous;
	});
	let output = "";
	const stdout = spyOn(process.stdout, "write").mockImplementation(chunk => {
		output += String(chunk);
		return true;
	});
	cleanups.push(() => stdout.mockRestore());
	// This is a tripwire at the external boundary, not a substitute config validator.
	const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Local check attempted network"));
	cleanups.push(() => network.mockRestore());
	return { config, network, output: () => output };
}

describe("messenger CLI local safety", () => {
	test("validates JSON and required environment without contacting providers or printing secrets", async () => {
		const check = await fixture();
		await runMessengerCommand({ action: "check", flags: { config: check.config } });
		expect(check.output()).toContain("Messenger configuration valid: telegram; 1 tools enabled.");
		expect(check.output()).toContain("No network checks performed.");
		for (const privateValue of ["not-a-real-token-DO-NOT-PRINT", "private-sender", check.config]) {
			expect(check.output()).not.toContain(privateValue);
		}
		expect(check.network).not.toHaveBeenCalled();
	});

	test.each(["invalid JSON", "missing token"] as const)("rejects %s locally with a redacted error", async failure => {
		const check = await fixture(failure === "invalid JSON" ? '{"credential":"PRIVATE_PARSE_MARKER",' : undefined);
		if (failure === "missing token") delete process.env.MESSENGER_CLI_TEST_TOKEN;
		await expect(runMessengerCommand({ action: "check", flags: { config: check.config } })).rejects.toThrow(
			"Messenger configuration or required environment is invalid",
		);
		expect(check.output()).toBe("");
		expect(check.network).not.toHaveBeenCalled();
	});

	test.each(["SDK initialization", "transport"] as const)(
		"preserves safe fatal diagnostics but redacts unknown %s errors",
		async failure => {
			const check = await fixture();
			const createSession = spyOn(sdk, "createAgentSession").mockRejectedValue(new Error("PRIVATE_PROVIDER_DETAIL"));
			cleanups.push(() => createSession.mockRestore());
			const deliveries: string[] = [];
			const adapter: MessengerAdapter = {
				platform: "telegram",
				async start(onMessage) {
					if (failure === "transport") throw new Error("PRIVATE_TRANSPORT_DETAIL");
					await onMessage({
						platform: "telegram",
						accountId: "bot",
						channelId: "room",
						senderId: "private-sender",
						messageId: "first",
						text: "hello",
						direct: true,
						mentioned: false,
					});
				},
				async send(_message, text) {
					deliveries.push(text);
				},
			};
			const createAdapter = spyOn(telegram, "createTelegramAdapter").mockReturnValue(adapter);
			cleanups.push(() => createAdapter.mockRestore());
			const error = await runMessengerCommand({ action: "run", flags: { config: check.config } }).catch(
				(error: unknown) => error,
			);
			if (failure === "SDK initialization") {
				expect(error).toBeInstanceOf(MessengerFatalError);
				expect(String(error)).toContain("restart required");
				expect(createSession).toHaveBeenCalledTimes(1);
			} else {
				expect(error).toBeInstanceOf(Error);
				expect(String(error)).toContain("Messenger gateway failed; check local configuration and provider access");
				expect(createSession).not.toHaveBeenCalled();
			}
			expect(String(error)).not.toContain("PRIVATE_");
			expect(check.output()).not.toContain("PRIVATE_");
			expect(deliveries).toEqual([]);
			expect(check.network).not.toHaveBeenCalled();
		},
	);

	test("routes messenger help and check to the registered command rather than a model prompt", async () => {
		expect(resolveCliArgv(["messenger", "check", "--config", "settings.json"])).toEqual({
			argv: ["messenger", "check", "--config", "settings.json"],
		});
		expect(resolveCliArgv(["--approval-mode=yolo", "messenger", "--help"])).toEqual({
			argv: ["messenger", "--approval-mode=yolo", "--help"],
		});
		const command = commands.find(entry => entry.name === "messenger");
		if (!command) throw new Error("Messenger is not a registered CLI command");
		const loaded = await command.load();
		const check = await fixture();
		await new loaded([], { bin: "jeopi", version: "test", commands: new Map([["messenger", loaded]]) }).run();
		expect(check.output()).toContain("messenger");
		expect(check.output()).toContain("--config");
		expect(check.output()).toContain("check");
		expect(check.output()).toContain("run");
		expect(check.network).not.toHaveBeenCalled();
	});
});
