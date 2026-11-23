import type { AgentMessage } from "jeopi-agent-core";
import { logger } from "jeopi-utils";

const PROTECTED_CUSTOM_TYPES: ReadonlySet<string> = new Set(["tool-call-loop-redirect", "tool-call-cycle-redirect"]);

function isCoreConversationMessage(message: AgentMessage): boolean {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function getMessageTimestamp(message: AgentMessage): number | undefined {
	const ts = (message as { timestamp?: unknown }).timestamp;
	return typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? ts : undefined;
}

function isProtectedCustomMessage(message: AgentMessage): boolean {
	if (message.role !== "custom") return false;
	const customType = (message as { customType?: unknown }).customType;
	return typeof customType === "string" && PROTECTED_CUSTOM_TYPES.has(customType);
}

function getTrailingActiveToolCallIds(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") break;
		if (msg.role === "toolResult") {
			const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
			if (typeof toolCallId === "string" && toolCallId.length > 0) {
				ids.add(toolCallId);
			}
		}
	}
	return ids;
}

function findLastCoreMessage(messages: readonly AgentMessage[]): AgentMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isCoreConversationMessage(messages[i])) {
			return messages[i];
		}
	}
	return undefined;
}

export interface ContextHookValidationResult {
	messages: AgentMessage[];
	rejectedReason?: string;
}

/**
 * Guard against buggy or stale-caching extension/hook `context` handlers that
 * truncate the active turn, drop trailing tool results, or erase loop-guard
 * redirect warnings (which otherwise blind the model into infinite retry loops).
 */
export function guardContextHookMessages(
	inputMessages: AgentMessage[],
	candidate: unknown,
	source: string,
): ContextHookValidationResult {
	if (!Array.isArray(candidate)) {
		logger.warn("Ignoring context hook result: expected message array", { source });
		return { messages: inputMessages, rejectedReason: "non_array" };
	}

	const outputMessages = candidate as AgentMessage[];
	if (inputMessages.length === 0) {
		return { messages: outputMessages };
	}

	if (outputMessages.length === 0) {
		logger.warn("Ignoring context hook result that emptied non-empty conversation", {
			source,
			inputCount: inputMessages.length,
		});
		return { messages: inputMessages, rejectedReason: "emptied_context" };
	}

	// 1. Trailing tool results for the active tool batch must stay paired.
	const activeToolCallIds = getTrailingActiveToolCallIds(inputMessages);
	if (activeToolCallIds.size > 0) {
		const presentIds = new Set<string>();
		for (const msg of outputMessages) {
			if (msg.role === "toolResult") {
				const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
				if (typeof toolCallId === "string" && toolCallId.length > 0) {
					presentIds.add(toolCallId);
				}
			}
		}
		for (const requiredId of activeToolCallIds) {
			if (!presentIds.has(requiredId)) {
				logger.warn("Ignoring context hook result that dropped active tool results", {
					source,
					inputCount: inputMessages.length,
					outputCount: outputMessages.length,
					missingToolCallId: requiredId,
				});
				return { messages: inputMessages, rejectedReason: "dropped_active_tool_results" };
			}
		}
	}

	// 2. Protected loop-redirect messages cannot be erased by context hooks.
	let inputProtectedCount = 0;
	for (const msg of inputMessages) {
		if (isProtectedCustomMessage(msg)) inputProtectedCount++;
	}
	if (inputProtectedCount > 0) {
		let outputProtectedCount = 0;
		for (const msg of outputMessages) {
			if (isProtectedCustomMessage(msg)) outputProtectedCount++;
		}
		if (outputProtectedCount < inputProtectedCount) {
			logger.warn("Ignoring context hook result that dropped protected loop-redirect messages", {
				source,
				inputProtectedCount,
				outputProtectedCount,
			});
			return { messages: inputMessages, rejectedReason: "dropped_loop_redirect" };
		}
	}

	// 3. Active tail monotonicity (catches stale cached message arrays from earlier turns).
	const inputLastCore = findLastCoreMessage(inputMessages);
	if (inputLastCore) {
		const outputLastCore = findLastCoreMessage(outputMessages);
		if (!outputLastCore) {
			logger.warn("Ignoring context hook result that dropped all conversation messages", {
				source,
				inputCount: inputMessages.length,
				outputCount: outputMessages.length,
			});
			return { messages: inputMessages, rejectedReason: "dropped_core_messages" };
		}

		const inputTs = getMessageTimestamp(inputLastCore);
		const outputTs = getMessageTimestamp(outputLastCore);
		if (inputTs !== undefined && outputTs !== undefined && outputTs < inputTs) {
			logger.warn("Ignoring stale context hook result whose newest message predates active turn", {
				source,
				inputCount: inputMessages.length,
				outputCount: outputMessages.length,
				inputTs,
				outputTs,
			});
			return { messages: inputMessages, rejectedReason: "stale_truncated_tail" };
		}

		if (inputLastCore.role === "user" && outputLastCore.role !== "user") {
			logger.warn("Ignoring context hook result that dropped trailing user turn", {
				source,
				inputCount: inputMessages.length,
				outputCount: outputMessages.length,
			});
			return { messages: inputMessages, rejectedReason: "dropped_trailing_user" };
		}
	}

	return { messages: outputMessages };
}
