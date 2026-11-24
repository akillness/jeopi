import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { Agent } from "jeopi-agent-core/agent";
import { agentLoop } from "jeopi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	SoftToolRequirement,
} from "jeopi-agent-core/types";
import {
	isGenuineUserMessage,
	StepBudget,
	toolTarget,
	type WorkflowGuardSoftWarning,
	type WorkflowGuardStop,
	WorkflowLoopGuard,
} from "jeopi-agent-core/workflow-guard";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions } from "jeopi-ai";
import { createMockModel } from "jeopi-ai/providers/mock";
import { AssistantMessageEventStream } from "jeopi-ai/utils/event-stream";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const pathSchema = type({ "path?": "string", "lineRange?": "string", "command?": "string" });
const emptySchema = type({});

describe("WorkflowLoopGuard and StepBudget", () => {
	it("extends on novel diverse successful targets and stops when cycling on the same coarse target", () => {
		const budget = new StepBudget({
			baseSteps: 4,
			extensionSteps: 4,
			maxExtensions: 5,
			hardCap: 20,
			windowSize: 4,
			minProgressRatio: 0.5,
			minDistinct: 2,
		});

		// Distinct files produce novel coarse targets and justify an extension.
		budget.record(
			'read:{"path":"a.ts","lineRange":"1-10"}',
			true,
			toolTarget("read", { path: "a.ts", lineRange: "1-10" }),
		);
		budget.record(
			'read:{"path":"b.ts","lineRange":"1-10"}',
			true,
			toolTarget("read", { path: "b.ts", lineRange: "1-10" }),
		);
		const ext1 = budget.tryExtend();
		expect(ext1.extend).toBe(true);
		expect(ext1.newLimit).toBe(8);
		expect(ext1.extensionsUsed).toBe(1);

		// Reading different line ranges of already-seen files has distinct signatures
		// but NO novel coarse target, so extension is refused.
		budget.record(
			'read:{"path":"a.ts","lineRange":"11-20"}',
			true,
			toolTarget("read", { path: "a.ts", lineRange: "11-20" }),
		);
		budget.record(
			'read:{"path":"b.ts","lineRange":"11-20"}',
			true,
			toolTarget("read", { path: "b.ts", lineRange: "11-20" }),
		);
		const ext2 = budget.tryExtend();
		expect(ext2.extend).toBe(false);
		expect(ext2.reason).toContain("no novel tool targets");
	});

	it("does not mask failing mutating tools behind a succeeding read-only tool in the same batch", () => {
		const guard = new WorkflowLoopGuard({ maxConsecutiveFailures: 2, maxSteps: 20 });

		const stop1 = guard.recordToolBatch(
			[
				{ name: "read", arguments: { path: "a.ts" } },
				{ name: "bash", arguments: { command: "bun test" } },
			],
			[
				{ toolName: "read", isError: false },
				{ toolName: "bash", isError: true },
			],
		);
		expect(stop1).toBeUndefined();
		expect(guard.consecutiveFailures).toBe(1);

		// A succeeding non-read-only tool resets consecutive failures.
		const stop2 = guard.recordToolBatch(
			[{ name: "edit", arguments: { path: "a.ts" } }],
			[{ toolName: "edit", isError: false }],
		);
		expect(stop2).toBeUndefined();
		expect(guard.consecutiveFailures).toBe(0);

		// Two consecutive failing batches trip the circuit breaker even with read successes.
		expect(
			guard.recordToolBatch(
				[
					{ name: "read", arguments: { path: "b.ts" } },
					{ name: "bash", arguments: { command: "bun test" } },
				],
				[
					{ toolName: "read", isError: false },
					{ toolName: "bash", isError: true },
				],
			),
		).toBeUndefined();
		const stop3 = guard.recordToolBatch(
			[
				{ name: "read", arguments: { path: "c.ts" } },
				{ name: "bash", arguments: { command: "bun test" } },
			],
			[
				{ toolName: "read", isError: false },
				{ toolName: "bash", isError: true },
			],
		);
		expect(stop3?.stopClass).toBe("consecutive_failure");
		expect(stop3?.consecutiveFailures).toBe(2);
	});

	it("distinguishes genuine user messages from agent/synthetic messages", () => {
		expect(isGenuineUserMessage(createUserMessage("real user"))).toBe(true);
		expect(isGenuineUserMessage({ role: "user", content: "synthetic", attribution: "agent", timestamp: 1 })).toBe(
			false,
		);
		expect(
			isGenuineUserMessage({ role: "developer", content: "auto continue", attribution: "agent", timestamp: 1 }),
		).toBe(false);
		expect(
			isGenuineUserMessage({
				role: "custom",
				customType: "skill",
				content: "run",
				display: true,
				attribution: "user",
				timestamp: 1,
			}),
		).toBe(true);
		expect(
			isGenuineUserMessage({
				role: "custom",
				customType: "reminder",
				content: "keep going",
				display: false,
				attribution: "agent",
				timestamp: 1,
			}),
		).toBe(false);
	});
});

