import type { WritethroughCallback } from "../lsp";

/**
 * Non-isolated concurrent subagents (`task.isolation.mode="none"`, the
 * default) share the parent session's cwd with no other collision-avoidance
 * mechanism: two sibling subagents editing the same file can each perform an
 * unguarded read-modify-write, and the interleaving of their disk writes can
 * silently drop one of them. This wrapper does not prevent LOGICAL conflicts
 * (two agents making incompatible edits to the same file) — it only
 * serializes the physical writethrough call per destination path, so one
 * write can no longer be lost mid-flight to another write racing the same
 * path.
 */

/** Per-path write chains serializing the writethrough callback for a given destination. */
const pathWriteChains = new Map<string, Promise<unknown>>();

/**
 * Wrap a {@link WritethroughCallback} so concurrent writes to the same `dst`
 * are serialized instead of racing. `dst` is used as-is for the chain key:
 * every caller (edit's hashline/patch/replace paths, and the write tool)
 * resolves `dst` to an absolute path via `resolvePlanPath`/`resolveToCwd`
 * before invoking the writethrough, so the same logical file always arrives
 * under the same string.
 */
export function withPathWriteLock(callback: WritethroughCallback): WritethroughCallback {
	return async (dst, content, signal, file, batch, getDeferred) => {
		// Serialize the writethrough per path: parallel edits to the same file
		// (sibling subagents sharing a cwd, or two shared tool calls in one
		// turn) would otherwise let concurrent disk writes race and drop one.
		const run = (pathWriteChains.get(dst) ?? Promise.resolve()).then(() =>
			callback(dst, content, signal, file, batch, getDeferred),
		);
		const guarded = run.catch(() => {});
		pathWriteChains.set(dst, guarded);
		try {
			return await run;
		} finally {
			// Drop the entry once this write is the chain tail, so the map does
			// not retain one promise per distinct path for the process lifetime.
			if (pathWriteChains.get(dst) === guarded) pathWriteChains.delete(dst);
		}
	};
}
