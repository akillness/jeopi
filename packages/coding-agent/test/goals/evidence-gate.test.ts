import { describe, expect, it } from "bun:test";
import { GoalEvidenceTracker, isVerificationSignal } from "jeopi-cli/goals/evidence-gate";
import { GoalRuntime, type GoalRuntimeHost } from "jeopi-cli/goals/runtime";
import type { Goal, GoalModeState, GoalTokenUsage } from "jeopi-cli/goals/state";

function createUsage(): GoalTokenUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function createGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Ship the feature",
		status: "active",
		tokenBudget: undefined,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function createRuntime(initialState?: GoalModeState) {
	let state: GoalModeState | undefined = initialState;
	const host: GoalRuntimeHost = {
		getState: () => (state ? { ...state, goal: { ...state.goal } } : undefined),
		setState: next => {
			state = next ? { ...next, goal: { ...next.goal } } : undefined;
		},
		getCurrentUsage: createUsage,
		emit: async () => {},
		persist: () => {},
		sendHiddenMessage: async () => {},
		now: () => 0,
	};
	return { runtime: new GoalRuntime(host), getState: () => state };
}

const SUBSTANTIVE_EVIDENCE = "Ran bun test on the touched packages and inspected the new output end-to-end.";

describe("isVerificationSignal", () => {
	it("matches test/build/typecheck/lint commands", () => {
		expect(isVerificationSignal("bun test packages/agent")).toBe(true);
		expect(isVerificationSignal("bun run typecheck")).toBe(true);
		expect(isVerificationSignal("cargo build --release")).toBe(true);
		expect(isVerificationSignal("biome lint .")).toBe(true);
	});

	it("matches verification banners in output when the command is opaque", () => {
		expect(isVerificationSignal("./run-ci.sh", "Running 347 tests across 25 files")).toBe(true);
	});

	it("rejects non-verification commands", () => {
		expect(isVerificationSignal("git status")).toBe(false);
		expect(isVerificationSignal("ls -la", "total 48")).toBe(false);
	});

	it("only scans the output head, not megabytes of logs", () => {
		const noise = "x".repeat(5000);
		expect(isVerificationSignal("./opaque.sh", `${noise} test passed`)).toBe(false);
	});
});

describe("GoalEvidenceTracker.classifyCompletion", () => {
	it("passes when nothing was mutated", () => {
		const tracker = new GoalEvidenceTracker();
		expect(tracker.classifyCompletion()).toMatchObject({ state: "pass", block: false });
	});

	it("blocks a mutation with no verification, then passes the second attempt (escape hatch)", () => {
		const tracker = new GoalEvidenceTracker();
		tracker.recordMutation();
		const first = tracker.classifyCompletion();
		expect(first.state).toBe("unverified");
		expect(first.block).toBe(true);
		expect(first.message).toContain("no verification signal");
		// Second attempt with no new evidence: escape hatch for docs/config-only work.
		expect(tracker.classifyCompletion()).toMatchObject({ state: "pass", block: false });
	});

	it("passes when a verification followed the last mutation", () => {
		const tracker = new GoalEvidenceTracker();
		tracker.recordMutation();
		tracker.recordVerification();
		expect(tracker.classifyCompletion()).toMatchObject({ state: "pass", block: false });
	});

	it("blocks stale verification: verified, then mutated again", () => {
		const tracker = new GoalEvidenceTracker();
		tracker.recordMutation();
		tracker.recordVerification();
		tracker.recordMutation();
		const verdict = tracker.classifyCompletion();
		expect(verdict.state).toBe("stale-verification");
		expect(verdict.block).toBe(true);
		expect(verdict.message).toContain("AFTER the last successful verification");
	});

	it("re-arms the gate when a new mutation lands after a bounce", () => {
		const tracker = new GoalEvidenceTracker();
		tracker.recordMutation();
		expect(tracker.classifyCompletion().block).toBe(true);
		// New mutation invalidates the escape hatch granted by the first bounce.
		tracker.recordMutation();
		expect(tracker.classifyCompletion().block).toBe(true);
		expect(tracker.classifyCompletion().block).toBe(false);
	});

	it("reset clears all evidence", () => {
		const tracker = new GoalEvidenceTracker();
		tracker.recordMutation();
		tracker.reset();
		expect(tracker.sawMutation).toBe(false);
		expect(tracker.classifyCompletion()).toMatchObject({ state: "pass", block: false });
	});
});

describe("GoalRuntime evidence gate integration", () => {
	it("recordToolEvidence classifies mutations and verification runs for the active goal", () => {
		const { runtime } = createRuntime({ enabled: true, mode: "active", goal: createGoal() });

		runtime.recordToolEvidence("edit");
		expect(runtime.evidence.sawMutation).toBe(true);
		expect(runtime.evidence.sawVerification).toBe(false);

		runtime.recordToolEvidence("bash", { command: "bun test packages/agent" });
		expect(runtime.evidence.sawVerification).toBe(true);
		expect(runtime.evidence.verificationStale).toBe(false);
	});

	it("ignores evidence when no goal is accounting", () => {
		const { runtime } = createRuntime(undefined);
		runtime.recordToolEvidence("edit");
		expect(runtime.evidence.sawMutation).toBe(false);
	});

	it("ignores non-verification bash runs", () => {
		const { runtime } = createRuntime({ enabled: true, mode: "active", goal: createGoal() });
		runtime.recordToolEvidence("bash", { command: "git status" });
		expect(runtime.evidence.sawVerification).toBe(false);
	});

	it("blocks the first complete after an unverified mutation, then allows the retry", async () => {
		const { runtime, getState } = createRuntime({ enabled: true, mode: "active", goal: createGoal() });

		runtime.recordToolEvidence("write");
		await expect(runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE)).rejects.toThrow("no verification signal");
		expect(getState()?.goal.status).toBe("active");

		// Second attempt passes (escape hatch), mirroring classifyDoneGate's contract.
		const completed = await runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE);
		expect(completed.status).toBe("complete");
	});

	it("completes on the first attempt when verification followed the mutation", async () => {
		const { runtime } = createRuntime({ enabled: true, mode: "active", goal: createGoal() });

		runtime.recordToolEvidence("edit");
		runtime.recordToolEvidence("bash", { command: "bun run check && bun test" });
		const completed = await runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE);
		expect(completed.status).toBe("complete");
	});

	it("blocks completion when files changed after the last verification", async () => {
		const { runtime } = createRuntime({ enabled: true, mode: "active", goal: createGoal() });

		runtime.recordToolEvidence("edit");
		runtime.recordToolEvidence("bash", { command: "bun test" });
		runtime.recordToolEvidence("edit");
		await expect(runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE)).rejects.toThrow(
			"AFTER the last successful verification",
		);
	});

	it("createGoal resets evidence from a prior goal", async () => {
		const { runtime } = createRuntime({
			enabled: true,
			mode: "active",
			goal: createGoal({ id: "goal-old", status: "complete" }),
		});
		// Simulate stale evidence left over from the previous goal's session.
		runtime.evidence.recordMutation();

		await runtime.createGoal({ objective: "Next objective" });
		expect(runtime.evidence.sawMutation).toBe(false);
		const completed = await runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE);
		expect(completed.status).toBe("complete");
	});
});
