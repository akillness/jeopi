import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../async";
import { Settings } from "../config/settings";
import { IrcBus } from "../irc/bus";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { ToolSession } from "./index";
import { SubagentTool } from "./subagent";
import { ToolError } from "./tool-errors";

function makeSession(opts: { agentId: string; registry: AgentRegistry; manager?: AsyncJobManager }): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		agentRegistry: opts.registry,
		asyncJobManager: opts.manager,
		getAgentId: () => opts.agentId,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

/** Registers a `task` job whose `run` never resolves until the test resolves it. */
function registerPendingTaskJob(manager: AsyncJobManager, ownerId: string, id: string) {
	const { promise, resolve } = Promise.withResolvers<string>();
	manager.register(
		"task",
		id,
		async ({ markRunning }) => {
			markRunning();
			return promise;
		},
		{ id, ownerId },
	);
	return { resolve };
}

describe("SubagentTool", () => {
	let registry: AgentRegistry;
	let manager: AsyncJobManager;

	beforeEach(() => {
		// `IrcBus.global()` (used internally by steer/resume/pause) always routes
		// through `AgentRegistry.global()`, so the fake session must live there
		// too for delivery to resolve the same refs `list`/`inspect` see.
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
		manager = new AsyncJobManager({ onJobComplete: () => {} });
		IrcBus.resetGlobalForTests();
	});

	afterEach(() => {
		manager.cancelAll();
	});

	it("scopes `list` to the calling agent's own spawns", async () => {
		registerPendingTaskJob(manager, "Main", "Sub1");
		registerPendingTaskJob(manager, "Other", "Sub2");

		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		const result = await tool.execute("call-1", { action: "list" });

		expect(result.details?.subagents.map(s => s.id)).toEqual(["Sub1"]);
	});

	it('reports a spawn as "queued" until its runner calls markRunning', async () => {
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("task", "Sub1", async () => promise, { id: "Sub1", ownerId: "Main", queued: true });

		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		const result = await tool.execute("call-1", { action: "list" });

		expect(result.details?.subagents[0]).toMatchObject({ id: "Sub1", status: "queued" });
		resolve("cleanup");
	});

	it("rejects cancel without a target id", async () => {
		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		await expect(tool.execute("call-1", { action: "cancel" })).rejects.toThrow(ToolError);
	});

	it("classifies cancel outcomes: cancelled, not_found, already_completed", async () => {
		const { resolve } = registerPendingTaskJob(manager, "Main", "Running1");
		manager.register("task", "Done1", async () => "done", { id: "Done1", ownerId: "Main" });
		// Let Done1 settle before cancelling it.
		await manager.getJob("Done1")?.promise;

		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		const result = await tool.execute("call-1", { action: "cancel", ids: ["Running1", "Done1", "Ghost"] });

		expect(result.details?.cancelled).toEqual(
			expect.arrayContaining([
				{ id: "Running1", status: "cancelled" },
				{ id: "Done1", status: "already_completed" },
				{ id: "Ghost", status: "not_found" },
			]),
		);
		resolve("cleanup");
	});

	it("cannot cancel a job owned by a different agent", async () => {
		const { resolve } = registerPendingTaskJob(manager, "Other", "Sub1");
		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		const result = await tool.execute("call-1", { action: "cancel", ids: ["Sub1"] });

		expect(result.details?.cancelled).toEqual([{ id: "Sub1", status: "not_found" }]);
		expect(manager.getJob("Sub1")?.status).toBe("running");
		resolve("cleanup");
	});

	it("rejects steer/resume/pause targeting the caller itself", async () => {
		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		await expect(tool.execute("c1", { action: "steer", id: "Main", message: "hi" })).rejects.toThrow(ToolError);
		await expect(tool.execute("c2", { action: "resume", id: "Main", message: "hi" })).rejects.toThrow(ToolError);
		await expect(tool.execute("c3", { action: "pause", id: "Main" })).rejects.toThrow(ToolError);
	});

	it("resume is a no-op on a still-running subagent and does not require a message", async () => {
		const { resolve } = registerPendingTaskJob(manager, "Main", "Sub1");
		registry.register({ id: "Sub1", displayName: "Sub1", kind: "sub", session: null, status: "running" });

		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		const result = await tool.execute("call-1", { action: "resume", id: "Sub1" });

		expect(result.isError).toBeFalsy();
		expect(textOf(result)).toContain("already running");
		resolve("cleanup");
	});

	it("resume requires a message once the subagent has finished", async () => {
		manager.register("task", "Sub1", async () => "done", { id: "Sub1", ownerId: "Main" });
		await manager.getJob("Sub1")?.promise;
		registry.register({ id: "Sub1", displayName: "Sub1", kind: "sub", session: null, status: "idle" });

		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		await expect(tool.execute("call-1", { action: "resume", id: "Sub1" })).rejects.toThrow(ToolError);
	});

	it("marks a finished-but-resident subagent as resumable in its snapshot", async () => {
		manager.register("task", "Sub1", async () => "done", { id: "Sub1", ownerId: "Main" });
		await manager.getJob("Sub1")?.promise;
		registry.register({ id: "Sub1", displayName: "Sub1", kind: "sub", session: null, status: "idle" });

		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		const result = await tool.execute("call-1", { action: "list" });

		expect(result.details?.subagents[0]).toMatchObject({ id: "Sub1", status: "completed", resumable: true });
	});

	it("pause is a no-op once the subagent already finished", async () => {
		manager.register("task", "Sub1", async () => "done", { id: "Sub1", ownerId: "Main" });
		await manager.getJob("Sub1")?.promise;
		registry.register({ id: "Sub1", displayName: "Sub1", kind: "sub", session: null, status: "idle" });

		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		const result = await tool.execute("call-1", { action: "pause", id: "Sub1" });

		expect(textOf(result)).toContain("not running");
	});
	it('pause marks a still-running subagent "paused"; a later resume clears it', async () => {
		const { resolve } = registerPendingTaskJob(manager, "Main", "Sub1");
		const fakeSession = { deliverIrcMessage: async () => "injected" as const } as unknown as AgentSession;
		registry.register({ id: "Sub1", displayName: "Sub1", kind: "sub", session: fakeSession, status: "running" });

		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		const pauseResult = await tool.execute("c1", { action: "pause", id: "Sub1" });
		expect(pauseResult.isError).toBeFalsy();

		// Simulate the subagent actually reaching a safe boundary and stopping in
		// response to the pause request (a real run would flip both together).
		resolve("stopped early");
		await manager.getJob("Sub1")?.promise;
		registry.setStatus("Sub1", "idle");

		const paused = await tool.execute("c2", { action: "list" });
		expect(paused.details?.subagents[0]).toMatchObject({ id: "Sub1", status: "paused", resumable: true });

		const resumeResult = await tool.execute("c3", { action: "resume", id: "Sub1", message: "continue" });
		expect(resumeResult.isError).toBeFalsy();

		const afterResume = await tool.execute("c4", { action: "list" });
		expect(afterResume.details?.subagents[0].status).not.toBe("paused");
	});

	it("a subagent that goes idle while running is never mistaken for paused", async () => {
		const { resolve } = registerPendingTaskJob(manager, "Main", "Sub1");
		registry.register({ id: "Sub1", displayName: "Sub1", kind: "sub", session: null, status: "running" });
		resolve("finished on its own");
		await manager.getJob("Sub1")?.promise;
		registry.setStatus("Sub1", "idle");

		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		const result = await tool.execute("call-1", { action: "list" });

		expect(result.details?.subagents[0]).toMatchObject({ id: "Sub1", status: "completed", resumable: true });
	});

	it("cancel aborts a live resumed session even without an active async job", async () => {
		const abortReasons: (string | undefined)[] = [];
		const fakeSession = {
			abort: async (opts?: { reason?: string }) => {
				abortReasons.push(opts?.reason);
			},
		} as unknown as AgentSession;
		manager.register("task", "Sub1", async () => "done", { id: "Sub1", ownerId: "Main" });
		await manager.getJob("Sub1")?.promise;
		registry.register({ id: "Sub1", displayName: "Sub1", kind: "sub", session: fakeSession, status: "running" });

		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		const result = await tool.execute("call-1", { action: "cancel", id: "Sub1" });

		expect(result.details?.cancelled).toEqual([{ id: "Sub1", status: "cancelled" }]);
		expect(abortReasons).toEqual(["Cancelled via subagent tool"]);
	});

	it("applies `limit` to `list` and reports how many were hidden", async () => {
		registerPendingTaskJob(manager, "Main", "Sub1");
		registerPendingTaskJob(manager, "Main", "Sub2");
		registerPendingTaskJob(manager, "Main", "Sub3");

		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		const result = await tool.execute("call-1", { action: "list", limit: 2 });

		expect(result.details?.subagents).toHaveLength(2);
		expect(result.details?.truncated).toBe(1);
	});

	it("verbosity widths match GJC: receipt<=280, preview<=2000, full<=12000 chars", async () => {
		const longOutput = "x".repeat(15_000);
		manager.register("task", "Sub1", async () => longOutput, { id: "Sub1", ownerId: "Main" });
		await manager.getJob("Sub1")?.promise;

		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));

		// `verbosity` defaults to "receipt" per GJC (not "preview").
		const defaulted = await tool.execute("c0", { action: "inspect", ids: ["Sub1"] });
		expect(defaulted.details?.subagents[0].resultText).toHaveLength(280);

		const receipt = await tool.execute("c1", { action: "inspect", ids: ["Sub1"], verbosity: "receipt" });
		expect(receipt.details?.subagents[0].resultText).toHaveLength(280);

		const preview = await tool.execute("c2", { action: "inspect", ids: ["Sub1"], verbosity: "preview" });
		expect(preview.details?.subagents[0].resultText).toHaveLength(2_000);

		const full = await tool.execute("c3", { action: "inspect", ids: ["Sub1"], verbosity: "full" });
		expect(full.details?.subagents[0].resultText).toHaveLength(12_000);
	});

	it('rejects verbosity="full" on `list`, and on any action without explicit ids', async () => {
		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));
		await expect(tool.execute("c1", { action: "list", verbosity: "full" })).rejects.toThrow(ToolError);
		await expect(tool.execute("c2", { action: "inspect", verbosity: "full" })).rejects.toThrow(ToolError);
		// Explicit ids makes `full` valid for a non-list action.
		const result = await tool.execute("c3", { action: "inspect", ids: ["Ghost"], verbosity: "full" });
		expect(result.isError).toBe(true);
	});

	it("`list` defaults to 10 results and clamps `limit` to a max of 50", async () => {
		for (let i = 0; i < 12; i++) {
			registerPendingTaskJob(manager, "Main", `Sub${i}`);
		}
		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));

		const defaulted = await tool.execute("c1", { action: "list" });
		expect(defaulted.details?.subagents).toHaveLength(10);
		expect(defaulted.details?.truncated).toBe(2);

		const overshoot = await tool.execute("c2", { action: "list", limit: 1_000 });
		expect(overshoot.details?.subagents).toHaveLength(12);
		expect(overshoot.details?.truncated).toBeUndefined();
	});

	it("accepts `timeout_ms` (snake_case, matching GJC) for `await`", async () => {
		registerPendingTaskJob(manager, "Main", "Sub1");
		const tool = new SubagentTool(makeSession({ agentId: "Main", registry, manager }));

		const result = await tool.execute("c1", { action: "await", ids: ["Sub1"], timeout_ms: 5 });
		expect(result.details?.subagents[0]).toMatchObject({ id: "Sub1", status: "running" });
	});
});
