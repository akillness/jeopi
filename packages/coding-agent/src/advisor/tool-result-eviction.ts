import type { AgentMessage } from "jeopi-agent-core";
import { estimateTokens } from "jeopi-agent-core";
import type { ToolResultMessage } from "jeopi-ai";

/** Minimum token size before a stale advisor tool result is worth evicting. */
const MIN_EVICT_TOKENS = 50;

/** Recent advisor messages kept intact so active investigation stays in context. */
const DEFAULT_KEEP_RECENT_MESSAGES = 6;

const EVICTED_PLACEHOLDER = "[Tool result evicted to preserve advisor context; re-read if needed.]";

/**
 * Evict bulky old tool results from an advisor's own message history while
 * keeping recent turns and already-evicted / tiny results untouched.
 *
 * Returns `{ messages, evictedCount, savedTokens }`. When `evictedCount === 0`,
 * the original `messages` array reference is returned unchanged so callers can
 * skip cache invalidation.
 */
export function evictStaleToolResults(
	messages: readonly AgentMessage[],
	keepRecentMessages: number = DEFAULT_KEEP_RECENT_MESSAGES,
): { messages: AgentMessage[]; evictedCount: number; savedTokens: number } {
	const cutoff = Math.max(0, messages.length - Math.max(0, keepRecentMessages));
	if (cutoff === 0) {
		return { messages: messages as AgentMessage[], evictedCount: 0, savedTokens: 0 };
	}

	let evictedCount = 0;
	let savedTokens = 0;
	let out: AgentMessage[] | undefined;

	for (let i = 0; i < cutoff; i++) {
		const msg = messages[i]!;
		if (msg.role !== "toolResult") {
			out?.push(msg);
			continue;
		}
		const tr = msg as ToolResultMessage;
		if (tr.prunedAt !== undefined || tr.useless === true) {
			out?.push(msg);
			continue;
		}
		const beforeTokens = estimateTokens(tr);
		if (beforeTokens < MIN_EVICT_TOKENS) {
			out?.push(msg);
			continue;
		}
		const evicted: ToolResultMessage = {
			...tr,
			content: [{ type: "text", text: EVICTED_PLACEHOLDER }],
			prunedAt: Date.now(),
		};
		const afterTokens = estimateTokens(evicted);
		if (afterTokens >= beforeTokens) {
			out?.push(msg);
			continue;
		}
		out ??= messages.slice(0, i);
		out.push(evicted);
		evictedCount++;
		savedTokens += beforeTokens - afterTokens;
	}

	if (!out) {
		return { messages: messages as AgentMessage[], evictedCount: 0, savedTokens: 0 };
	}
	for (let i = cutoff; i < messages.length; i++) {
		out.push(messages[i]!);
	}
	return { messages: out, evictedCount, savedTokens };
}
