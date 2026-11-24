import type { AssistantMessage, Message, ToolResultMessage } from "jeopi-ai";
import { isRecord } from "jeopi-utils";
import type { AgentMessage } from "./types";

/**
 * Neutral text substituted when replaying a synthetic tool_result whose
 * assistant turn failed with `stopReason === "error"`. The persisted message
 * retains the original provider error for session history and UI display;
 * replaying that raw error text to the next model call can poison classifiers
 * or trigger refusal cascades.
 */
export const PROVIDER_ERROR_NOT_EXECUTED_TEXT =
	"Tool call was not executed because the previous model response was interrupted by a provider error.";

/** Detects API-level provider refusals that are terminal errors, not dialogue to replay. */
export function isProviderRefusalMessage(message: AgentMessage): message is AssistantMessage {
	if (message.role !== "assistant" || message.stopReason !== "error") return false;
	const stopType = message.stopDetails?.type;
	return stopType === "refusal" || stopType === "sensitive";
}

/**
 * Whether `message` is a synthetic tool_result created because the assistant
 * turn terminated with `stopReason === "error"`.
 */
export function isProviderErrorPlaceholder(message: AgentMessage): message is ToolResultMessage {
	return (
		message.role === "toolResult" &&
		isRecord(message.details) &&
		message.details.__synthetic === true &&
		message.details.source === "assistant_stop_error"
	);
}

/**
 * Scrub synthetic `assistant_stop_error` tool_result text before replaying to a
 * model, leaving the persisted message object untouched.
 */
export function toProviderReplayMessage<T extends Message | AgentMessage>(message: T): T {
	if (!isProviderErrorPlaceholder(message as AgentMessage)) return message;
	return {
		...message,
		content: [{ type: "text", text: PROVIDER_ERROR_NOT_EXECUTED_TEXT }],
	};
}

/**
 * Filter and scrub messages for model replay while preserving the full
 * persisted transcript for UI/history.
 */
export function filterProviderReplayMessages<T extends Message | AgentMessage>(messages: readonly T[]): T[] {
	const out: T[] = [];
	for (const message of messages) {
		if (isProviderRefusalMessage(message as AgentMessage)) continue;
		out.push(toProviderReplayMessage(message));
	}
	return out;
}
