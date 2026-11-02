import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasUnreleasedContent } from "./release";

// Contract: the release changelog gate refuses to cut a release when no
// package has content under `## [Unreleased]` — a false positive here ships a
// GitHub Release with an empty body (v16.2.22), a false negative blocks a
// legitimate release.
describe("release changelog gate", () => {
	it("detects entries under [Unreleased] followed by a released section", () => {
		const content = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- a fix\n\n## [1.0.0] - 2026-01-01\n";
		expect(hasUnreleasedContent(content)).toBe(true);
	});

	it("treats an empty [Unreleased] section before a released section as no content", () => {
		const content = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- released fix\n";
		expect(hasUnreleasedContent(content)).toBe(false);
	});

	it("treats a whitespace-only [Unreleased] section at end of file as no content", () => {
		expect(hasUnreleasedContent("# Changelog\n\n## [Unreleased]\n\n   \n")).toBe(false);
	});

	it("treats a changelog without an [Unreleased] section as no content", () => {
		expect(hasUnreleasedContent("# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- released fix\n")).toBe(
			false,
		);
	});
});

describe("release Bun version gate", () => {
	function runRelease(pinnedVersion: string) {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "release-test-"));
		try {
			const packageJson = JSON.stringify({ packageManager: `bun@${pinnedVersion}` });
			fs.writeFileSync(path.join(cwd, "package.json"), packageJson);
			fs.writeFileSync(path.join(cwd, "bun.lock"), "unchanged lockfile\n");
			fs.mkdirSync(path.join(cwd, "packages", "example"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, "packages", "example", "package.json"),
				'{"name": "example", "version": "1.0.0"}\n',
			);
			fs.writeFileSync(
				path.join(cwd, "git"),
				'#!/bin/sh\ncase "$*" in\n  *branch*) echo jeopi ;;\n  *status*) ;;\n  *describe*) echo v1.0.0 ;;\n  *) exit 1 ;;\nesac\n',
				{ mode: 0o755 },
			);
			const result = Bun.spawnSync(
				[process.execPath, path.join(import.meta.dir, "release.ts"), "patch", "--allow-empty"],
				{
					cwd,
					env: { ...process.env, PATH: `${cwd}:${process.env.PATH}` },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			return {
				exitCode: result.exitCode,
				output: result.stdout.toString() + result.stderr.toString(),
				packageJson: fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
				lockfile: fs.readFileSync(path.join(cwd, "bun.lock"), "utf8"),
				packageVersion: fs.readFileSync(path.join(cwd, "packages", "example", "package.json"), "utf8"),
			};
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}

	it("rejects a mismatched runtime before changing release files", () => {
		const expected = Bun.version === "0.0.0" ? "0.0.1" : "0.0.0";
		const result = runRelease(expected);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain(expected);
		expect(result.output).toContain(Bun.version);
		expect(result.packageJson).toBe(JSON.stringify({ packageManager: `bun@${expected}` }));
		expect(result.lockfile).toBe("unchanged lockfile\n");
		expect(result.packageVersion).toBe('{"name": "example", "version": "1.0.0"}\n');
	});

	it("continues to release preflight with the pinned runtime", () => {
		const result = runRelease(Bun.version);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("Updating package versions to 1.0.1");
		expect(result.packageVersion).toBe('{"name": "example", "version": "1.0.1"}\n');
	});
});
