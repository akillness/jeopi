import { describe, expect, it } from "bun:test";
import { type GoalCompletionVerdict, GoalRuntime, type GoalRuntimeHost } from "jeopi-cli/goals/runtime";
import type { Goal, GoalModeState, GoalRuntimeEvent, GoalTokenUsage } from "jeopi-cli/goals/state";

function createUsage(overrides: Partial<GoalTokenUsage> = {}): GoalTokenUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		...overrides,
	};
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

function cloneGoal(goal: Goal): Goal {
	return { ...goal };
}

function cloneState(state: GoalModeState | undefined): GoalModeState | undefined {
	return state ? { ...state, goal: cloneGoal(state.goal) } : undefined;
}

function cloneEvent(event: GoalRuntimeEvent): GoalRuntimeEvent {
	if (event.type === "goal_updated") {
		return {
			...event,
			goal: event.goal ? cloneGoal(event.goal) : null,
			state: cloneState(event.state),
		};
	}
	return { ...event };
}

/**
 * Same harness shape as goal-runtime.test.ts's createHarness, extended with a
 * `verifyCompletion` override so these tests can exercise
 * GoalRuntimeHost.verifyCompletion — the shared harness there omits it
 * entirely, which is itself what covers the "hook not wired" backward-compat
 * path (also re-confirmed below).
 */
function createHarness(
	initial: {
		state?: GoalModeState;
		usage?: GoalTokenUsage;
		now?: number;
		verifyCompletion?: (objective: string, evidence: string) => Promise<GoalCompletionVerdict>;
	} = {},
) {
	let state = cloneState(initial.state);
	const usage = createUsage(initial.usage);
	const now = initial.now ?? 0;
	const events: GoalRuntimeEvent[] = [];
	const persists: Array<{ mode: "goal" | "goal_paused" | "none"; state?: GoalModeState }> = [];
	const hiddenMessages: Array<{ customType: string; content: string; deliverAs?: "steer" | "followUp" | "nextTurn" }> =
		[];
	const host: GoalRuntimeHost = {
		getState: () => cloneState(state),
		setState: next => {
			state = cloneState(next);
		},
		getCurrentUsage: () => createUsage(usage),
		emit: async event => {
			events.push(cloneEvent(event));
		},
		persist: (mode, persistedState) => {
			persists.push({ mode, state: cloneState(persistedState) });
		},
		sendHiddenMessage: async message => {
			hiddenMessages.push({ ...message });
		},
		now: () => now,
		...(initial.verifyCompletion ? { verifyCompletion: initial.verifyCompletion } : {}),
	};
	return {
		runtime: new GoalRuntime(host),
		getState: () => cloneState(state),
		events,
		persists,
		hiddenMessages,
	};
}

const SUBSTANTIVE_EVIDENCE = "Ran the full release checklist and confirmed every deliverable is in the shipped build.";

describe("GoalRuntime completeGoalFromTool independent verifier gate", () => {
	it("succeeds when the host's verifyCompletion resolves an okay verdict", async () => {
		let calls = 0;
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
			verifyCompletion: async () => {
				calls++;
				return { verdict: "okay", justification: "", requiredFixes: [] };
			},
		});

		const completed = await harness.runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE);

		expect(completed.status).toBe("complete");
		expect(harness.getState()?.goal.status).toBe("complete");
		expect(calls).toBe(1);
	});

	it("blocks the first attempt with an error containing the verdict, justification, and required fixes", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
			verifyCompletion: async () => ({
				verdict: "reject",
				justification: "missing X",
				requiredFixes: ["add X"],
			}),
		});

		let caught: Error | undefined;
		try {
			await harness.runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE);
		} catch (err) {
			caught = err as Error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(caught?.message).toContain("reject");
		expect(caught?.message).toContain("missing X");
		expect(caught?.message).toContain("add X");
		expect(harness.getState()?.goal.status).toBe("active");
	});

	it("bounce-once: a second complete call with no new evidence between attempts succeeds despite an unchanged non-okay verdict", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
			verifyCompletion: async () => ({
				verdict: "reject",
				justification: "missing X",
				requiredFixes: ["add X"],
			}),
		});

		await expect(harness.runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE)).rejects.toThrow();
		expect(harness.getState()?.goal.status).toBe("active");

		const completed = await harness.runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE);

		expect(completed.status).toBe("complete");
		expect(harness.getState()?.goal.status).toBe("complete");
	});

	it("a verification-signal recordToolEvidence between the two complete calls re-arms the verifier check, blocking the second call again", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
			verifyCompletion: async () => ({
				verdict: "reject",
				justification: "missing X",
				requiredFixes: ["add X"],
			}),
		});

		await expect(harness.runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE)).rejects.toThrow();
		expect(harness.getState()?.goal.status).toBe("active");

		// A verification-signal bash call (not a mutation) clears the verifier
		// bypass latch without also tripping the separate deterministic
		// evidence-gate mutation check — isolates the verifier re-arm behavior
		// under test from that unrelated gate.
		harness.runtime.recordToolEvidence("bash", { command: "npm test" });

		let caught: Error | undefined;
		try {
			await harness.runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE);
		} catch (err) {
			caught = err as Error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(caught?.message).toContain("reject");
		expect(harness.getState()?.goal.status).toBe("active");
	});

	it("a mutation recordToolEvidence between the two complete calls blocks the second call via the deterministic evidence gate", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
			verifyCompletion: async () => ({
				verdict: "reject",
				justification: "missing X",
				requiredFixes: ["add X"],
			}),
		});

		await expect(harness.runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE)).rejects.toThrow();
		expect(harness.getState()?.goal.status).toBe("active");

		// A mutation (edit) between attempts is new evidence: it re-arms the
		// deterministic evidence gate (unverified mutation), which now blocks
		// the retry before the independent verifier even runs again.
		harness.runtime.recordToolEvidence("edit");

		await expect(harness.runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE)).rejects.toThrow(/verification signal/);
		expect(harness.getState()?.goal.status).toBe("active");
	});

	it("proceeds exactly as before (completes without ever calling verifyCompletion) when the host does not implement the optional hook", async () => {
		// Mirrors the shared harness in goal-runtime.test.ts, which omits
		// verifyCompletion entirely — completeGoalFromTool must not require it.
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		const completed = await harness.runtime.completeGoalFromTool(SUBSTANTIVE_EVIDENCE);

		expect(completed.status).toBe("complete");
		expect(harness.getState()?.goal.status).toBe("complete");
	});
});
