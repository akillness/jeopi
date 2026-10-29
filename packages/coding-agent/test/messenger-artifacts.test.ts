import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	downloadMessengerAttachments,
	messengerArtifactDirectory,
	messengerArtifactPrompt,
} from "../src/messenger/artifacts";
import { parseMessengerConfig } from "../src/messenger/config";
import { createDiscordAdapter } from "../src/messenger/discord";
import { createMessengerGateway } from "../src/messenger/gateway";
import type { MessengerMessage, MessengerPlatformConfig } from "../src/messenger/types";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const message: MessengerMessage = {
	platform: "discord",
	accountId: "bot",
	channelId: "123",
	senderId: "alice",
	messageId: "456",
	direct: true,
	mentioned: false,
	text: "request",
};

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-artifact-"));
	roots.push(root);
	const dir = messengerArtifactDirectory(path.join(root, "exports"), message);
	await fs.mkdir(path.join(dir, "nested"), { recursive: true });
	const requests: Request[] = [];
	let response = new Response("{}", { status: 200 });
	const fetcher = Object.assign(
		async (...[input, init]: Parameters<typeof fetch>) => {
			requests.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
			return response.clone();
		},
		{ preconnect: fetch.preconnect },
	);
	const config = parseMessengerConfig(
		{
			platforms: {
				discord: {
					tokenEnv: "TEST_TOKEN",
					allowedUserIds: ["alice"],
					artifactDir: "exports",
				},
			},
		},
		root,
	);
	const adapter = createDiscordAdapter(
		config.platforms.discord as MessengerPlatformConfig,
		{ TEST_TOKEN: "fixture-secret-token" },
		{ fetch: fetcher as unknown as typeof fetch },
	);
	return {
		root,
		dir,
		requests,
		adapter,
		fail: () => {
			response = new Response("fixture-secret-token", { status: 500 });
		},
	};
}

