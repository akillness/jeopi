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
	test("redirects once while results advance, then pauses a sustained unchanged single-call loop", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		const observe = (n: number, text: string) =>
			guard.recordTurn(turn(String(n), "bash", { command: "git status" }, text))?.kind;
		const prefix = "x".repeat(250);
		for (let i = 1; i <= 8; i++) expect(observe(i, `${prefix}${i}`)).toBe(i === 3 ? "repeated_tool_call" : undefined);
		expect(observe(9, `${prefix}8`)).toBeUndefined();
		expect(observe(10, `${prefix}8`)).toBe("stalled_tool_call");
	});

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
	test("detects repeated eval calls with list vs string syntax for status commands", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		const turn1 = turn("c1", "eval", {
			language: "python",
			code: 'subprocess.run(["git", "status", "--short"], capture_output=True)\nsubprocess.run(["bun", "run", "typecheck"])',
		});
		const turn2 = turn("c2", "eval", {
			language: "python",
			code: 'sh("git status --short")\nsh("bun run typecheck")',
		});
		const turn3 = turn("c3", "eval", {
			language: "python",
			code: 'st = subprocess.run(["git", "status"])\ntc = subprocess.run(["bun", "typecheck"])',
		});

		expect(guard.recordTurn(turn1)).toBeNull();
		expect(guard.recordTurn(turn2)).toBeNull();
		const detection = guard.recordTurn(turn3);
		expect(detection).not.toBeNull();
		expect(detection?.kind).toBe("repeated_tool_call");
		if (detection?.kind === "repeated_tool_call") {
			expect(detection.toolName).toBe("eval");
			expect(detection.count).toBe(3);
		}
	});

	test("detects repeated bash calls with jev status and pipe/redirect noise", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		const turn1 = turn("c1", "bash", {
			command: "node ~/.agents/jev/jev-harness.mjs --profile default status 2>&1 | head -c 600",
		});
		const turn2 = turn("c2", "bash", {
			command: "node ~/.agents/jev/jev-harness.mjs --profile default status | tail -n 20",
		});
		const turn3 = turn("c3", "bash", {
			command: "node ~/.agents/jev/jev-harness.mjs --profile default status",
		});

		expect(guard.recordTurn(turn1)).toBeNull();
		expect(guard.recordTurn(turn2)).toBeNull();
		const detection = guard.recordTurn(turn3);
		expect(detection).not.toBeNull();
		expect(detection?.kind).toBe("repeated_tool_call");
		if (detection?.kind === "repeated_tool_call") {
			expect(detection.toolName).toBe("bash");
			expect(detection.count).toBe(3);
		}
	});

	test("allows progressive read paging but detects re-reading same file/offset", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		// Progressive reads: not a loop
		expect(guard.recordTurn(turn("c1", "read", { filePath: "src/app.ts", lineRange: "1-50" }, "first"))).toBeNull();
		expect(
			guard.recordTurn(turn("c2", "read", { filePath: "src/app.ts", lineRange: "51-100" }, "second")),
		).toBeNull();
		expect(
			guard.recordTurn(turn("c3", "read", { filePath: "src/app.ts", lineRange: "101-150" }, "third")),
		).toBeNull();

		// Reading the same page with slightly different requests is still a loop.
		const guard2 = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		expect(guard2.recordTurn(turn("c1", "read", { filePath: "src/app.ts", lineRange: "1-50" }))).toBeNull();
		expect(guard2.recordTurn(turn("c2", "read", { filePath: "src/app.ts", lineRange: "1-50" }))).toBeNull();
		const detection = guard2.recordTurn(turn("c3", "read", { filePath: "src/app.ts", lineRange: "1-100" }));
		expect(detection?.kind).toBe("repeated_tool_call");
	});

	test("detects repeated pages immediately after advancing to them", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		expect(guard.recordTurn(turn("first", "read", { path: "src/app.ts:1-50" }, "first page"))).toBeNull();
		expect(guard.recordTurn(turn("second", "read", { path: "src/app.ts:51-100" }))).toBeNull();
		expect(guard.recordTurn(turn("third", "read", { filePath: "src/app.ts", offset: 51 }))).toBeNull();
		expect(guard.recordTurn(turn("fourth", "read", { filePath: "src/app.ts", lineRange: "51-120" }))).toMatchObject({
			kind: "repeated_tool_call",
			toolName: "read",
			count: 3,
		});
	});

	test("detects the same read output despite changing the requested start line", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		for (const [index, offset] of [1, 51, 101].entries()) {
			const detection = guard.recordTurn(
				turn(`read-${index}`, "read", { path: "src/app.ts", offset }, "first page"),
			);
			if (index < 2) expect(detection).toBeNull();
			else expect(detection).toMatchObject({ kind: "repeated_tool_call", toolName: "read", count: 3 });
		}
	});

	test("does not flag changed read output or identical output from a different file", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		const sharedPrefix = "unchanged header\n".repeat(20);
		expect(guard.recordTurn(turn("first", "read", { path: "a.ts:1-10" }, `${sharedPrefix}old`))).toBeNull();
		expect(guard.recordTurn(turn("expanded", "read", { path: "a.ts:1-20" }, `${sharedPrefix}new`))).toBeNull();
		expect(guard.recordTurn(turn("other", "read", { path: "b.ts:1-20" }, `${sharedPrefix}new`))).toBeNull();
	});
});
