import type { AgentMessage } from "jeopi-agent-core";

/**
 * Compute a content-only fingerprint for an `AgentMessage` so retries of an
 * identical turn can recognize already-persisted or already-delivered messages
 * regardless of `timestamp` differences.
 */
export function fingerprintMessage(message: AgentMessage): string {
	const json = JSON.stringify(message, (key, value) => (key === "timestamp" ? undefined : value));
	return Bun.hash.wyhash(json ?? "").toString(16);
}
