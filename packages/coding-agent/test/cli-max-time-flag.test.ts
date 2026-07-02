import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "jeopi-cli/cli/args";
import { Settings } from "jeopi-cli/config/settings";
import { runRootCommand } from "jeopi-cli/main";
import type { CreateAgentSessionOptions } from "jeopi-cli/sdk";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { TempDir } from "jeopi-utils";

describe("parseArgs — --max-time flag", () => {
	it("parses --max-time seconds as maxTime", () => {
		const result = parseArgs(["--max-time", "3", "--print", "hello"]);

		expect(result.maxTime).toBe(3);
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hello"]);
	});

	it("converts maxTime to an absolute session deadline", async () => {
		using tempDir = TempDir.createSync("@omp-max-time-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		let observedOptions: CreateAgentSessionOptions | undefined;
		const parsed = parseArgs(["--max-time", "3", "--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		const beforeRun = Date.now();
		try {
			await runRootCommand(parsed, ["--max-time", "3", "--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") {
				throw error;
			}
		} finally {
			authStorage.close();
		}
		const afterRun = Date.now();

		expect(observedOptions?.deadline).toBeGreaterThanOrEqual(beforeRun + 3_000);
		expect(observedOptions?.deadline).toBeLessThanOrEqual(afterRun + 3_000);
	});
});
