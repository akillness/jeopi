/**
 * `AgentSession.dispose()` bounds the Hindsight retain-queue flush when a
 * shutdown budget (`mnemopiConsolidateTimeoutMs`) is supplied, and leaves it
 * unbounded otherwise. The underlying `HindsightApi` client uses plain
 * `fetch()` with no timeout/signal, so a hung/unreachable Hindsight server
 * could otherwise block `dispose()` (and therefore `/exit`/`/quit`)
 * indefinitely. See `agent-session.ts` around the "Bounded when a shutdown
 * budget is set" comment.
 *
 * These tests construct a real `AgentSession` (no network — mirrors the
 * offline fixture pattern used by `agent-session-goal-midrun-compaction.test.ts`
 * and `agent-session-steer-idle-drain.test.ts`, chosen over
 * `test/utilities.ts#createTestSession` because that helper builds a real
 * Anthropic-backed `Agent` intended for e2e tests that issue actual LLM
 * calls) and inject a fake `HindsightSessionState` via the public
 * `setHindsightSessionState` seam, exercising only the two methods
 * `dispose()` actually calls on it: `flushRetainQueue()` and `dispose()`.
 *
 * Fake timers drive the timeout deterministically (per AGENTS.md: no real
 * wall-clock waits in tests).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "jeopi-agent-core";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import type { HindsightSessionState } from "jeopi-cli/hindsight/state";
import { AgentSession } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { TempDir } from "jeopi-utils";

/** Settlement state of a promise, observed without blocking on it. */
type Settlement = { state: "pending" } | { state: "resolved" } | { state: "rejected"; error: unknown };

function observe(promise: Promise<unknown>): { settlement: Settlement } {
	const box: { settlement: Settlement } = { settlement: { state: "pending" } };
	promise.then(
		() => {
			box.settlement = { state: "resolved" };
		},
		error => {
			box.settlement = { state: "rejected", error };
		},
	);
	return box;
}

/**
 * Advance the fake clock in small steps, yielding a microtask turn after
 * each step, until `box.settlement` leaves "pending" or `maxSteps` is
 * exhausted. Needed because the timer that ultimately settles the awaited
 * promise (the Hindsight flush's `withTimeout`) is armed only after several
 * prior real (non-timer) async completions inside `dispose()` have already
 * run — a single `advanceTimersByTime` call before those complete would
 * advance a timer that does not exist yet.
 */
async function pumpUntilSettled(box: { settlement: Settlement }, maxSteps = 200, stepMs = 25): Promise<Settlement> {
	for (let i = 0; i < maxSteps && box.settlement.state === "pending"; i++) {
		vi.advanceTimersByTime(stepMs);
		await Promise.resolve();
	}
	return box.settlement;
}

describe("AgentSession.dispose() Hindsight retain-queue flush timeout", () => {
	let tempDir: TempDir;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-hindsight-flush-timeout-");
		authStorages.length = 0;
		vi.useFakeTimers();
	});

	afterEach(async () => {
		vi.useRealTimers();
		for (const authStorage of authStorages) authStorage.close();
		authStorages.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	/** Build a real, offline AgentSession (no LLM calls are ever made). */
	async function createSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `testauth-${authStorages.length}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(
			authStorage,
			path.join(tempDir.path(), `models-${authStorages.length}.yml`),
		);
		const settings = Settings.isolated();
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		return new AgentSession({ agent, sessionManager, settings, modelRegistry });
	}

	/** Minimal fake matching only the two members `dispose()` calls. */
	function fakeHindsightState(flushRetainQueue: () => Promise<void>): { disposed: boolean } & HindsightSessionState {
		const fake = {
			disposed: false,
			flushRetainQueue,
			dispose(): void {
				fake.disposed = true;
			},
		};
		return fake as unknown as { disposed: boolean } & HindsightSessionState;
	}

	it("awaits a fast flush to completion when a shutdown budget is set", async () => {
		let flushCompleted = false;
		const fake = fakeHindsightState(async () => {
			await Promise.resolve();
			flushCompleted = true;
		});

		const session = await createSession();
		session.setHindsightSessionState(fake);

		const box = observe(session.dispose({ mnemopiConsolidateTimeoutMs: 100 }));
		const settlement = await pumpUntilSettled(box);

		expect(settlement).toEqual({ state: "resolved" });
		expect(flushCompleted).toBe(true);
		expect(fake.disposed).toBe(true);
	});

	it("does not hang dispose() when the flush never resolves and a shutdown budget is set", async () => {
		const fake = fakeHindsightState(() => new Promise<void>(() => {}));

		const session = await createSession();
		session.setHindsightSessionState(fake);

		const box = observe(session.dispose({ mnemopiConsolidateTimeoutMs: 50 }));
		const settlement = await pumpUntilSettled(box);

		// The 50ms budget elapsed; dispose() swallowed the timeout and still
		// settled (resolved, not rejected) rather than hanging on the fake's
		// never-resolving flushRetainQueue().
		expect(settlement).toEqual({ state: "resolved" });
		// dispose() still runs its normal teardown after swallowing the timeout.
		expect(fake.disposed).toBe(true);
	});

	it("leaves the flush unbounded when no shutdown budget is given", async () => {
		const fake = fakeHindsightState(() => new Promise<void>(() => {}));

		const session = await createSession();
		session.setHindsightSessionState(fake);

		const box = observe(session.dispose({}));
		// Advance well past any budget used elsewhere in this suite (50-100ms)
		// to prove the absence of a budget is not merely "a larger timeout".
		const settlement = await pumpUntilSettled(box, 40, 25);

		expect(settlement).toEqual({ state: "pending" });
		// The fake's flush never resolves, so dispose() never reaches the point
		// of tearing down the hindsight state — confirming the unbounded path
		// genuinely awaits the flush rather than racing/timing it out silently.
		expect(fake.disposed).toBe(false);
	});
});
