/**
 * Tests for the `.omp` -> `.jeopi` config-directory rename's migration contract:
 * `hasUnmigratedLegacyConfigDir()` (detection) and `migrateLegacyConfigDir()`
 * (the actual move). Both are explicit/opt-in — never called automatically
 * from module load or DirResolver construction — so these tests exercise them
 * directly rather than through normal CLI startup.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	hasUnmigratedLegacyConfigDir,
	LEGACY_CONFIG_DIR_NAME,
	migrateLegacyConfigDir,
} from "jeopi-utils/dirs";
import { TempDir } from "jeopi-utils/temp";

describe("legacy config directory migration", () => {
	let tempHome: TempDir;
	let legacyDir = "";
	let currentDir = "";
	let originalPiConfigDir: string | undefined;

	beforeEach(() => {
		tempHome = TempDir.createSync("@pi-legacy-migration-");
		legacyDir = path.join(tempHome.path(), LEGACY_CONFIG_DIR_NAME);
		currentDir = path.join(tempHome.path(), CONFIG_DIR_NAME);
		originalPiConfigDir = process.env.PI_CONFIG_DIR;
		delete process.env.PI_CONFIG_DIR;
		spyOn(os, "homedir").mockReturnValue(tempHome.path());
	});

	afterEach(() => {
		spyOn(os, "homedir").mockRestore();
		if (originalPiConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalPiConfigDir;
		}
		tempHome.removeSync();
	});

	it("reports names correctly (sanity: renamed default, legacy preserved for detection)", () => {
		expect(CONFIG_DIR_NAME).toBe(".jeopi");
		expect(LEGACY_CONFIG_DIR_NAME).toBe(".omp");
	});

	it("detects an unmigrated legacy directory when only .omp exists", () => {
		fs.mkdirSync(path.join(legacyDir, "agent"), { recursive: true });
		expect(hasUnmigratedLegacyConfigDir()).toBe(true);
	});

	it("reports nothing to migrate when neither directory exists", () => {
		expect(hasUnmigratedLegacyConfigDir()).toBe(false);
	});

	it("reports nothing to migrate when .jeopi already exists (regardless of .omp)", () => {
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.mkdirSync(currentDir, { recursive: true });
		expect(hasUnmigratedLegacyConfigDir()).toBe(false);
	});

	it("reports nothing to migrate when PI_CONFIG_DIR overrides the default", () => {
		fs.mkdirSync(legacyDir, { recursive: true });
		process.env.PI_CONFIG_DIR = ".custom-config";
		expect(hasUnmigratedLegacyConfigDir()).toBe(false);
	});

	it("moves the entire legacy directory tree in place, preserving contents", () => {
		fs.mkdirSync(path.join(legacyDir, "agent", "profiles", "work"), { recursive: true });
		fs.writeFileSync(path.join(legacyDir, "agent", "settings.json"), '{"theme":"marker"}');
		fs.writeFileSync(path.join(legacyDir, "install-id"), "abc-123");

		const { from, to } = migrateLegacyConfigDir();

		expect(from).toBe(legacyDir);
		expect(to).toBe(currentDir);
		expect(fs.existsSync(legacyDir)).toBe(false);
		expect(fs.readFileSync(path.join(currentDir, "agent", "settings.json"), "utf-8")).toBe('{"theme":"marker"}');
		expect(fs.readFileSync(path.join(currentDir, "install-id"), "utf-8")).toBe("abc-123");
		expect(fs.existsSync(path.join(currentDir, "agent", "profiles", "work"))).toBe(true);
	});

	it("throws and leaves both directories untouched when the target already exists", () => {
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(path.join(legacyDir, "marker.txt"), "legacy");
		fs.mkdirSync(currentDir, { recursive: true });
		fs.writeFileSync(path.join(currentDir, "marker.txt"), "current");

		expect(() => migrateLegacyConfigDir()).toThrow(/Refusing to overwrite/);
		expect(fs.readFileSync(path.join(legacyDir, "marker.txt"), "utf-8")).toBe("legacy");
		expect(fs.readFileSync(path.join(currentDir, "marker.txt"), "utf-8")).toBe("current");
	});

	it("throws when there is no legacy directory to migrate", () => {
		expect(() => migrateLegacyConfigDir()).toThrow(/No legacy config directory found/);
	});

	it("throws when PI_CONFIG_DIR is set, even if .omp exists", () => {
		fs.mkdirSync(legacyDir, { recursive: true });
		process.env.PI_CONFIG_DIR = ".custom-config";
		expect(() => migrateLegacyConfigDir()).toThrow(/PI_CONFIG_DIR is set/);
		expect(fs.existsSync(legacyDir)).toBe(true);
	});
});