describe("Agent and agentLoop bounded execution", () => {
	it("consumes prompt toolChoice one-shot instead of trapping subsequent turns in required tool calls", async () => {
		let pingCount = 0;
		const pingTool: AgentTool<typeof emptySchema, Record<string, never>> = {
			name: "ping",
			label: "Ping",
			description: "Ping tool",
			parameters: emptySchema,
			async execute() {
				pingCount++;
				return { content: [{ type: "text", text: "pong" }], details: {} };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "c1", name: "ping", arguments: {} }] },
				{ content: ["all done"] },
			],
		});
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["sys"],
				tools: [pingTool],
				messages: [],
			},
			convertToLlm: identityConverter,
			streamFn: mock.stream,
		});

		await agent.prompt("run ping once", { toolChoice: "required" });

		expect(pingCount).toBe(1);
		expect(mock.calls).toHaveLength(2);
		expect(mock.calls[0]?.options?.toolChoice).toBe("required");
		expect(mock.calls[1]?.options?.toolChoice).toBeUndefined();
	});

	it("stops a repetitive tool-call run when the rolling step budget refuses extension", async () => {
		const readTool: AgentTool<typeof pathSchema, Record<string, never>> = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: pathSchema,
			async execute(_id, params) {
				return { content: [{ type: "text", text: `content:${params.path}:${params.lineRange}` }], details: {} };
			},
		};
		const responses = Array.from({ length: 10 }, (_, i) => ({
			content: [
				{
					type: "toolCall" as const,
					id: `r${i}`,
					name: "read",
					arguments: { path: "same.ts", lineRange: `${i * 10 + 1}-${(i + 1) * 10}` },
				},
			],
		}));
		const mock = createMockModel({ responses });
		const stops: WorkflowGuardStop[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			workflowGuard: {
				stepBudget: { baseSteps: 3, extensionSteps: 3, maxExtensions: 5, hardCap: 20, windowSize: 3 },
			},
			onWorkflowGuardStop: stop => {
				stops.push(stop);
			},
		};
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [readTool] };

		const stream = agentLoop([createUserMessage("inspect")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		await stream.result();

		expect(stops).toHaveLength(1);
		expect(stops[0]?.stopClass).toBe("step_budget_stalled");
		// First 3 steps discover `same.ts` (1 novel target -> extends 3 -> 6); next 3 steps
		// have 0 novel targets -> extension refused at step 6 instead of running all 10 turns.
		expect(mock.calls).toHaveLength(6);
	});

	it("stops after consecutive failing non-trivial tool batches", async () => {
		const bashTool: AgentTool<typeof pathSchema, Record<string, never>> = {
			name: "bash",
			label: "Bash",
			description: "Run command",
			parameters: pathSchema,
			async execute() {
				throw new Error("command failed");
			},
		};
		const readTool: AgentTool<typeof pathSchema, Record<string, never>> = {
			name: "read",
			label: "Read",
			description: "Read file",
			parameters: pathSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const responses = Array.from({ length: 6 }, (_, i) => ({
			content: [
				{ type: "toolCall" as const, id: `rd${i}`, name: "read", arguments: { path: `f${i}.ts` } },
				{ type: "toolCall" as const, id: `sh${i}`, name: "bash", arguments: { command: `cmd ${i}` } },
			],
		}));
		const mock = createMockModel({ responses });
		const stops: WorkflowGuardStop[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			workflowGuard: { maxConsecutiveFailures: 2, maxSteps: 20 },
			onWorkflowGuardStop: stop => {
				stops.push(stop);
			},
		};
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [readTool, bashTool] };

		const stream = agentLoop([createUserMessage("fix")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		await stream.result();

		expect(stops).toHaveLength(1);
		expect(stops[0]?.stopClass).toBe("consecutive_failure");
		expect(mock.calls).toHaveLength(2);
	});

	it("caps non-user outer-loop continuations while allowing genuine user follow-ups", async () => {
		let followUpCalls = 0;
		const responses = Array.from({ length: 10 }, (_, i) => ({ content: [`turn ${i}`] }));
		const mock = createMockModel({ responses });
		const stops: WorkflowGuardStop[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			workflowGuard: { maxOuterCycles: 2 },
			onWorkflowGuardStop: stop => {
				stops.push(stop);
			},
			getFollowUpMessages: async () => {
				followUpCalls++;
				return [
					{
						role: "developer",
						content: [{ type: "text", text: `synthetic nudge ${followUpCalls}` }],
						attribution: "agent",
						timestamp: Date.now(),
					},
				];
			},
		};
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [] };

		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		await stream.result();

		expect(stops).toHaveLength(1);
		expect(stops[0]?.stopClass).toBe("outer_cycle_cap");
		// Initial turn + 2 allowed outer cycles = 3 model calls before the 3rd non-user follow-up stops.
		expect(mock.calls).toHaveLength(3);
	});

	it("bounds repeated length-truncated tool calls instead of resetting the continuation counter", async () => {
		const mock = createMockModel({
			responses: Array.from({ length: 15 }, (_, i) => ({
				stopReason: "length" as const,
				content: [{ type: "toolCall" as const, id: `trunc-${i}`, name: "missing_tool", arguments: {} }],
			})),
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			workflowGuard: false,
		};
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [] };

		const stream = agentLoop([createUserMessage("write huge file")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		await stream.result();

		// Initial truncated turn + MAX_LENGTH_TRUNCATE_CONTINUATIONS (8) = 9 model calls max.
		expect(mock.calls).toHaveLength(9);
	});

	it("caps total soft-tool escalations even when the requirement id alternates every turn", async () => {
		let callIndex = 0;
		const resolveTool: AgentTool<typeof emptySchema, Record<string, never>> = {
			name: "resolve",
			label: "Resolve",
			description: "Resolve action",
			parameters: emptySchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const peekTool: AgentTool<typeof emptySchema, Record<string, never>> = {
			name: "peek",
			label: "Peek",
			description: "Peek",
			parameters: emptySchema,
			async execute() {
				return { content: [{ type: "text", text: "peeked" }], details: {} };
			},
		};
		const mock = createMockModel({
			responses: Array.from({ length: 20 }, (_, i) => ({
				content: [{ type: "toolCall" as const, id: `p${i}`, name: "peek", arguments: {} }],
			})),
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			workflowGuard: false,
			getToolChoice: (): SoftToolRequirement => {
				callIndex++;
				return {
					soft: true,
					// Alternating IDs previously bypassed per-id softEscalations reset.
					id: `req-${callIndex}`,
					toolName: "resolve",
					reminder: [createUserMessage("call resolve")],
				};
			},
		};
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [resolveTool, peekTool] };

		let caught: unknown;
		try {
			const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
			for await (const _ of stream) {
				// drain
			}
			await stream.result();
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("Soft tool requirement 'resolve'");
		expect(mock.calls.length).toBeLessThanOrEqual(10);
	});

	it("aborts and reports stall_timeout when a stream stalls without progress", async () => {
		const mockModel = createMockModel().model;
		const stops: WorkflowGuardStop[] = [];
		const hangingStream = (model: Model, _context: Context, options?: SimpleStreamOptions) => {
			const s = new AssistantMessageEventStream();
			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			options?.signal?.addEventListener(
				"abort",
				() => {
					const aborted: AssistantMessage = { ...partial, stopReason: "aborted", errorMessage: "stalled" };
					s.push({ type: "error", reason: "aborted", error: aborted });
					s.end();
				},
				{ once: true },
			);
			return s;
		};

		const config: AgentLoopConfig = {
			model: mockModel,
			convertToLlm: identityConverter,
			workflowGuard: { stallTimeoutMs: 40 },
			onWorkflowGuardStop: stop => {
				stops.push(stop);
			},
		};
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [] };

		const stream = agentLoop([createUserMessage("hang")], context, config, undefined, hangingStream);
		for await (const _ of stream) {
			// drain
		}
		await stream.result();

		expect(stops).toHaveLength(1);
		expect(stops[0]?.stopClass).toBe("stall_timeout");
	});

	it("counts non-user stop-boundary steering against maxOuterCycles", async () => {
		const mock = createMockModel({
			responses: [
				{ content: ["turn 1"] },
				{ content: ["turn 2"] },
				{ content: ["turn 3"] },
				{ content: ["turn 4"] },
			],
		});
		const stops: WorkflowGuardStop[] = [];
		let steerCalls = 0;

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			workflowGuard: { maxOuterCycles: 2, maxSteps: 20 },
			onWorkflowGuardStop: stop => {
				stops.push(stop);
			},
			getSteeringMessages: async () => {
				steerCalls++;
				// First call is pre-turn initial steering check; return synthetic steering after each assistant turn.
				if (steerCalls === 1) return [];
				return [
					{
						role: "developer",
						content: [{ type: "text", text: `synthetic steer ${steerCalls}` }],
						attribution: "agent",
						timestamp: Date.now(),
					},
				];
			},
		};
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [] };
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		await stream.result();

		expect(stops).toHaveLength(1);
		expect(stops[0]?.stopClass).toBe("outer_cycle_cap");
		expect(mock.calls.length).toBe(3);
	});

	it("preserves already-dequeued genuine user follow-ups in context when step_hard_cap halts the run", async () => {
		const mock = createMockModel({
			responses: [{ content: ["done 1"] }, { content: ["should not run"] }],
		});
		const stops: WorkflowGuardStop[] = [];
		let delivered = false;

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			workflowGuard: {
				maxSteps: 1,
				stepBudget: { baseSteps: 1, extensionSteps: 1, maxExtensions: 0, hardCap: 1 },
			},
			onWorkflowGuardStop: stop => {
				stops.push(stop);
			},
			getFollowUpMessages: async () => {
				if (delivered) return [];
				delivered = true;
				return [createUserMessage("preserved follow-up")];
			},
		};
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [] };
		const stream = agentLoop([createUserMessage("initial")], context, config, undefined, mock.stream);
		const emittedMessages: AgentMessage[] = [];
		for await (const event of stream) {
			if (event.type === "message_end") {
				emittedMessages.push(event.message);
			}
		}
		const newMessages = await stream.result();

		expect(stops).toHaveLength(1);
		expect(stops[0]?.stopClass).toBe("step_hard_cap");
		expect(mock.calls.length).toBe(1);
		expect(
			newMessages.some(
				m => m.role === "user" && typeof m.content === "string" && m.content === "preserved follow-up",
			),
		).toBe(true);
		expect(
			emittedMessages.some(
				m => m.role === "user" && typeof m.content === "string" && m.content === "preserved follow-up",
			),
		).toBe(true);
	});

	it("resets stall timeout when streaming deltas arrive incrementally", async () => {
		const mockModel = createMockModel().model;
		const stops: WorkflowGuardStop[] = [];
		const slowStreamingStream = (model: Model) => {
			const s = new AssistantMessageEventStream();
			const partial: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			void (async () => {
				s.push({ type: "start", partial });
				for (const chunk of ["hel", "lo ", "wor", "ld"]) {
					await Bun.sleep(25);
					const prev = (partial.content[0] as { type: "text"; text: string }).text;
					partial.content[0] = { type: "text", text: prev + chunk };
					s.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial });
				}
				s.push({ type: "done", reason: "stop", message: partial });
				s.end();
			})();
			return s;
		};

		const config: AgentLoopConfig = {
			model: mockModel,
			convertToLlm: identityConverter,
			workflowGuard: { stallTimeoutMs: 65 },
			onWorkflowGuardStop: stop => {
				stops.push(stop);
			},
		};
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [] };
		const stream = agentLoop([createUserMessage("stream slowly")], context, config, undefined, slowStreamingStream);
		for await (const _ of stream) {
			// drain
		}
		await stream.result();

		expect(stops).toHaveLength(0);
	});
	it("emits one-shot soft warning and halts on per-run cost/output token budgets with toolCall pairing", async () => {
		const pingTool: AgentTool<typeof emptySchema, Record<string, never>> = {
			name: "ping",
			label: "Ping",
			description: "Ping tool",
			parameters: emptySchema,
			async execute() {
				return { content: [{ type: "text", text: "pong" }], details: {} };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall" as const, id: "t1", name: "ping", arguments: {} }],
					usage: {
						input: 100,
						output: 850,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 950,
						cost: { input: 0.01, output: 0.84, cacheRead: 0, cacheWrite: 0, total: 0.85 },
					},
				},
				{
					content: [{ type: "toolCall" as const, id: "t2", name: "ping", arguments: {} }],
					usage: {
						input: 100,
						output: 300,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 400,
						cost: { input: 0.01, output: 0.29, cacheRead: 0, cacheWrite: 0, total: 0.3 },
					},
				},
			],
		});
		const warnings: WorkflowGuardSoftWarning[] = [];
		const stops: WorkflowGuardStop[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			workflowGuard: { maxCostUsd: 1.0, softBudgetWarningRatio: 0.8 },
			onWorkflowGuardSoftWarning: warning => {
				warnings.push(warning);
			},
			onWorkflowGuardStop: stop => {
				stops.push(stop);
			},
		};
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [pingTool] };
		const stream = agentLoop([createUserMessage("budget test")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		const newMessages = await stream.result();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.kind).toBe("cost");
		expect(stops).toHaveLength(1);
		expect(stops[0]?.stopClass).toBe("cost_budget_exceeded");
		expect(stops[0]?.costUsd).toBeCloseTo(1.15, 4);
		// Second turn's tool call t2 must be paired with an aborted toolResult instead of executing.
		const pairedT2 = newMessages.find(m => m.role === "toolResult" && m.toolCallId === "t2");
		expect(pairedT2).toBeDefined();
		expect(pairedT2 && pairedT2.role === "toolResult" ? pairedT2.isError : false).toBe(true);
		// Soft warning synthetic message must have been injected before the second turn.
		expect(
			newMessages.some(
				m =>
					m.role === "user" &&
					typeof m.content === "string" &&
					m.content.includes("Approaching per-run cost budget"),
			),
		).toBe(true);
	});

	it("fires onWorkflowGuardSoftWarning on a terminal final answer without injecting a synthetic turn or extra LLM call", async () => {
		const mock = createMockModel({
			responses: [
				{
					content: ["Final answer."],
					usage: {
						input: 100,
						output: 850,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 950,
						cost: { input: 0.01, output: 0.84, cacheRead: 0, cacheWrite: 0, total: 0.85 },
					},
				},
				{ content: ["Spurious second turn that must never run."] },
			],
		});
		const warnings: WorkflowGuardSoftWarning[] = [];
		const stops: WorkflowGuardStop[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			workflowGuard: { maxCostUsd: 1.0, softBudgetWarningRatio: 0.8 },
			onWorkflowGuardSoftWarning: warning => {
				warnings.push(warning);
			},
			onWorkflowGuardStop: stop => {
				stops.push(stop);
			},
		};
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [] };

		const stream = agentLoop([createUserMessage("summarize")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		const newMessages = await stream.result();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.kind).toBe("cost");
		expect(stops).toHaveLength(0);
		expect(mock.calls).toHaveLength(1);
		expect(newMessages.map(m => m.role)).toEqual(["user", "assistant"]);
	});

	it("injects the soft-warning wrap-up prompt on the next turn when crossing the soft ratio on a tool-call turn", async () => {
		const pingTool: AgentTool<typeof emptySchema, Record<string, never>> = {
			name: "ping",
			label: "Ping",
			description: "Ping tool",
			parameters: emptySchema,
			async execute() {
				return { content: [{ type: "text", text: "pong" }], details: {} };
			},
		};
		const secondCallMessages: Message[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall" as const, id: "t1", name: "ping", arguments: {} }],
					usage: {
						input: 100,
						output: 850,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 950,
						cost: { input: 0.01, output: 0.84, cacheRead: 0, cacheWrite: 0, total: 0.85 },
					},
				},
				ctx => {
					secondCallMessages.push(...ctx.messages);
					return {
						content: ["Wrapped up concisely."],
						usage: {
							input: 100,
							output: 40,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 140,
							cost: { input: 0.01, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.05 },
						},
					};
				},
			],
		});
		const warnings: WorkflowGuardSoftWarning[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			workflowGuard: { maxCostUsd: 1.0, softBudgetWarningRatio: 0.8 },
			onWorkflowGuardSoftWarning: warning => {
				warnings.push(warning);
			},
		};
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [pingTool] };

		const stream = agentLoop([createUserMessage("run ping")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		await stream.result();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.kind).toBe("cost");
		expect(mock.calls).toHaveLength(2);
		expect(
			secondCallMessages.some(
				m =>
					m.role === "user" &&
					typeof m.content === "string" &&
					m.content.includes("Approaching per-run cost budget"),
			),
		).toBe(true);
	});
});

