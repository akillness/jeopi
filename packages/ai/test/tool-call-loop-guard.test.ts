import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "jeopi-ai";
import { ToolCallLoopGuard } from "jeopi-ai/utils/tool-call-loop-guard";
import { INTENT_FIELD } from "jeopi-wire";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

function turn(id: string, name: string, args: Record<string, unknown>, resultText = "ok") {
	return {
		message: {
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, id, name, arguments: args }],
			api: "openai-responses" as const,
			provider: "openai",
			model: "test-model",
			usage: zeroUsage,
			stopReason: "toolUse" as const,
			timestamp: Date.now(),
		},
		toolResults: [
			{
				role: "toolResult" as const,
				toolCallId: id,
				toolName: name,
				content: [{ type: "text" as const, text: resultText }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	};
}

describe("ToolCallLoopGuard", () => {
	test("detects the fifth consecutive identical tool call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: ["job", "irc"] });
		let detection = null;
		for (let index = 0; index < 5; index++) {
			const toolCallId = `call-${index}`;
			detection = guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pytest -q", timeout: 120 } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId,
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			});
		}

		expect(detection).toEqual({
			kind: "repeated_tool_call",
			toolName: "bash",
			count: 5,
			resultSummary: "1263 passed, 4 skipped",
			argumentsSummary: '{"command":"pytest -q","timeout":120}',
		});
	});

	test("canonicalizes argument key order and ignores harness intent fields", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "first", name: "read", arguments: { path: "a.ts", [INTENT_FIELD]: "first" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "second",
							name: "read",
							arguments: { [INTENT_FIELD]: "second", path: "a.ts" },
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toMatchObject({ toolName: "read", count: 2 });
	});

	test("resets the consecutive count on a different call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "first", name: "bash", arguments: { command: "pytest -q" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "second", name: "read", arguments: { path: "src/index.ts" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "third", name: "bash", arguments: { command: "pytest -q" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "third",
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});

	test("ignores exempt polling tools", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["job"] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "first", name: "job", arguments: { poll: ["abc"] } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "job",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "second", name: "job", arguments: { poll: ["abc"] } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "job",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});
});

describe("ToolCallLoopGuard cyclical detection", () => {
	test("detects an A,B,A,B,… alternating pattern across the cycle window", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], cycleWindowSize: 6 });
		let detection = null;
		for (let index = 0; index < 6; index++) {
			const isA = index % 2 === 0;
			detection = guard.recordTurn(
				isA
					? turn(`call-${index}`, "grep", { pattern: "TODO" })
					: turn(`call-${index}`, "read", { path: "src/index.ts" }),
			);
		}
		expect(detection).toEqual({
			kind: "cyclical_tool_calls",
			toolNames: ["grep", "read"],
			windowSize: 6,
		});
	});

	test("does not re-fire on the following turn while the same A/B pair keeps alternating", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], cycleWindowSize: 6 });
		const detections: Array<unknown> = [];
		for (let index = 0; index < 8; index++) {
			const isA = index % 2 === 0;
			detections.push(
				guard.recordTurn(
					isA
						? turn(`call-${index}`, "grep", { pattern: "TODO" })
						: turn(`call-${index}`, "read", { path: "src/index.ts" }),
				),
			);
		}
		const fired = detections.filter(detection => detection !== null);
		expect(fired).toHaveLength(1);
		expect(fired[0]).toMatchObject({ kind: "cyclical_tool_calls" });
	});

	test("fires again after the alternating pair changes to a different pair", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [], cycleWindowSize: 4 });
		const detections: Array<unknown> = [];
		for (let index = 0; index < 4; index++) {
			const isA = index % 2 === 0;
			detections.push(
				guard.recordTurn(
					isA
						? turn(`call-${index}`, "grep", { pattern: "TODO" })
						: turn(`call-${index}`, "read", { path: "src/index.ts" }),
				),
			);
		}
		for (let index = 4; index < 8; index++) {
			const isA = index % 2 === 0;
			detections.push(
				guard.recordTurn(
					isA
						? turn(`call-${index}`, "grep", { pattern: "FIXME" })
						: turn(`call-${index}`, "glob", { pattern: "*.ts" }),
				),
			);
		}
		const fired = detections.filter((detection): detection is { kind: string } => detection !== null);
		expect(fired).toHaveLength(2);
		expect(fired.every(detection => detection.kind === "cyclical_tool_calls")).toBe(true);
	});

	test("does not treat a pure single-tool repeat as a cycle (already covered by repeated_tool_call)", () => {
		const guard = new ToolCallLoopGuard({ threshold: 100, exemptTools: [], cycleWindowSize: 6 });
		let detection = null;
		for (let index = 0; index < 6; index++) {
			detection = guard.recordTurn(turn(`call-${index}`, "bash", { command: "pytest -q" }));
		}
		expect(detection).toBeNull();
	});

	test("does not flag three-or-more distinct tools rotating through the window", () => {
		const guard = new ToolCallLoopGuard({ threshold: 100, exemptTools: [], cycleWindowSize: 6 });
		const calls: Array<[string, Record<string, unknown>]> = [
			["read", { path: "a.ts" }],
			["grep", { pattern: "TODO" }],
			["glob", { pattern: "*.ts" }],
		];
		let detection = null;
		for (let index = 0; index < 6; index++) {
			const [name, args] = calls[index % calls.length]!;
			detection = guard.recordTurn(turn(`call-${index}`, name, args));
		}
		expect(detection).toBeNull();
	});
});
