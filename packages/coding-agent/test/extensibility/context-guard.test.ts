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
});
