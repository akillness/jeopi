/**
 * Process-global subagent spawn concurrency cap, shared across all `TaskTool`
 * instances and `eval` `agent()` bridge calls.
 *
 * Uses separate semaphores for top-level spawns (`depth <= 0`) and nested
 * spawns (`depth >= 1`) so a full cohort of depth-1 subagents waiting on
 * depth-2 children can never deadlock on the same pool.
 */

import { normalizeConcurrencyLimit, Semaphore } from "./parallel";

interface GlobalSemaphoreEntry {
	limit: number;
	semaphore: Semaphore;
}

const spawnSemaphores = new Map<"top" | "nested", GlobalSemaphoreEntry>();

function resolveBucketLimit(limit: number, bucket: "top" | "nested"): number {
	const normalized = normalizeConcurrencyLimit(limit);
	if (normalized <= 0) return 0; // 0 = unlimited in Semaphore
	if (bucket === "top") return normalized;
	return Math.max(2, Math.floor(normalized / 2));
}

export function getGlobalSpawnSemaphore(limit: number, depth = 0): Semaphore {
	const bucket: "top" | "nested" = depth >= 1 ? "nested" : "top";
	const resolved = resolveBucketLimit(limit, bucket);
	const existing = spawnSemaphores.get(bucket);
	if (existing) {
		if (existing.limit !== resolved) {
			existing.limit = resolved;
			existing.semaphore.resize(resolved);
		}
		return existing.semaphore;
	}
	const semaphore = new Semaphore(resolved);
	spawnSemaphores.set(bucket, { limit: resolved, semaphore });
	return semaphore;
}

export function resetGlobalSpawnSemaphoresForTests(): void {
	spawnSemaphores.clear();
}