describe("WorkflowLoopGuard hardening contracts", () => {
	it("requires fresh novel targets after each StepBudget extension", () => {
		const budget = new StepBudget({
			baseSteps: 2,
			extensionSteps: 2,
			maxExtensions: 3,
			hardCap: 20,
			windowSize: 6,
			minProgressRatio: 0.5,
			minDistinct: 2,
		});
		budget.record("read:a", true, "read:a");
		budget.record("read:b", true, "read:b");
		const first = budget.tryExtend();
		expect(first.extend).toBe(true);
		expect(first.newLimit).toBe(4);

		// Re-reading already-seen targets with distinct signatures still yields 0 novel targets.
		budget.record("read:a:2", true, "read:a");
		budget.record("read:b:2", true, "read:b");
		const second = budget.tryExtend();
		expect(second.extend).toBe(false);
		expect(second.reason).toContain("no novel tool targets");

		// A fresh novel target re-enables extension.
		budget.record("read:c", true, "read:c");
		const third = budget.tryExtend();
		expect(third.extend).toBe(true);
		expect(third.newLimit).toBe(6);
	});

	it("classifies eval read vs mutating targets, detects identical read-only outcomes, and invalidates on mutation", () => {
		expect(
			toolTarget("eval", {
				language: "python",
				code: 'import subprocess\nprint(subprocess.check_output(["git", "status"]))',
			}),
		).toBe("eval:read:python:cmds:git status");
		expect(
			toolTarget("eval", {
				language: "python",
				code: 'open("src/app.ts", "w").write("x")',
				title: "rewrite app",
			}),
		).toBe("eval:exec:python:rewrite app");

		const guard = new WorkflowLoopGuard({
			maxSteps: 0,
			stepBudget: {
				baseSteps: 2,
				extensionSteps: 2,
				maxExtensions: 4,
				hardCap: 20,
				windowSize: 6,
				minProgressRatio: 0.5,
				minDistinct: 2,
			},
		});

		// First two read-only evals produce identical output (differing only by timestamp/duration).
		guard.beforeModelCall();
		guard.recordToolBatch(
			[{ name: "eval", arguments: { language: "python", code: 'print(open("src/a.ts").read())' } }],
			[{ toolName: "eval", isError: false, content: [{ type: "text", text: "2026-11-22T10:00:01Z ok 12ms" }] }],
		);
		guard.beforeModelCall();
		guard.recordToolBatch(
			[{ name: "eval", arguments: { language: "python", code: 'print(open("src/b.ts").read())' } }],
			[{ toolName: "eval", isError: false, content: [{ type: "text", text: "2026-11-22T10:00:05Z ok 18ms" }] }],
		);
		// Identical normalized output prevented novelty on the second call, so repeatCalls incremented.
		expect(guard.repeatCalls).toBe(1);

		// First extension succeeds because call 1 was novel; now consume it.
		expect(guard.beforeModelCall()).toBeUndefined();
		// Another read-only eval with identical output has no novel target -> next extension stalls.
		guard.recordToolBatch(
			[{ name: "eval", arguments: { language: "python", code: 'print(open("src/c.ts").read())' } }],
			[{ toolName: "eval", isError: false, content: [{ type: "text", text: "2026-11-22T10:00:09Z ok 22ms" }] }],
		);
		guard.beforeModelCall();
		const stalled = guard.beforeModelCall();
		expect(stalled?.stopClass).toBe("step_budget_stalled");

		// Now verify mutation epoch invalidation on a fresh guard: after an edit, re-running same read eval is novel.
		const guard2 = new WorkflowLoopGuard({
			stepBudget: {
				baseSteps: 2,
				extensionSteps: 2,
				maxExtensions: 4,
				hardCap: 20,
				windowSize: 6,
				minProgressRatio: 0.5,
				minDistinct: 2,
			},
		});
		guard2.recordToolBatch(
			[{ name: "eval", arguments: { language: "python", code: 'print(open("src/a.ts").read())' } }],
			[{ toolName: "eval", isError: false, content: [{ type: "text", text: "v1" }] }],
		);
		guard2.recordToolBatch(
			[{ name: "edit", arguments: { path: "src/a.ts" } }],
			[{ toolName: "edit", isError: false, content: [{ type: "text", text: "edited" }] }],
		);
		guard2.beforeModelCall();
		guard2.beforeModelCall();
		// Consume initial novelty via extension 1.
		expect(guard2.beforeModelCall()).toBeUndefined();
		// Re-running the same read-only eval AFTER mutation has a fresh @e1 targetKey and new epoch.
		guard2.recordToolBatch(
			[{ name: "eval", arguments: { language: "python", code: 'print(open("src/a.ts").read())' } }],
			[{ toolName: "eval", isError: false, content: [{ type: "text", text: "v1" }] }],
		);
		guard2.beforeModelCall();
		// Extension 2 succeeds because the post-mutation read eval is treated as novel.
		expect(guard2.beforeModelCall()).toBeUndefined();
	});

	it("counts real errors in mixed error+skipped batches and leaves failure count unchanged on all-skipped batches", () => {
		const guard = new WorkflowLoopGuard({ maxConsecutiveFailures: 2 });

		// Real error paired with skipped sibling must increment consecutiveFailures (not reset!).
		expect(
			guard.recordToolBatch(
				[
					{ name: "bash", arguments: { command: "false" } },
					{ name: "bash", arguments: { command: "echo hi" } },
				],
				[
					{ toolName: "bash", isError: true, content: [{ type: "text", text: "exit 1" }] },
					{
						toolName: "bash",
						isError: true,
						content: [{ type: "text", text: "Skipped due to queued user message." }],
					},
				],
			),
		).toBeUndefined();
		expect(guard.consecutiveFailures).toBe(1);

		// All-skipped batch must NOT increment or reset consecutiveFailures.
		expect(
			guard.recordToolBatch(
				[{ name: "bash", arguments: { command: "echo skipped" } }],
				[{ toolName: "bash", isError: true, content: [{ type: "text", text: "Not executed: steering queued." }] }],
			),
		).toBeUndefined();
		expect(guard.consecutiveFailures).toBe(1);

		// Second real error trips the circuit breaker.
		const stop = guard.recordToolBatch(
			[{ name: "bash", arguments: { command: "false" } }],
			[{ toolName: "bash", isError: true, content: [{ type: "text", text: "exit 1" }] }],
		);
		expect(stop?.stopClass).toBe("consecutive_failure");
	});

	it("respects external output token counts for soft warning and hard token_budget_exceeded stop", () => {
		let externalTokens = 820;
		const guard = new WorkflowLoopGuard({
			maxOutputTokens: 1000,
			softBudgetWarningRatio: 0.8,
			getExternalOutputTokens: () => externalTokens,
		});

		const first = guard.recordAssistantUsage({ input: 50, output: 100, cost: { total: 0.01 } });
		expect(first.stop).toBeUndefined();
		expect(first.softWarning?.kind).toBe("output_tokens");

		// Second call below cap does not re-emit soft warning.
		externalTokens = 900;
		const second = guard.recordAssistantUsage({ input: 50, output: 50, cost: { total: 0.01 } });
		expect(second.softWarning).toBeUndefined();
		expect(second.stop).toBeUndefined();

		// Crossing cap via external tokens triggers hard stop.
		externalTokens = 1050;
		const third = guard.recordAssistantUsage({ input: 50, output: 50, cost: { total: 0.01 } });
		expect(third.stop?.stopClass).toBe("token_budget_exceeded");
	});

	it("disables soft budget warnings when softBudgetWarningRatio is explicitly 0 without affecting hard caps", () => {
		const guard = new WorkflowLoopGuard({
			maxCostUsd: 1.0,
			maxOutputTokens: 1000,
			softBudgetWarningRatio: 0,
		});

		// 85% cost and 90% output tokens would both trigger under the 0.8 fallback,
		// but softBudgetWarningRatio: 0 must suppress soft warnings completely.
		const nearCap = guard.recordAssistantUsage({
			input: 100,
			output: 900,
			cost: { total: 0.85 },
		});
		expect(nearCap.softWarning).toBeUndefined();
		expect(nearCap.stop).toBeUndefined();

		// Hard caps remain enforced.
		const overCap = guard.recordAssistantUsage({
			input: 50,
			output: 50,
			cost: { total: 0.2 },
		});
		expect(overCap.softWarning).toBeUndefined();
		expect(overCap.stop?.stopClass).toBe("cost_budget_exceeded");
	});

	it("tracks cost and output-token soft warnings independently in both orders", () => {
		// Order 1: cost soft ratio crossed first, then output_tokens soft ratio crossed.
		const costFirst = new WorkflowLoopGuard({
			maxCostUsd: 1.0,
			maxOutputTokens: 1000,
			softBudgetWarningRatio: 0.8,
		});
		const c1 = costFirst.recordAssistantUsage({ input: 50, output: 200, cost: { total: 0.85 } });
		expect(c1.softWarning?.kind).toBe("cost");
		expect(c1.stop).toBeUndefined();

		const c2 = costFirst.recordAssistantUsage({ input: 50, output: 650, cost: { total: 0.05 } });
		expect(c2.softWarning?.kind).toBe("output_tokens");
		expect(c2.stop).toBeUndefined();

		// Neither warning re-emits once emitted.
		const c3 = costFirst.recordAssistantUsage({ input: 10, output: 20, cost: { total: 0.01 } });
		expect(c3.softWarning).toBeUndefined();
		expect(c3.stop).toBeUndefined();

		// Order 2: output_tokens soft ratio crossed first, then cost soft ratio crossed.
		const tokensFirst = new WorkflowLoopGuard({
			maxCostUsd: 1.0,
			maxOutputTokens: 1000,
			softBudgetWarningRatio: 0.8,
		});
		const t1 = tokensFirst.recordAssistantUsage({ input: 50, output: 850, cost: { total: 0.2 } });
		expect(t1.softWarning?.kind).toBe("output_tokens");
		expect(t1.stop).toBeUndefined();

		const t2 = tokensFirst.recordAssistantUsage({ input: 50, output: 50, cost: { total: 0.65 } });
		expect(t2.softWarning?.kind).toBe("cost");
		expect(t2.stop).toBeUndefined();

		const t3 = tokensFirst.recordAssistantUsage({ input: 10, output: 20, cost: { total: 0.01 } });
		expect(t3.softWarning).toBeUndefined();
		expect(t3.stop).toBeUndefined();
	});

	it("treats glob as read-only for failure masking and produces distinct toolTarget keys for glob and ast_grep", () => {
		// glob is read-only: a succeeding glob in the same batch as a failing mutating tool
		// must not mask the failure or reset consecutiveFailures.
		const guard = new WorkflowLoopGuard({ maxConsecutiveFailures: 2, maxSteps: 20 });
		expect(
			guard.recordToolBatch(
				[
					{ name: "glob", arguments: { paths: ["packages/agent/**/*.ts"] } },
					{ name: "edit", arguments: { path: "packages/agent/src/a.ts" } },
				],
				[
					{ toolName: "glob", isError: false },
					{ toolName: "edit", isError: true },
				],
			),
		).toBeUndefined();
		expect(guard.consecutiveFailures).toBe(1);

		const stop = guard.recordToolBatch(
			[
				{ name: "glob", arguments: { paths: ["packages/ai/**/*.ts"] } },
				{ name: "edit", arguments: { path: "packages/agent/src/a.ts" } },
			],
			[
				{ toolName: "glob", isError: false },
				{ toolName: "edit", isError: true },
			],
		);
		expect(stop?.stopClass).toBe("consecutive_failure");
		expect(stop?.consecutiveFailures).toBe(2);

		// glob target keys distinguish distinct args.paths entries (instead of collapsing to bare "glob").
		const globA = toolTarget("glob", { paths: ["packages/agent/**/*.ts"] });
		const globB = toolTarget("glob", { paths: ["packages/ai/**/*.ts"] });
		expect(globA).toBe("glob:packages/agent/**/*.ts");
		expect(globB).toBe("glob:packages/ai/**/*.ts");
		expect(globA).not.toBe(globB);

		// ast_grep target keys distinguish distinct args.pat and args.paths combinations.
		const astPatA = toolTarget("ast_grep", { pat: "foo($A)", paths: ["packages/agent"] });
		const astPatB = toolTarget("ast_grep", { pat: "bar($A)", paths: ["packages/agent"] });
		const astPathB = toolTarget("ast_grep", { pat: "foo($A)", paths: ["packages/ai"] });
		const astPatOnly = toolTarget("ast_grep", { pat: "baz($A)" });
		const astPathOnly = toolTarget("ast_grep", { paths: ["packages/utils"] });
		expect(new Set([astPatA, astPatB, astPathB, astPatOnly, astPathOnly]).size).toBe(5);
		expect(astPatA).toBe("ast_grep:foo($A)@packages/agent");
		expect(astPatOnly).toBe("ast_grep:baz($A)");
		expect(astPathOnly).toBe("ast_grep:packages/utils");
	});
});

describe("WorkflowLoopGuard pre-flight budget enforcement", () => {
	it("refuses beforeModelCall pre-flight when cost or external output tokens already reached the cap", () => {
		const costGuard = new WorkflowLoopGuard({ maxCostUsd: 1.0 });
		expect(costGuard.beforeModelCall()).toBeUndefined();
		const usageRes = costGuard.recordAssistantUsage({ output: 100, cost: { total: 1.0 } });
		expect(usageRes.stop?.stopClass).toBe("cost_budget_exceeded");

		// A follow-up beforeModelCall must refuse pre-flight without incrementing step.
		const preflightCost = costGuard.beforeModelCall();
		expect(preflightCost?.stopClass).toBe("cost_budget_exceeded");
		expect(preflightCost?.step).toBe(1);

		let externalOutput = 0;
		const tokenGuard = new WorkflowLoopGuard({
			maxOutputTokens: 500,
			getExternalOutputTokens: () => externalOutput,
		});
		expect(tokenGuard.beforeModelCall()).toBeUndefined();
		externalOutput = 550;
		const preflightTokens = tokenGuard.beforeModelCall();
		expect(preflightTokens?.stopClass).toBe("token_budget_exceeded");
		expect(preflightTokens?.step).toBe(1);
	});
});
