import { describe, expect, it } from "bun:test";
import {
	CHANGELOG_END,
	CHANGELOG_START,
	injectChangelogDigestBlock,
	parseChangelogDigestEntries,
	renderChangelogDigestBlock,
	summarizeItem,
} from "./sync-readme-changelog";

describe("parseChangelogDigestEntries", () => {
	it("skips the Unreleased section and extracts version + date from released headings", () => {
		const changelog = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- Should never appear in the digest.",
			"",
			"## [2.1.0] - 2026-05-01",
			"",
			"### Fixed",
			"",
			"- Fixed a real bug.",
		].join("\n");

		const entries = parseChangelogDigestEntries(changelog);

		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({ version: "2.1.0", date: "2026-05-01", summary: "Fixed a real bug." });
	});

	it("picks the summary from the highest-priority non-empty subsection", () => {
		const changelog = [
			"# Changelog",
			"",
			"## [1.0.0] - 2026-01-01",
			"",
			"### Changed",
			"",
			"- A changed item.",
			"",
			"### Breaking Changes",
			"",
			"- A breaking change should win over Changed.",
		].join("\n");

		const entries = parseChangelogDigestEntries(changelog);

		expect(entries[0]?.summary).toBe("A breaking change should win over Changed.");
	});

	it("returns an empty summary for a release with no subsection bullets", () => {
		const changelog = ["# Changelog", "", "## [0.1.0] - 2026-01-01", "", "Just prose, no list items."].join("\n");

		const entries = parseChangelogDigestEntries(changelog);

		expect(entries[0]).toEqual({ version: "0.1.0", date: "2026-01-01", summary: "" });
	});
});

describe("summarizeItem", () => {
	it("strips markdown links while keeping their visible text", () => {
		expect(summarizeItem("Fixed the thing. ([#123](https://example.com/123))")).toBe("Fixed the thing. (#123)");
	});

	it("collapses newlines and repeated whitespace into single spaces", () => {
		expect(summarizeItem("Fixed\n  the   thing\nacross lines.")).toBe("Fixed the thing across lines.");
	});

	it("truncates at a word boundary with an ellipsis when over the length cap", () => {
		const long = `${"a".repeat(20)} ${"b".repeat(20)} ${"c".repeat(20)}`;
		const result = summarizeItem(long, 30);

		expect(result.length).toBeLessThanOrEqual(31); // 30 + ellipsis char
		expect(result.endsWith("…")).toBe(true);
		expect(result).not.toContain(" …"); // no trailing space before the ellipsis
	});

	it("leaves text under the length cap unchanged", () => {
		expect(summarizeItem("short text", 200)).toBe("short text");
	});
});

describe("renderChangelogDigestBlock", () => {
	it("formats each entry as a version-bolded bullet with date and summary", () => {
		const block = renderChangelogDigestBlock([
			{ version: "1.0.0", date: "2026-01-01", summary: "Did a thing." },
			{ version: "0.9.0", summary: "" },
		]);

		expect(block).toContain("- **[1.0.0]** (2026-01-01) — Did a thing.");
		expect(block).toContain("- **[0.9.0]**");
		expect(block).not.toContain("[0.9.0]** () —");
	});

	it("respects the count limit, keeping only the newest N entries in input order", () => {
		const entries = Array.from({ length: 10 }, (_, i) => ({ version: `${i}.0.0`, summary: "" }));

		const block = renderChangelogDigestBlock(entries, 3);

		expect(block).toContain("[0.0.0]");
		expect(block).toContain("[2.0.0]");
		expect(block).not.toContain("[3.0.0]");
	});

	it("wraps output in the START/END markers", () => {
		const block = renderChangelogDigestBlock([{ version: "1.0.0", summary: "x" }]);

		expect(block.startsWith(CHANGELOG_START)).toBe(true);
		expect(block.endsWith(CHANGELOG_END)).toBe(true);
	});
});

describe("injectChangelogDigestBlock", () => {
	it("replaces exactly the marked region, preserving surrounding content", () => {
		const readme = ["# README", "", CHANGELOG_START, "- stale entry", CHANGELOG_END, "", "## Next section"].join(
			"\n",
		);
		const newBlock = [CHANGELOG_START, "- fresh entry", CHANGELOG_END].join("\n");

		const result = injectChangelogDigestBlock(readme, newBlock);

		expect(result).toContain("- fresh entry");
		expect(result).not.toContain("stale entry");
		expect(result).toContain("# README");
		expect(result).toContain("## Next section");
	});

	it("throws when the markers are missing from the README", () => {
		expect(() => injectChangelogDigestBlock("# README with no markers", "block")).toThrow(
			/changelog digest markers not found/,
		);
	});

	it("is idempotent: injecting the same block twice produces the same result", () => {
		const readme = ["# README", CHANGELOG_START, "- old", CHANGELOG_END].join("\n");
		const block = [CHANGELOG_START, "- new", CHANGELOG_END].join("\n");

		const once = injectChangelogDigestBlock(readme, block);
		const twice = injectChangelogDigestBlock(once, block);

		expect(twice).toBe(once);
	});
});
