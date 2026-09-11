#!/usr/bin/env bun

/**
 * Checks spoofed external tool versions against their latest releases.
 *
 * We impersonate several external tools (Gemini CLI, Claude Code + Claude Agent
 * SDK) via User-Agent / billing-header strings. When these tools release new
 * versions, the upstream service may start rejecting or deprioritizing older
 * versions — Anthropic gates new models on `cc_version` outright ("Claude Code
 * 2.1.165 does not support this model; version 2.1.251 or newer is required").
 * This script detects drift so we can bump before users hit 400s/403s/429s.
 *
 * `--update` only rewrites the version literals. The Claude Code fingerprint
 * also pins the `@anthropic-ai/sdk` build (`claudeCodeSdkVersion`) and the Bun
 * runtime version bundled by that release; re-check those against the release
 * binary when the CLI version moves.
 *
 * Usage:
 *   bun scripts/check-spoofed-versions.ts          # check and report
 *   bun scripts/check-spoofed-versions.ts --update  # update source in-place
 */

import * as path from "node:path";

const GEMINI_HEADERS_FILE = path.join(import.meta.dir, "../packages/catalog/src/wire/gemini-headers.ts");
const ANTHROPIC_PROVIDER_FILE = path.join(import.meta.dir, "../packages/ai/src/providers/anthropic.ts");

interface VersionCheck {
	/** Human label for the report. */
	name: string;
	/** Source file holding the hardcoded version. */
	file: string;
	/** Regex to extract the current hardcoded version from `file`. */
	sourcePattern: RegExp;
	/** Resolves the latest published version. */
	fetchLatest: () => Promise<string | null>;
}

const SEMVER_RE = /(\d+\.\d+\.\d+)/;
const FETCH_HEADERS = { "User-Agent": "jeopi/version-check" } as const;

/** Fetch latest non-prerelease tag from a GitHub repo. */
async function fetchLatestGitHubRelease(repo: string): Promise<string | null> {
	try {
		// /releases/latest only returns non-prerelease, non-draft releases
		const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: { ...FETCH_HEADERS, Accept: "application/vnd.github+json" },
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { tag_name?: string };
		return data.tag_name ? (SEMVER_RE.exec(data.tag_name)?.[1] ?? null) : null;
	} catch {
		return null;
	}
}

/** Fetch the `latest` dist-tag of an npm package. */
async function fetchLatestNpmVersion(pkg: string): Promise<string | null> {
	try {
		const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { headers: FETCH_HEADERS });
		if (!res.ok) return null;
		const data = (await res.json()) as { version?: string };
		return data.version ? (SEMVER_RE.exec(data.version)?.[1] ?? null) : null;
	} catch {
		return null;
	}
}

const checks: VersionCheck[] = [
	{
		name: "Gemini CLI",
		file: GEMINI_HEADERS_FILE,
		sourcePattern: /PI_AI_GEMINI_CLI_VERSION\s*\|\|\s*"(\d+\.\d+\.\d+)"/,
		fetchLatest: () => fetchLatestGitHubRelease("google-gemini/gemini-cli"),
	},
	{
		name: "Claude Code",
		file: ANTHROPIC_PROVIDER_FILE,
		sourcePattern: /claudeCodeVersion\s*=\s*"(\d+\.\d+\.\d+)"/,
		fetchLatest: () => fetchLatestGitHubRelease("anthropics/claude-code"),
	},
	{
		name: "Claude Agent SDK",
		file: ANTHROPIC_PROVIDER_FILE,
		sourcePattern: /claudeAgentSdkVersion\s*=\s*"(\d+\.\d+\.\d+)"/,
		fetchLatest: () => fetchLatestNpmVersion("@anthropic-ai/claude-agent-sdk"),
	},
];

async function run() {
	const doUpdate = process.argv.includes("--update");
	const sources = new Map<string, string>();
	const updatedFiles = new Set<string>();
	let anyDrift = false;
	let anyChecked = false;

	for (const check of checks) {
		let source = sources.get(check.file);
		if (source === undefined) {
			source = await Bun.file(check.file).text();
			sources.set(check.file, source);
		}

		const match = check.sourcePattern.exec(source);
		if (!match?.[1]) {
			console.error(`[WARN] Could not extract current ${check.name} version from source`);
			continue;
		}

		const current = match[1];
		const latest = await check.fetchLatest();

		if (!latest) {
			console.error(`[FAIL] Could not fetch latest ${check.name} version`);
			continue;
		}

		anyChecked = true;

		if (current === latest) {
			console.log(`[OK]   ${check.name}: ${current} (up to date)`);
		} else {
			console.log(`[DRIFT] ${check.name}: ${current} -> ${latest}`);
			anyDrift = true;

			if (doUpdate) {
				sources.set(check.file, source.replace(match[0], match[0].replace(current, latest)));
				updatedFiles.add(check.file);
				console.log(`       Updated in source.`);
			}
		}
	}

	for (const file of updatedFiles) {
		await Bun.write(file, sources.get(file) ?? "");
		console.log(`\nWrote updates to ${path.relative(process.cwd(), file)}`);
	}

	if (!anyChecked) {
		console.error("\nNo version checks succeeded. Cannot verify freshness.");
		process.exit(1);
	}

	if (anyDrift && !doUpdate) {
		console.log("\nRun with --update to apply version bumps.");
		process.exit(1);
	}
}

run();