describe("Discord artifact delivery", () => {
	test.each([
		["enabled", true],
		["disabled", false],
	] as const)(
		"real session %s write capability controls file creation",
		async (mode, enabled) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-real-write-"));
			roots.push(root);
			const child = Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "fixtures/messenger-artifact-write.ts"), root, mode],
				{
					cwd: root,
					env: {
						HOME: root,
						XDG_CONFIG_HOME: path.join(root, "config"),
						PI_CODING_AGENT_DIR: path.join(root, "agent"),
						PATH: process.env.PATH ?? "",
						CI: "1",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ code, diagnostics: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, diagnostics: "" });
			const content = await fs.readFile(path.join(root, "workspace", "result.txt"), "utf8").catch(() => undefined);
			expect(content).toBe(enabled ? "written by authorized agent\n" : undefined);
		},
		30000,
	);
	test("uploads exact bytes from a configured relative artifact directory without exposing the marker", async () => {
		const f = await fixture();
		const bytes = new Uint8Array([0, 255, 32, 10, 0xe2, 0x98, 0x83]);
		await fs.writeFile(path.join(f.dir, "nested", "result.bin"), bytes);
		await f.adapter.send(message, "Here is the result.\n[artifact:nested/result.bin]");
		const forms = await Promise.all(
			f.requests
				.filter(r => r.headers.get("content-type")?.startsWith("multipart/form-data"))
				.map(r => r.clone().formData()),
		);
		expect(forms).toHaveLength(1);
		const file = forms[0].get("files[0]");
		expect(file).toBeInstanceOf(File);
		expect((file as File).name).toBe("result.bin");
		expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(bytes);
		const bodies = await Promise.all(
			f.requests.map(async request =>
				request.headers.get("content-type")?.startsWith("multipart/form-data")
					? String((await request.clone().formData()).get("payload_json"))
					: await request.clone().text(),
			),
		);
		expect(bodies.join("\n")).not.toContain("[artifact:");
		expect(bodies.join("\n")).not.toContain("fixture-secret-token");
	});

	test.each([
		["parent traversal", "../secret.txt"],
		["absolute path", "/etc/passwd"],
		["symlink", "link.txt"],
		["directory", "nested"],
		["missing file", "missing.txt"],
	])("rejects %s without uploading content or exposing private paths", async (_name, artifactPath) => {
		const f = await fixture();
		await fs.writeFile(path.join(f.root, "secret.txt"), "sensitive-fixture-content");
		await fs.symlink(path.join(f.root, "secret.txt"), path.join(f.dir, "link.txt"));
		const error = await f.adapter.send(message, `[artifact:${artifactPath}]`).then(
			() => undefined,
			failure => failure,
		);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain(f.root);
		expect(String(error)).not.toContain("sensitive-fixture-content");
		expect(String(error)).not.toContain("fixture-secret-token");
		expect(f.requests.filter(r => r.headers.get("content-type")?.startsWith("multipart/form-data"))).toHaveLength(0);
	});

	test.each(["artifact root", "conversation directory"] as const)(
		"rejects a symlinked %s before upload",
		async component => {
			const f = await fixture();
			const external = path.join(f.root, "outside");
			const target = component === "artifact root" ? path.join(f.root, "exports") : f.dir;
			await fs.rm(target, { recursive: true });
			const outsideDir = component === "artifact root" ? messengerArtifactDirectory(external, message) : external;
			await fs.mkdir(outsideDir, { recursive: true });
			await fs.writeFile(path.join(outsideDir, "secret.txt"), "private-file-content");
			await fs.symlink(external, target);
			const error = await f.adapter.send(message, "[artifact:secret.txt]").then(
				() => undefined,
				failure => failure,
			);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).not.toContain(f.root);
			expect(f.requests.filter(r => r.headers.get("content-type")?.startsWith("multipart/form-data"))).toHaveLength(
				0,
			);
		},
	);

	test("does not upload another sender's artifact", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.dir, "private.txt"), "alice private");
		await expect(f.adapter.send({ ...message, senderId: "bob" }, "[artifact:private.txt]")).rejects.toThrow();
		expect(f.requests.filter(r => r.headers.get("content-type")?.startsWith("multipart/form-data"))).toHaveLength(0);
	});

	test("rejects a named pipe without waiting for a writer", async () => {
		const f = await fixture();
		const child = Bun.spawn(["mkfifo", path.join(f.dir, "pipe")], { stdout: "pipe", stderr: "pipe" });
		expect(await child.exited).toBe(0);
		await expect(f.adapter.send(message, "[artifact:pipe]")).rejects.toThrow();
		expect(f.requests.filter(r => r.headers.get("content-type")?.startsWith("multipart/form-data"))).toHaveLength(0);
	}, 3000);

	test("rejects oversized artifacts before uploading", async () => {
		const f = await fixture();
		const file = path.join(f.dir, "large.bin");
		await fs.writeFile(file, "");
		await fs.truncate(file, 8 * 1024 * 1024 + 1);
		await expect(f.adapter.send(message, "[artifact:large.bin]")).rejects.toThrow();
		expect(f.requests.filter(r => r.headers.get("content-type")?.startsWith("multipart/form-data"))).toHaveLength(0);
	});

	test("surfaces attachment delivery failure without leaking the token", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.dir, "result.txt"), "result content");
		f.fail();
		const error = await f.adapter.send(message, "[artifact:result.txt]").then(
			() => undefined,
			failure => failure,
		);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain("fixture-secret-token");
		expect(f.requests.filter(r => r.headers.get("content-type")?.startsWith("multipart/form-data"))).toHaveLength(1);
	});
});

