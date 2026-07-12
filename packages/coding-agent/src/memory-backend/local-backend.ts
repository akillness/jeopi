import * as path from "node:path";
import { isEnoent } from "jeopi-utils";
import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	clearMemoryToolDeveloperInstructionsCache,
	enqueueMemoryConsolidation,
	getMemoryRoot,
	LEARNED_LESSONS_FILE,
	saveLearnedLesson,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend } from "./types";

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 *
 * The rollout-summarisation pipeline (rollouts → SQLite → memory_summary.md) is
 * delegated unchanged. On top of it, `save()` persists `learn`-tool lessons to
 * `learned.md` (so `status()` reports `writable: true`); structured search is
 * still unavailable.
 */
export const localBackend: MemoryBackend = {
	id: "local",
	start(options) {
		startMemoryStartupTask(options);
	},
	async buildDeveloperInstructions(agentDir, settings, session) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings, session);
	},
	async clear(agentDir, cwd, session) {
		clearMemoryToolDeveloperInstructionsCache(session);
		await clearMemoryData(agentDir, cwd);
	},
	async enqueue(agentDir, cwd) {
		enqueueMemoryConsolidation(agentDir, cwd);
	},
	async save(context, input) {
		return saveLearnedLesson(context.agentDir, context.cwd, input);
	},
	async status() {
		return {
			backend: "local" as const,
			active: true,
			writable: true,
			searchable: false,
			message:
				"Local rollout-summary memory is active; lessons from the `learn` tool are saved to learned.md. Structured search is not available.",
		};
	},
	async stats(agentDir, cwd) {
		const filePath = path.join(getMemoryRoot(agentDir, cwd), LEARNED_LESSONS_FILE);
		let raw = "";
		try {
			raw = await Bun.file(filePath).text();
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		let total = 0;
		let verified = 0;
		for (const rawLine of raw.split("\n")) {
			const line = rawLine.trim();
			if (!line.startsWith("- ")) continue;
			total++;
			if (line.startsWith(VERIFIED_PREFIX)) verified++;
		}
		const unverified = total - verified;
		const coverage = total > 0 ? `${((verified / total) * 100).toFixed(1)}%` : "N/A";
		return [
			"# Local Memory Stats",
			"",
			`- Lessons: ${total}`,
			`- Verified: ${verified}`,
			`- Unverified: ${unverified}`,
			`- Verification coverage: ${coverage}`,
		].join("\n");
	},
};

/** Line prefix `saveLearnedLesson` writes for verified/unverified lessons in `learned.md`. */
const VERIFIED_PREFIX = "- [VERIFIED]";
