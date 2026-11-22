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
});
