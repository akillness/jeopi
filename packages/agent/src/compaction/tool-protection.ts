import type { ToolResultMessage } from "jeopi-ai";
import type { AgentToolCall } from "../types";
import type { SessionEntry } from "./entries";

export interface ProtectedToolContext {
	readonly toolResult: ToolResultMessage;
	readonly toolCall: AgentToolCall | undefined;
}

export type ProtectedToolMatcher = string | ((context: ProtectedToolContext) => boolean);

const SKILL_INTERNAL_URL_PREFIX = "skill://";

export function collectToolCallsById(entries: readonly SessionEntry[]): Map<string, AgentToolCall> {
	const toolCalls = new Map<string, AgentToolCall>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") toolCalls.set(block.id, block);
		}
	}
	return toolCalls;
}

/**
 * Map each toolCall id to the stopReason of its paired assistant message.
 * Used so error/aborted turns never have their tool results silently stripped.
 */
export function collectAssistantStopReasonsByToolCallId(entries: readonly SessionEntry[]): Map<string, string> {
	const stopReasons = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") {
				stopReasons.set(block.id, message.stopReason);
			}
		}
	}
	return stopReasons;
}

const TASK_ABORTED_OR_FAILED_TAG_RE = /<task-result\b[^>]*\bstatus="(?:cancelled|failed\b[^"]*|merge failed)"/;

/** True when a tool result represents an aborted or failed task execution. */
export function isAbortedOrFailedTaskResult(toolResult: ToolResultMessage): boolean {
	const details = toolResult.details as Record<string, unknown> | undefined;
	if (details && typeof details === "object") {
		if (details.aborted === true) return true;
		if (Array.isArray(details.results)) {
			for (const item of details.results) {
				if (!item || typeof item !== "object") continue;
				const record = item as Record<string, unknown>;
				if (
					record.aborted === true ||
					(typeof record.exitCode === "number" && record.exitCode !== 0) ||
					(typeof record.error === "string" && record.error.trim().length > 0)
				) {
					return true;
				}
			}
		}
	}
	if (toolResult.toolName === "task") {
		for (const block of toolResult.content) {
			if (block.type === "text" && TASK_ABORTED_OR_FAILED_TAG_RE.test(block.text)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * True when a tool result MUST never be shaken, pruned, or reduced:
 * errors, aborted/failed task results, paired error/aborted turns, or
 * mixed/non-text results (e.g. images).
 */
export function isPreservedToolResult(toolResult: ToolResultMessage, pairedStopReason?: string): boolean {
	if (toolResult.isError === true) return true;
	if (pairedStopReason === "error" || pairedStopReason === "aborted") return true;
	if (isAbortedOrFailedTaskResult(toolResult)) return true;
	if (toolResult.content.some(block => block.type !== "text")) return true;
	return false;
}
/**
 * Extract the `path` argument from a paired `read` tool call, when the result
 * is a `read` result carrying a string path. Returns `undefined` otherwise.
 * Shared primitive for read-targeted protection matchers (skills, plans, …).
 */
export function getReadToolPath({ toolResult, toolCall }: ProtectedToolContext): string | undefined {
	if (toolResult.toolName !== "read" || toolCall?.name !== "read") return undefined;
	const path = (toolCall.arguments as Record<string, unknown>).path;
	return typeof path === "string" ? path : undefined;
}

export function isSkillReadToolResult(context: ProtectedToolContext): boolean {
	return getReadToolPath(context)?.startsWith(SKILL_INTERNAL_URL_PREFIX) ?? false;
}

export function isProtectedToolResult(
	toolResult: ToolResultMessage,
	toolCall: AgentToolCall | undefined,
	matchers: readonly ProtectedToolMatcher[],
): boolean {
	for (const matcher of matchers) {
		if (typeof matcher === "string") {
			if (toolResult.toolName === matcher) return true;
			continue;
		}
		if (matcher({ toolResult, toolCall })) return true;
	}
	return false;
}