describe("Discord attachment staging", () => {
	test("renders usable artifact guidance with and without staged input paths", async () => {
		const f = await fixture();
		const root = path.join(f.root, "exports");
		const signal = new AbortController().signal;
		const noInputs = await messengerArtifactPrompt(root, message, signal);
		expect(noInputs).toContain(f.dir);
		expect(noInputs).toContain("[artifact:relative/path]");
		expect(noInputs).not.toContain("Incoming files:");
		const spy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("data"));
		try {
			const rendered = await messengerArtifactPrompt(
				root,
				{
					...message,
					attachments: [
						{ url: "https://cdn.discordapp.com/attachments/1/2/input.txt", filename: "input.txt", size: 4 },
					],
				},
				signal,
			);
			const staged = (await fs.readdir(f.dir)).find(name => name.startsWith("input-"));
			if (!staged) throw new Error("Expected staged file");
			expect(rendered).toContain(f.dir);
			expect(rendered).toContain(path.join(f.dir, staged));
			expect(await fs.readFile(path.join(f.dir, staged), "utf8")).toBe("data");
		} finally {
			spy.mockRestore();
		}
	});

	test("stages exact attachment bytes privately without allowing redirects", async () => {
		const f = await fixture();
		const bytes = new Uint8Array([0, 1, 255, 10]);
		const calls: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
		const spy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (...[url, init]: Parameters<typeof fetch>) => {
					calls.push({ url: String(url), redirect: init?.redirect });
					return new Response(bytes);
				},
				{ preconnect: fetch.preconnect },
			),
		);
		try {
			const paths = await downloadMessengerAttachments(
				f.dir,
				{
					...message,
					attachments: [
						{
							url: "https://cdn.discordapp.com/attachments/1/2/report.bin",
							filename: "../report.bin",
							size: bytes.length,
						},
					],
				},
				new AbortController().signal,
			);
			expect(calls).toEqual([{ url: "https://cdn.discordapp.com/attachments/1/2/report.bin", redirect: "error" }]);
			expect(paths).toHaveLength(1);
			expect(new Uint8Array(await fs.readFile(paths[0]))).toEqual(bytes);
			expect(paths[0].startsWith(`${f.dir}/`)).toBe(true);
			expect((await fs.stat(paths[0])).mode & 0o777).toBe(0o600);
		} finally {
			spy.mockRestore();
		}
	});

	test.each([
		["insecure scheme", "http://cdn.discordapp.com/attachments/1/2/x", 1],
		["foreign host", "https://evil.example/attachments/1/2/x", 1],
		["lookalike host", "https://cdn.discordapp.com.evil.example/attachments/1/2/x", 1],
		["wrong path", "https://cdn.discordapp.com/other/x", 1],
		["oversized declaration", "https://cdn.discordapp.com/attachments/1/2/x", 8 * 1024 * 1024 + 1],
	] as const)("rejects %s before requesting the attachment", async (_name, url, size) => {
		const f = await fixture();
		const spy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
		try {
			await expect(
				downloadMessengerAttachments(
					f.dir,
					{ ...message, attachments: [{ url, filename: "x", size }] },
					new AbortController().signal,
				),
			).rejects.toThrow();
			expect(spy.mock.calls).toHaveLength(0);
		} finally {
			spy.mockRestore();
		}
	});

	test("does not stage a failed or redirected CDN response", async () => {
		const f = await fixture();
		const spy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("secret", { status: 302, headers: { location: "https://evil.example" } }),
		);
		try {
			await expect(
				downloadMessengerAttachments(
					f.dir,
					{
						...message,
						attachments: [{ url: "https://cdn.discordapp.com/attachments/1/2/x", filename: "x", size: 6 }],
					},
					new AbortController().signal,
				),
			).rejects.toThrow();
			expect(spy.mock.calls).toHaveLength(1);
			expect(await fs.readdir(f.dir)).toEqual(["nested"]);
		} finally {
			spy.mockRestore();
		}
	});

	test.each([
		["short body", "x", 2],
		["long body", "xyz", 2],
	] as const)("rejects a %s rather than staging partial content", async (_name, body, size) => {
		const f = await fixture();
		const spy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
		try {
			await expect(
				downloadMessengerAttachments(
					f.dir,
					{
						...message,
						attachments: [{ url: "https://cdn.discordapp.com/attachments/1/2/x", filename: "x", size }],
					},
					new AbortController().signal,
				),
			).rejects.toThrow();
			expect(await fs.readdir(f.dir)).toEqual(["nested"]);
		} finally {
			spy.mockRestore();
		}
	});

	test("already-aborted attachment download does not start a request", async () => {
		const f = await fixture();
		const controller = new AbortController();
		controller.abort();
		const spy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
		try {
			await expect(
				downloadMessengerAttachments(
					f.dir,
					{
						...message,
						attachments: [{ url: "https://cdn.discordapp.com/attachments/1/2/x", filename: "x", size: 1 }],
					},
					controller.signal,
				),
			).rejects.toThrow();
			expect(spy.mock.calls).toHaveLength(0);
			expect(await fs.readdir(f.dir)).toEqual(["nested"]);
		} finally {
			spy.mockRestore();
		}
	});

	test.each(["fetch", "body"] as const)(
		"times out a stalled %s and terminates the operation",
		async stage => {
			const f = await fixture();
			let canceled = false;
			let requestSignal: AbortSignal | undefined;
			const fetcher = Object.assign(
				async (...[_url, init]: Parameters<typeof fetch>) => {
					requestSignal = init?.signal ?? undefined;
					if (stage === "fetch")
						return await new Promise<Response>((_resolve, reject) => {
							requestSignal?.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
						});
					return new Response(
						new ReadableStream({
							cancel() {
								canceled = true;
							},
						}),
					);
				},
				{ preconnect: fetch.preconnect },
			);
			const input = {
				...message,
				attachments: [{ url: "https://cdn.discordapp.com/attachments/1/2/x", filename: "x", size: 1 }],
			};
			await expect(
				downloadMessengerAttachments(f.dir, input, new AbortController().signal, fetcher, 20),
			).rejects.toThrow();
			expect(requestSignal?.aborted).toBe(true);
			if (stage === "body") expect(canceled).toBe(true);
			expect(await fs.readdir(f.dir)).toEqual(["nested"]);
		},
		3000,
	);

	test("disconnect during a stalled body cancels it and permits the next queued request", async () => {
		const f = await fixture();
		const started = Promise.withResolvers<void>();
		let canceled = false;
		const spy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () =>
					new Response(
						new ReadableStream({
							pull() {
								started.resolve();
							},
							cancel() {
								canceled = true;
							},
						}),
					),
				{ preconnect: fetch.preconnect },
			),
		);
		const sent: string[] = [];
		const config = parseMessengerConfig(
			{ platforms: { discord: { tokenEnv: "TEST_TOKEN", allowedUserIds: ["alice"], artifactDir: "exports" } } },
			f.root,
		);
		const gateway = createMessengerGateway(
			config,
			[
				{
					platform: "discord",
					async start() {},
					async send(_message, text) {
						sent.push(text);
					},
				},
			],
			async (incoming, signal) => {
				if (incoming.attachments?.length)
					await messengerArtifactPrompt(config.platforms.discord?.artifactDir, incoming, signal);
				return "next request completed";
			},
		);
		const controller = new AbortController();
		const attachment = { url: "https://cdn.discordapp.com/attachments/1/2/x", filename: "x", size: 1 };
		try {
			const first = gateway.handle({ ...message, attachments: [attachment] }, controller.signal);
			await started.promise;
			const second = gateway.handle({ ...message, messageId: "next", text: "next" });
			controller.abort();
			await Promise.all([first, second]);
			expect(canceled).toBe(true);
			expect(sent).toEqual(["next request completed"]);
			expect(await fs.readdir(f.dir)).toEqual(["nested"]);
		} finally {
			controller.abort();
			spy.mockRestore();
		}
	}, 3000);
});
