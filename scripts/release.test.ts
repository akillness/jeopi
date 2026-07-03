import { describe, expect, it } from "bun:test";
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
