import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { runConfigCommand } from "jeopi-cli/cli/config-cli";
import { isCredential, resetSettingsForTest, type SettingPath } from "jeopi-cli/config/settings";
import { AgentStorage } from "jeopi-cli/session/agent-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "jeopi-utils";

let testAgentDir: TempDir | undefined;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

beforeEach(() => {
	resetSettingsForTest();
	testAgentDir = TempDir.createSync("@omp-config-cli-");
	setAgentDir(testAgentDir.path());
});

afterEach(async () => {
	vi.restoreAllMocks();
	AgentStorage.resetInstance();
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (testAgentDir) {
		try {
			await testAgentDir.remove();
		} catch {}
		testAgentDir = undefined;
	}
});

describe("config CLI schema coverage", () => {
	it("renders record settings as JSON and with record type in text output", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "list", flags: {} });

		const lines = logSpy.mock.calls.map(call => String(call[0] ?? ""));
		const plainLines = lines.map(line => Bun.stripANSI(line));
		const modelRolesLine = plainLines.find(line => line.includes("modelRoles ="));
		expect(modelRolesLine).toBeDefined();
		const plainModelRolesLine = String(modelRolesLine);
		expect(plainModelRolesLine).toContain("modelRoles =");
		expect(plainModelRolesLine).toContain("(record)");
		expect(plainModelRolesLine).toContain("{");
		expect(plainModelRolesLine).toContain("}");
		expect(plainModelRolesLine).not.toContain("[object Object]");
	});

	it("sets and gets record settings as JSON objects", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const recordValue = '{"default":"claude-opus-4-6"}';

		await runConfigCommand({ action: "set", key: "modelRoles", value: recordValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "modelRoles", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("modelRoles");
		expect(parsed.type).toBe("record");
		expect(parsed.value).toEqual({ default: "claude-opus-4-6" });
	});

	it("normalizes valid provider in-flight request limits from JSON objects", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({
			action: "set",
			key: "providers.maxInFlightRequests",
			value: '{"openai":2.8,"anthropic":1}',
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "providers.maxInFlightRequests", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("providers.maxInFlightRequests");
		expect(parsed.type).toBe("record");
		expect(parsed.value).toEqual({ openai: 2, anthropic: 1 });
	});

	it("rejects invalid provider in-flight request limit entries", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as typeof process.exit);

		await expect(
			runConfigCommand({
				action: "set",
				key: "providers.maxInFlightRequests",
				value: '{"openai":"2","anthropic":0}',
				flags: { json: true },
			}),
		).rejects.toThrow("process.exit");
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("Provider request limits must be positive numbers: openai, anthropic"),
		);
	});

	it("sets and gets array settings as JSON arrays", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const arrayValue = '["claude-opus-4-6","gpt-5.3-codex"]';

		await runConfigCommand({ action: "set", key: "enabledModels", value: arrayValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "enabledModels", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("enabledModels");
		expect(parsed.type).toBe("array");
		expect(parsed.value).toEqual(["claude-opus-4-6", "gpt-5.3-codex"]);
	});
	it("sets numeric idle compaction settings from CLI values", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleThresholdTokens",
			value: "300000",
			flags: { json: true },
		});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleTimeoutSeconds",
			value: "600",
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "compaction.idleThresholdTokens", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "compaction.idleTimeoutSeconds", flags: { json: true } });

		const thresholdPayload = logSpy.mock.calls.at(-2)?.[0];
		const timeoutPayload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof thresholdPayload).toBe("string");
		expect(typeof timeoutPayload).toBe("string");
		expect(JSON.parse(String(thresholdPayload))).toMatchObject({
			key: "compaction.idleThresholdTokens",
			type: "number",
			value: 300000,
		});
		expect(JSON.parse(String(timeoutPayload))).toMatchObject({
			key: "compaction.idleTimeoutSeconds",
			type: "number",
			value: 600,
		});
	});

	it("accepts max as a persisted default thinking level", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "set", key: "defaultThinkingLevel", value: "max", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "defaultThinkingLevel", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("defaultThinkingLevel");
		expect(parsed.type).toBe("enum");
		expect(parsed.value).toBe("max");
	});
});

/** Shape of one `config list --json` entry. */
interface ListJsonEntry {
	value?: unknown;
	redacted?: true;
	type: string;
	description: string;
}

/** Shape of the `config get --json` payload. */
interface GetJsonPayload {
	key: string;
	value: unknown;
	type: string;
}

const REDACTED = "********";

/**
 * The slice of a `console.log` spy these helpers consume. Named locally so the
 * helpers do not publish a contract derived from the spy factory.
 */
interface LogSpy {
	mock: { calls: unknown[][] };
	mockClear(): void;
}

