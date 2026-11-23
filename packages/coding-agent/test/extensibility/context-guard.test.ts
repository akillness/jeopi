import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "jeopi-agent-core";
import { guardContextHookMessages } from "jeopi-cli/extensibility/context-guard";

function userMsg(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function assistantToolCall(id: string, name: string, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: {} }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResultMsg(toolCallId: string, toolName: string, text: string, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function customMsg(customType: string, content: string, timestamp: number): AgentMessage {
	return {
		role: "custom",
		customType,
		content,
		display: false,
		timestamp,
	};
}

describe("guardContextHookMessages", () => {
	it("accepts valid filtering/pruning of older non-protected custom messages", () => {
		const input: AgentMessage[] = [
			userMsg("start", 100),
			customMsg("jev-injected-skill", "old skill context", 101),
			assistantToolCall("tc-1", "read", 110),
			toolResultMsg("tc-1", "read", "contents", 120),
		];
		const pruned = [input[0]!, input[2]!, input[3]!];
		const result = guardContextHookMessages(input, pruned, "test-ext");
		expect(result.rejectedReason).toBeUndefined();
		expect(result.messages).toEqual(pruned);
	});

	it("rejects non-array and emptied outputs", () => {
		const input: AgentMessage[] = [userMsg("hello", 100)];
		expect(guardContextHookMessages(input, "bad", "test-ext")).toEqual({
			messages: input,
			rejectedReason: "non_array",
		});
		expect(guardContextHookMessages(input, [], "test-ext")).toEqual({
			messages: input,
			rejectedReason: "emptied_context",
		});
	});

	it("rejects stale cached outputs that drop active-turn trailing tool results", () => {
		const staleCache: AgentMessage[] = [
			userMsg("fix the bug", 100),
			assistantToolCall("tc-1", "bash", 110),
			toolResultMsg("tc-1", "bash", "ok", 120),
		];
		const currentInput: AgentMessage[] = [
			...staleCache,
			assistantToolCall("tc-2", "bash", 130),
			toolResultMsg("tc-2", "bash", "fresh output", 140),
		];
		const result = guardContextHookMessages(currentInput, staleCache, "stale-cache-ext");
		expect(result.rejectedReason).toBe("dropped_active_tool_results");
		expect(result.messages).toBe(currentInput);
	});

	it("rejects outputs that erase tool-call-loop-redirect or tool-call-cycle-redirect messages", () => {
		const redirect = customMsg("tool-call-loop-redirect", "<tool_call_loop_detected/>", 150);
		const input: AgentMessage[] = [
			userMsg("run", 100),
			assistantToolCall("tc-1", "bash", 110),
			toolResultMsg("tc-1", "bash", "same", 120),
			redirect,
		];
		const withoutRedirect = input.slice(0, 3);
		const result = guardContextHookMessages(input, withoutRedirect, "redirect-stripper");
		expect(result.rejectedReason).toBe("dropped_loop_redirect");
		expect(result.messages).toBe(input);
	});

	it("rejects stale outputs whose latest core message timestamp is older than input", () => {
		const input: AgentMessage[] = [userMsg("first", 100), userMsg("second", 200)];
		const stale: AgentMessage[] = [userMsg("first", 100)];
		const result = guardContextHookMessages(input, stale, "stale-ts");
		expect(result.rejectedReason).toBe("stale_truncated_tail");
		expect(result.messages).toBe(input);
	});

	it("rejects outputs that drop the trailing user message", () => {
		const input: AgentMessage[] = [
			userMsg("first", 100),
			assistantToolCall("tc-1", "read", 100),
			toolResultMsg("tc-1", "read", "ok", 100),
			userMsg("follow-up", 100),
		];
		const droppedUser = input.slice(0, 3);
		const result = guardContextHookMessages(input, droppedUser, "user-dropper");
		expect(result.rejectedReason).toBe("dropped_trailing_user");
		expect(result.messages).toBe(input);
	});

	it("rejects context hooks that shrink trailing active toolResult text below 50% when original exceeds 400 chars", () => {
		const longOutput = "line of live tool output\n".repeat(30); // 750 chars (> 400)
		const input: AgentMessage[] = [
			userMsg("inspect file", 100),
			assistantToolCall("tc-1", "read", 110),
			toolResultMsg("tc-1", "read", longOutput, 120),
		];
		const shrunkCandidate: AgentMessage[] = [
			input[0]!,
			input[1]!,
			toolResultMsg("tc-1", "read", longOutput.slice(0, 200), 120),
		];

		const result = guardContextHookMessages(input, shrunkCandidate, "aggressive-compressor");
		expect(result.rejectedReason).toBe("compressed_active_tool_results");
		expect(result.messages).toBe(input);
	});

	it("rejects context hooks that inject compression markers into trailing active toolResults", () => {
		const original = "short but critical diagnostic output";
		const input: AgentMessage[] = [
			userMsg("run check", 100),
			assistantToolCall("tc-1", "bash", 110),
			toolResultMsg("tc-1", "bash", original, 120),
		];

		for (const marker of ["[head] ", "[signal] ", "[compressed"]) {
			const mutated: AgentMessage[] = [
				input[0]!,
				input[1]!,
				toolResultMsg("tc-1", "bash", `${marker}${original}`, 120),
			];
			const result = guardContextHookMessages(input, mutated, "marker-injector");
			expect(result.rejectedReason).toBe("compressed_active_tool_results");
			expect(result.messages).toBe(input);
		}
	});

	it("does not false-positive when a compression marker already existed in the raw toolResult", () => {
		const originalWithMarker = "source line containing literal [compressed] and [head] tokens";
		const input: AgentMessage[] = [
			userMsg("read guard code", 100),
			assistantToolCall("tc-1", "read", 110),
			toolResultMsg("tc-1", "read", originalWithMarker, 120),
		];
		const cloned: AgentMessage[] = [input[0]!, input[1]!, toolResultMsg("tc-1", "read", originalWithMarker, 120)];

		const result = guardContextHookMessages(input, cloned, "passthrough-ext");
		expect(result.rejectedReason).toBeUndefined();
		expect(result.messages).toEqual(cloned);
	});

	it("protects every toolResult in a multi-tool trailing batch", () => {
		const longOutput = "payload-block-data\n".repeat(30); // 570 chars
		const input: AgentMessage[] = [
			userMsg("read two files", 100),
			assistantToolCall("tc-1", "read", 110),
			toolResultMsg("tc-1", "read", "ok small", 120),
			toolResultMsg("tc-2", "read", longOutput, 121),
		];
		const shrunkSecond: AgentMessage[] = [
			input[0]!,
			input[1]!,
			input[2]!,
			toolResultMsg("tc-2", "read", "summary", 121),
		];

		const result = guardContextHookMessages(input, shrunkSecond, "batch-compressor");
		expect(result.rejectedReason).toBe("compressed_active_tool_results");
		expect(result.messages).toBe(input);
	});

	it("allows summarizing or compressing historical non-trailing toolResult messages before the last assistant turn", () => {
		const historicalOutput = "old tool output line\n".repeat(40); // 840 chars
		const activeOutput = "current turn output line\n".repeat(30); // 750 chars
		const input: AgentMessage[] = [
			userMsg("step 1", 100),
			assistantToolCall("tc-old", "read", 110),
			toolResultMsg("tc-old", "read", historicalOutput, 120),
			assistantToolCall("tc-active", "bash", 130),
			toolResultMsg("tc-active", "bash", activeOutput, 140),
		];
		const compressedHistorical: AgentMessage[] = [
			input[0]!,
			input[1]!,
			toolResultMsg("tc-old", "read", "[compressed 840 chars -> 1 line summary]", 120),
			input[3]!,
			input[4]!,
		];

		const result = guardContextHookMessages(input, compressedHistorical, "history-compactor");
		expect(result.rejectedReason).toBeUndefined();
		expect(result.messages).toEqual(compressedHistorical);
	});
});
