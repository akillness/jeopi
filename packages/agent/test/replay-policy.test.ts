import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "jeopi-ai";
import {
	filterProviderReplayMessages,
	isProviderErrorPlaceholder,
	PROVIDER_ERROR_NOT_EXECUTED_TEXT,
	toProviderReplayMessage,
} from "../src/replay-policy";

function refusalAssistantMsg(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "text" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		stopDetails: { type: "refusal" },
		timestamp: Date.now(),
	};
}

describe("replay-policy guards", () => {
	it("drops safety refusals and scrubs assistant_stop_error placeholder text without mutating persisted details", () => {
		const refusal = refusalAssistantMsg();
		const stopErrorResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "bash",
			content: [{ type: "text", text: "Tool execution failed due to an error: HTTP 500 internal refusal trigger" }],
			details: {
				__synthetic: true,
				source: "assistant_stop_error",
				executed: false,
				upstreamError: "HTTP 500 internal refusal trigger",
			},
			isError: true,
			timestamp: Date.now(),
		};
		const abortedResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "bash",
			content: [{ type: "text", text: "Tool execution was aborted." }],
			details: { __synthetic: true, source: "assistant_stop_aborted", executed: false },
			isError: true,
			timestamp: Date.now(),
		};

		expect(isProviderErrorPlaceholder(stopErrorResult)).toBe(true);
		expect(isProviderErrorPlaceholder(abortedResult)).toBe(false);

		const scrubbed = toProviderReplayMessage(stopErrorResult);
		expect(scrubbed.content).toEqual([{ type: "text", text: PROVIDER_ERROR_NOT_EXECUTED_TEXT }]);
		expect(scrubbed.details).toEqual(stopErrorResult.details);
		expect(stopErrorResult.content[0]).toEqual({
			type: "text",
			text: "Tool execution failed due to an error: HTTP 500 internal refusal trigger",
		});

		const filtered = filterProviderReplayMessages([refusal, stopErrorResult, abortedResult]);
		expect(filtered).toHaveLength(2);
		expect(filtered[0]?.role).toBe("toolResult");
		expect((filtered[0] as ToolResultMessage).content).toEqual([
			{ type: "text", text: PROVIDER_ERROR_NOT_EXECUTED_TEXT },
		]);
		expect(filtered[1]).toBe(abortedResult);
	});
});
