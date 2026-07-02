/**
 * Regression test: `config migrate-legacy` must decide whether `~/.omp` needs
 * migrating BEFORE any other config-CLI action's side effects can create
 * `~/.jeopi` first.
 *
 * `runConfigCommand` used to call `Settings.init()` unconditionally before its
 * action switch. `Settings.init()` opens `AgentStorage` (agent.db), which
 * `mkdir`s the agent directory as a side effect — so by the time the
 * `migrate-legacy` case ran, `~/.jeopi` already existed and
 * `hasUnmigratedLegacyConfigDir()` always reported "nothing to migrate",
 * permanently stranding the user's real `~/.omp` auth/sessions/settings.
 * `migrate-legacy` (and `init-xdg`) now short-circuit before `Settings.init()`.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runConfigCommand } from "jeopi-cli/cli/config-cli";
import { resetSettingsForTest } from "jeopi-cli/config/settings";
import { AgentStorage } from "jeopi-cli/session/agent-storage";
import { LEGACY_CONFIG_DIR_NAME, refreshDirsFromEnv } from "jeopi-utils";
import { TempDir } from "jeopi-utils/temp";

describe("config migrate-legacy CLI action", () => {
	let tempHome: TempDir;
	let legacyDir: string;
	let currentDir: string;
	let originalPiConfigDir: string | undefined;

	beforeEach(() => {
		tempHome = TempDir.createSync("@pi-config-cli-migrate-");
		legacyDir = path.join(tempHome.path(), LEGACY_CONFIG_DIR_NAME);
		currentDir = path.join(tempHome.path(), ".jeopi");
		originalPiConfigDir = process.env.PI_CONFIG_DIR;
		delete process.env.PI_CONFIG_DIR;
		spyOn(os, "homedir").mockReturnValue(tempHome.path());
		// `dirs.ts`'s DirResolver singleton is built once at module load and
		// cached; mocking os.homedir() alone doesn't move it. Force a rebuild so
		// getAgentDir() (and therefore Settings.init()'s AgentStorage.open())
		// actually resolves under the mocked home, the same way the real
		// `Settings.init()`-before-migration-check bug manifested in production.
		refreshDirsFromEnv();
		fs.mkdirSync(path.join(legacyDir, "agent"), { recursive: true });
		fs.writeFileSync(path.join(legacyDir, "agent", "settings.json"), '{"theme":"regression-marker"}');
	});

	afterEach(() => {
		AgentStorage.resetInstance();
		resetSettingsForTest();
		spyOn(os, "homedir").mockRestore();
		if (originalPiConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalPiConfigDir;
		}
		refreshDirsFromEnv();
		tempHome.removeSync();
	});

	it("migrates ~/.omp to ~/.jeopi without any other action creating ~/.jeopi first", async () => {
		await runConfigCommand({ action: "migrate-legacy", flags: {} });

		expect(fs.existsSync(legacyDir)).toBe(false);
		expect(fs.readFileSync(path.join(currentDir, "agent", "settings.json"), "utf-8")).toBe(
			'{"theme":"regression-marker"}',
		);
	});
});