describe("config CLI credential redaction", () => {
	/** The rendered `path = value (type)` line for one setting in human output. */
	const lineFor = (logSpy: LogSpy, settingPath: string): string => {
		const lines = logSpy.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? "")));
		const line = lines.find(candidate => candidate.includes(`${settingPath} =`));
		expect(line).toBeDefined();
		return String(line);
	};

	const listJson = async (logSpy: LogSpy): Promise<Record<string, ListJsonEntry>> => {
		logSpy.mockClear();
		await runConfigCommand({ action: "list", flags: { json: true } });
		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		return JSON.parse(String(payload)) as Record<string, ListJsonEntry>;
	};

	it("classifies exactly the four secret-bearing paths as credentials", () => {
		// Per-setting, not per-prefix: `searxng.token` is a secret while its
		// sibling `searxng.basicUsername` and `searxng.endpoint` are not.
		const expected: Record<string, boolean> = {
			"auth.broker.token": true,
			"searxng.token": true,
			"searxng.basicPassword": true,
			"dev.autoqaPush.token": true,
			"auth.broker.url": false,
			"searxng.endpoint": false,
			"searxng.basicUsername": false,
			"dev.autoqaPush.endpoint": false,
			defaultThinkingLevel: false,
		};

		const actual: Record<string, boolean> = {};
		for (const settingPath of Object.keys(expected)) {
			actual[settingPath] = isCredential(settingPath as SettingPath);
		}

		expect(actual).toEqual(expected);
	});

	it("masks every configured credential in human list output and leaks no secret", async () => {
		const secrets: Record<string, string> = {
			"auth.broker.token": "brk-secret-aaaa",
			"searxng.token": "sxg-secret-bbbb",
			"searxng.basicPassword": "sxg-secret-cccc",
			"dev.autoqaPush.token": "qa-secret-dddd",
		};
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		for (const [key, value] of Object.entries(secrets)) {
			await runConfigCommand({ action: "set", key, value, flags: { json: true } });
		}
		// A non-credential neighbour proves redaction is targeted, not blanket.
		await runConfigCommand({
			action: "set",
			key: "searxng.basicUsername",
			value: "search-user",
			flags: { json: true },
		});

		logSpy.mockClear();
		await runConfigCommand({ action: "list", flags: {} });

		const dump = logSpy.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? ""))).join("\n");
		for (const [key, value] of Object.entries(secrets)) {
			expect(dump).not.toContain(value);
			expect(lineFor(logSpy, key)).toContain(REDACTED);
		}
		expect(lineFor(logSpy, "searxng.basicUsername")).toContain("search-user");
	});

	it("omits the value and flags redacted for a configured credential in JSON list output", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({
			action: "set",
			key: "auth.broker.token",
			value: "brk-secret-eeee",
			flags: { json: true },
		});
		await runConfigCommand({
			action: "set",
			key: "auth.broker.url",
			value: "https://broker.example",
			flags: { json: true },
		});

		const result = await listJson(logSpy);

		const token = result["auth.broker.token"];
		expect(token.redacted).toBe(true);
		// No stand-in value at all: a placeholder is indistinguishable from a real
		// secret and a consumer could write it back as the credential.
		expect("value" in token).toBe(false);
		expect(JSON.stringify(result)).not.toContain("brk-secret-eeee");
		expect(JSON.stringify(result)).not.toContain(REDACTED);

		expect(result["auth.broker.url"]).toMatchObject({ value: "https://broker.example" });
		expect(result["auth.broker.url"].redacted).toBeUndefined();
	});

	it("does not report an unset credential as redacted", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await listJson(logSpy);

		// A fresh install must not look like it has a token configured.
		for (const key of ["auth.broker.token", "searxng.token", "searxng.basicPassword", "dev.autoqaPush.token"]) {
			expect(result[key].redacted).toBeUndefined();
		}

		logSpy.mockClear();
		await runConfigCommand({ action: "list", flags: {} });
		expect(lineFor(logSpy, "auth.broker.token")).toContain("(not set)");
		expect(lineFor(logSpy, "auth.broker.token")).not.toContain(REDACTED);
	});

	it("does not report a cleared credential as redacted", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({ action: "set", key: "auth.broker.token", value: "", flags: { json: true } });

		const result = await listJson(logSpy);

		// Survives the JSON round-trip as "", so this distinguishes "cleared" from
		// "redacted" rather than relying on an absent key.
		expect(result["auth.broker.token"].value).toBe("");
		expect(result["auth.broker.token"].redacted).toBeUndefined();

		logSpy.mockClear();
		await runConfigCommand({ action: "list", flags: {} });
		expect(lineFor(logSpy, "auth.broker.token")).not.toContain(REDACTED);
	});

	it("still prints the real credential for an explicit config get", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({ action: "set", key: "searxng.token", value: "sxg-secret-ffff", flags: { json: true } });

		logSpy.mockClear();
		await runConfigCommand({ action: "get", key: "searxng.token", flags: {} });
		expect(Bun.stripANSI(String(logSpy.mock.calls.at(-1)?.[0] ?? ""))).toBe("sxg-secret-ffff");

		logSpy.mockClear();
		await runConfigCommand({ action: "get", key: "searxng.token", flags: { json: true } });
		const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as GetJsonPayload;
		expect(payload).toMatchObject({ key: "searxng.token", value: "sxg-secret-ffff" });
	});
});
