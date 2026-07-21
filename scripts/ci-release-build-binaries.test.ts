import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "..");

describe("Windows release binary target", () => {
	it("builds the generic Windows release asset with the baseline runtime", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		expect(output).toContain("Building packages/coding-agent/binaries/jeopi-windows-x64.exe...");
		expect(output).toContain("--target bun-windows-x64-baseline");
		expect(output).not.toContain("bun-windows-x64-modern");
	});
});
