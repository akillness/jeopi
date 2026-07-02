#!/usr/bin/env bun
/**
 * Mirror the latest N released `packages/coding-agent/CHANGELOG.md` entries into a
 * marked region of the root README.
 *
 * Single source of truth: `packages/coding-agent/CHANGELOG.md` (this repo keeps
 * per-package changelogs — see AGENTS.md — coding-agent is the primary package,
 * so it is what the README digest mirrors). The README only displays a compact,
 * auto-generated digest between the START/END markers — never hand-edit that
 * block; run `bun run gen:readme-changelog` (CI enforces parity via
 * scripts/sync-readme-changelog.test.ts).
 *
 * Usage:
 *   bun scripts/sync-readme-changelog.ts             # rewrite + write
 *   bun scripts/sync-readme-changelog.ts --check     # exit 1 if README would change
 */
import * as path from "node:path";
import { parseChangelog, type ReleaseSection, resolveRepoRoot } from "./fix-changelogs";

export const CHANGELOG_START =
	"<!-- CHANGELOG:START (auto-generated from packages/coding-agent/CHANGELOG.md — run `bun run gen:readme-changelog`) -->";
export const CHANGELOG_END = "<!-- CHANGELOG:END -->";
export const CHANGELOG_COUNT = 5;
export const SOURCE_CHANGELOG = "packages/coding-agent/CHANGELOG.md";

/** Subsection priority for picking the digest's one-line summary per release. */
const SUBSECTION_PRIORITY = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"] as const;

const MAX_SUMMARY_LENGTH = 200;

export interface ChangelogDigestEntry {
	version: string;
	date?: string;
	summary: string;
}

/** Trim a changelog bullet to a single-line, link-free summary capped at `maxLength`. */
export function summarizeItem(text: string, maxLength: number = MAX_SUMMARY_LENGTH): string {
	// Strip markdown links but keep their visible text: "fixed X ([#123](url))" -> "fixed X (#123)".
	const linkless = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	const singleLine = linkless.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) return singleLine;
	const truncated = singleLine.slice(0, maxLength);
	const lastSpace = truncated.lastIndexOf(" ");
	return `${(lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trimEnd()}…`;
}

/** First bullet of the highest-priority non-empty subsection, or "" if the release has none. */
function pickSummary(section: ReleaseSection): string {
	for (const title of SUBSECTION_PRIORITY) {
		const subsection = section.subsections.find(s => s.title === title);
		const firstItemLine = subsection?.lines.find(line => line.text.trimStart().startsWith("- "));
		if (firstItemLine) {
			return summarizeItem(firstItemLine.text.trim().replace(/^-\s*/, ""));
		}
	}
	return "";
}

/** Parse released (non-"Unreleased") version entries, newest-first as written in the changelog. */
export function parseChangelogDigestEntries(content: string): ChangelogDigestEntry[] {
	const { sections } = parseChangelog(content);
	const entries: ChangelogDigestEntry[] = [];
	for (const section of sections) {
		if (section.title === "Unreleased") continue;
		const dateMatch = section.heading.match(/^##\s+\[[^\]]+\]\s*-\s*(\S+)/);
		entries.push({ version: section.title, date: dateMatch?.[1], summary: pickSummary(section) });
	}
	return entries;
}

/** Render the compact digest block (markers included) for the latest `count` entries. */
export function renderChangelogDigestBlock(entries: ChangelogDigestEntry[], count: number = CHANGELOG_COUNT): string {
	const top = entries.slice(0, count);
	const items = top.map(e => {
		const when = e.date ? ` (${e.date})` : "";
		const sum = e.summary ? ` — ${e.summary}` : "";
		return `- **[${e.version}]**${when}${sum}`;
	});
	const tail = `\nSee [${SOURCE_CHANGELOG}](${SOURCE_CHANGELOG}) for the full history.`;
	return [CHANGELOG_START, ...items, tail, CHANGELOG_END].join("\n");
}

/** Replace the marked region in the README body. Throws if the markers are missing. */
export function injectChangelogDigestBlock(readme: string, block: string): string {
	const start = readme.indexOf(CHANGELOG_START);
	const end = readme.indexOf(CHANGELOG_END);
	if (start === -1 || end === -1 || end < start) {
		throw new Error(`changelog digest markers not found in README (expected ${CHANGELOG_START} … ${CHANGELOG_END})`);
	}
	const before = readme.slice(0, start);
	const after = readme.slice(end + CHANGELOG_END.length);
	return before + block + after;
}

async function main(): Promise<void> {
	const checkOnly = process.argv.includes("--check");
	const repoRoot = await resolveRepoRoot(undefined);
	const changelogPath = path.join(repoRoot, SOURCE_CHANGELOG);
	const readmePath = path.join(repoRoot, "README.md");

	const changelog = await Bun.file(changelogPath).text();
	const readme = await Bun.file(readmePath).text();

	const block = renderChangelogDigestBlock(parseChangelogDigestEntries(changelog));
	const next = injectChangelogDigestBlock(readme, block);

	if (next === readme) {
		console.log("README changelog digest already up to date.");
		return;
	}

	if (checkOnly) {
		console.error("README changelog digest is stale — run `bun run gen:readme-changelog`.");
		process.exitCode = 1;
		return;
	}

	await Bun.write(readmePath, next);
	console.log("synced changelog digest → README.md");
}

if (import.meta.main) {
	await main();
}
