import { describe, expect, it } from "bun:test";
import type { AgentMessage, AgentTurnEndContext } from "jeopi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "jeopi-ai";
import {
	AdviseTool,
	type AdvisorAgent,
	AdvisorEmissionGuard,
	AdvisorLoopGuard,
	AdvisorOutputQuarantinedError,
	AdvisorRuntime,
	evictStaleToolResults,
	fingerprintMessage,
	isPermanentAdvisorError,
	quarantineAdvisorUnsafeOutput,
} from "../../src/advisor";
import { parseAdvisorSyncBacklogThreshold } from "../../src/session/agent-session";
import { TOOL_CALL_CYCLE_REDIRECT_TYPE, TOOL_CALL_LOOP_REDIRECT_TYPE } from "../../src/session/tool-call-loop-redirect";

function assistantCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolRes(toolCallId: string, toolName: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

describe("AdvisorLoopGuard", () => {
	it("injects redirect on repeated advisor tool calls and returns stop on stalled escalation", () => {
		let stalled = 0;
		const guard = new AdvisorLoopGuard({
			advisorName: "watchdog",
			getConfig: () => ({ enabled: true, threshold: 2, maxRedirectsBeforeStop: 1, exemptTools: ["advise"] }),
			onStalled: () => {
				stalled++;
			},
		});

		const messages: AgentMessage[] = [];
		const runTurn = (idx: number, toolName: string, args: Record<string, unknown>, out: string, isError = false) => {
			const ctx: AgentTurnEndContext = {
				message: assistantCall(`c${idx}`, toolName, args),
				toolResults: [toolRes(`c${idx}`, toolName, out, isError)],
				willContinue: true,
			};
			return guard.onTurnEnd(messages, ctx);
		};

		// Exempt advise calls never trigger.
		expect(runTurn(1, "advise", { note: "x" }, "ok")).toBeUndefined();
		expect(runTurn(2, "advise", { note: "x" }, "ok")).toBeUndefined();
		expect(messages).toHaveLength(0);

		// Repeated identical failing read hits threshold=2 -> redirect injected.
		expect(runTurn(3, "read", { path: "missing.ts" }, "ENOENT", true)).toBeUndefined();
		expect(runTurn(4, "read", { path: "missing.ts" }, "ENOENT", true)).toBeUndefined();
		expect(messages).toHaveLength(1);
		expect((messages[0] as { customType?: string }).customType).toBe(TOOL_CALL_LOOP_REDIRECT_TYPE);

		// Continuing the unchanged failing loop reaches unchangedThreshold (4) -> stalled_tool_call -> returns "stop".
		expect(runTurn(5, "read", { path: "missing.ts" }, "ENOENT", true)).toBeUndefined();
		expect(runTurn(6, "read", { path: "missing.ts" }, "ENOENT", true)).toBe("stop");
		expect(stalled).toBe(1);
	});

	it("injects cyclical redirect on alternating A-B-A-B-A-B advisor tool calls", () => {
		const guard = new AdvisorLoopGuard({
			advisorName: "watchdog",
			getConfig: () => ({ enabled: true, threshold: 3, maxRedirectsBeforeStop: 2, exemptTools: ["advise"] }),
		});
		const messages: AgentMessage[] = [];
		const feed = (i: number, name: string, arg: string) =>
			guard.onTurnEnd(messages, {
				message: assistantCall(`c${i}`, name, { path: arg }),
				toolResults: [toolRes(`c${i}`, name, `same-${name}`)],
				willContinue: true,
			});
		feed(1, "read", "a.ts");
		feed(2, "grep", "foo");
		feed(3, "read", "a.ts");
		feed(4, "grep", "foo");
		feed(5, "read", "a.ts");
		feed(6, "grep", "foo");
		expect(messages.some(m => (m as { customType?: string }).customType === TOOL_CALL_CYCLE_REDIRECT_TYPE)).toBe(
			true,
		);
	});
});

describe("AdvisorEmissionGuard & AdviseTool unified admission", () => {
	it("suppresses filler and duplicates truthfully while allowing severity escalation and blocker budget bypass", async () => {
		const emitted: Array<{ note: string; severity?: string }> = [];
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		const tool = new AdviseTool((note, severity) => emitted.push({ note, severity }), { emissionGuard: guard });

		// Filler suppressed truthfully.
		const filler = await tool.execute("t1", { note: "LGTM.", severity: "nit" });
		expect((filler.content[0] as { text: string }).text).toContain("content-free status filler");
		expect(emitted).toHaveLength(0);

		// First real nit passes and consumes per-update budget (1).
		const first = await tool.execute("t2", { note: "Missing null guard in parser.", severity: "nit" });
		expect((first.content[0] as { text: string }).text).toBe("Recorded.");
		expect(emitted).toHaveLength(1);

		// Duplicate at same severity is rejected.
		const dup = await tool.execute("t3", { note: "missing null guard in parser!", severity: "nit" });
		expect((dup.content[0] as { text: string }).text).toContain("Duplicate advice ignored");
		expect(emitted).toHaveLength(1);

		// Same note escalated to concern is admitted!
		const escalated = await tool.execute("t4", { note: "Missing null guard in parser.", severity: "concern" });
		expect((escalated.content[0] as { text: string }).text).toBe("Escalated and recorded.");
		expect(emitted).toHaveLength(2);

		// Second distinct non-blocker hits per-update budget=1.
		const overBudget = await tool.execute("t5", { note: "Another minor style note.", severity: "nit" });
		expect((overBudget.content[0] as { text: string }).text).toContain("per-update note budget");
		expect(emitted).toHaveLength(2);

		// Blocker bypasses per-update budget.
		const blocker = await tool.execute("t6", { note: "Production migration drops user table.", severity: "blocker" });
		expect((blocker.content[0] as { text: string }).text).toBe("Recorded.");
		expect(emitted).toHaveLength(3);

		// Next update cycle resets per-update budget.
		guard.beginUpdate();
		const nextCycle = await tool.execute("t7", { note: "Another minor style note.", severity: "nit" });
		expect((nextCycle.content[0] as { text: string }).text).toBe("Recorded.");
		expect(emitted).toHaveLength(4);
	});
});

describe("AdvisorRuntime & syncBacklog safety guards", () => {
	it("parseAdvisorSyncBacklogThreshold handles strict/numbers safely and rejects booleans/garbage", () => {
		expect(parseAdvisorSyncBacklogThreshold("off")).toBeUndefined();
		expect(parseAdvisorSyncBacklogThreshold(false)).toBeUndefined();
		expect(parseAdvisorSyncBacklogThreshold(true)).toBeUndefined();
		expect(parseAdvisorSyncBacklogThreshold("invalid")).toBeUndefined();
		expect(parseAdvisorSyncBacklogThreshold(0)).toBeUndefined();
		expect(parseAdvisorSyncBacklogThreshold("strict")).toBe(1);
		expect(parseAdvisorSyncBacklogThreshold("1")).toBe(1);
		expect(parseAdvisorSyncBacklogThreshold("3")).toBe(3);
		expect(parseAdvisorSyncBacklogThreshold(5)).toBe(5);
	});

	it("waitForCatchup resolves immediately on NaN/non-positive threshold and on failing/halted advisor", async () => {
		let rejectPrompt!: (err: Error) => void;
		const agent: AdvisorAgent = {
			prompt: () =>
				new Promise<void>((_res, rej) => {
					rejectPrompt = rej;
				}),
			abort: () => {},
			reset: () => {},
			rollbackTo: () => {},
			state: { messages: [] },
		};
		const runtime = new AdvisorRuntime(
			agent,
			{ snapshotMessages: () => [{ role: "user", content: "turn", timestamp: 1 }], enqueueAdvice: () => {} },
			5_000,
		);
		runtime.onTurnEnd([{ role: "user", content: "turn 1", timestamp: 1 }]);
		expect(runtime.backlog).toBe(1);

		// NaN or <=0 threshold must resolve immediately instead of stalling for maxMs!
		const start = Date.now();
		await runtime.waitForCatchup(10_000, Number.NaN);
		await runtime.waitForCatchup(10_000, 0);
		expect(Date.now() - start).toBeLessThan(200);

		// When advisor hits a transient failure, waiting caller is woken immediately via #failing.
		const waitStart = Date.now();
		const waiter = runtime.waitForCatchup(10_000, 1);
		rejectPrompt(new Error("transient network glitch"));
		await waiter;
		expect(Date.now() - waitStart).toBeLessThan(500);
		runtime.dispose();
	});

	it("quarantines separated rm -r -f commands and recognizes upstream permanent advisor errors", () => {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Run rm -r -f /tmp/work immediately." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const reason = quarantineAdvisorUnsafeOutput(msg, new Set(["read"]), () => "normal source context");
		expect(reason).toContain("destructive shell command");
		expect(msg.stopReason).toBe("error");

		expect(isPermanentAdvisorError(new Error("invalid_request_error: model not found"))).toBe(true);
		expect(isPermanentAdvisorError(new Error("thinking is not supported when tool_choice is required"))).toBe(true);
	});

	it("notifies host after exceeding MAX_QUARANTINE_RETRIES consecutive quarantines", async () => {
		let failures = 0;
		const agent: AdvisorAgent = {
			prompt: async () => {
				throw new AdvisorOutputQuarantinedError("Advisor response quarantined: destructive shell command");
			},
			abort: () => {},
			reset: () => {},
			rollbackTo: () => {},
			state: { messages: [] },
		};
		const runtime = new AdvisorRuntime(
			agent,
			{
				snapshotMessages: () => [],
				enqueueAdvice: () => {},
				notifyFailure: () => {
					failures++;
				},
			},
			0,
		);
		for (let i = 1; i <= 3; i++) {
			runtime.onTurnEnd([{ role: "user", content: `turn ${i}`, timestamp: i }]);
			await Bun.sleep(10);
		}
		expect(failures).toBe(1);
		runtime.dispose();
	});
});

describe("evictStaleToolResults & fingerprintMessage", () => {
	it("evicts bulky old tool results while sparing recent turns and tiny results", () => {
		const big = "x".repeat(2000);
		const messages: AgentMessage[] = [
			toolRes("old-big", "read", big),
			toolRes("old-tiny", "read", "ok"),
			{ role: "user", content: "recent 1", timestamp: 1 },
			toolRes("recent-big", "read", big),
		];
		const res = evictStaleToolResults(messages, 2);
		expect(res.evictedCount).toBe(1);
		expect(res.savedTokens).toBeGreaterThan(0);
		expect((res.messages[0] as ToolResultMessage).prunedAt).toBeDefined();
		expect((res.messages[1] as ToolResultMessage).prunedAt).toBeUndefined();
		expect((res.messages[3] as ToolResultMessage).prunedAt).toBeUndefined();

		// Second pass is a no-op and preserves array reference.
		const second = evictStaleToolResults(res.messages, 2);
		expect(second.evictedCount).toBe(0);
		expect(second.messages).toBe(res.messages);
	});

	it("fingerprints messages identically across timestamp changes", () => {
		const a: AgentMessage = { role: "user", content: "same payload", timestamp: 100 };
		const b: AgentMessage = { role: "user", content: "same payload", timestamp: 999 };
		const c: AgentMessage = { role: "user", content: "other payload", timestamp: 100 };
		expect(fingerprintMessage(a)).toBe(fingerprintMessage(b));
		expect(fingerprintMessage(a)).not.toBe(fingerprintMessage(c));
	});
});

describe("AdvisorEmissionGuard Unicode and malformed config resilience", () => {
	it("preserves Korean/Unicode advisor notes and defaults NaN budget/capacity safely", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: Number.NaN, capacity: Number.NaN });
		expect(guard.budgetPerUpdate).toBe(1);
		expect(guard.admit("파서에 null 체크가 빠져 있습니다.", "concern")).toEqual({ allowed: true, escalated: false });
		expect(guard.admit("파서에 null 체크가 빠져 있습니다!", "concern")).toEqual({
			allowed: false,
			reason: "duplicate",
		});
		expect(guard.admit("파서에 null 체크가 빠져 있습니다.", "blocker")).toEqual({ allowed: true, escalated: true });
	});
});
