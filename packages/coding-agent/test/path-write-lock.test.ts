import { describe, expect, it } from "bun:test";
import { withPathWriteLock } from "jeopi-cli/tools/path-write-lock";

describe("withPathWriteLock", () => {
	it("serializes concurrent writes to the same path instead of letting them interleave", async () => {
		// Deterministic interleaving window: without the per-path lock, both
		// invocations would be "in flight" between `inFlight++` and the gated
		// resume, so a real overlap flips `inFlight` to 2 and throws.
		let inFlight = 0;
		const gate = Promise.withResolvers<void>();
		const calls: string[] = [];
		const raw = async (dst: string) => {
			calls.push(`enter:${dst}`);
			inFlight++;
			if (inFlight > 1) throw new Error("overlap detected");
			await gate.promise;
			inFlight--;
			calls.push(`exit:${dst}`);
			return undefined;
		};
		const wrapped = withPathWriteLock(raw);

		const first = wrapped("/tmp/same.txt", "a");
		const second = wrapped("/tmp/same.txt", "b");

		// Give the first call's microtasks a chance to run and enter its
		// critical section; the second must still be queued behind the lock,
		// not racing into `raw` concurrently.
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toEqual(["enter:/tmp/same.txt"]);

		gate.resolve();
		await Promise.all([first, second]);

		// Strictly sequential: the first call's exit precedes the second's entry.
		expect(calls).toEqual(["enter:/tmp/same.txt", "exit:/tmp/same.txt", "enter:/tmp/same.txt", "exit:/tmp/same.txt"]);
	});

	it("does not serialize writes to different paths", async () => {
		let inFlight = 0;
		let overlapObserved = false;
		const gateA = Promise.withResolvers<void>();
		const gateB = Promise.withResolvers<void>();
		const raw = async (dst: string) => {
			inFlight++;
			if (inFlight > 1) overlapObserved = true;
			await (dst === "/tmp/a.txt" ? gateA.promise : gateB.promise);
			inFlight--;
			return undefined;
		};
		const wrapped = withPathWriteLock(raw);

		const a = wrapped("/tmp/a.txt", "a");
		const b = wrapped("/tmp/b.txt", "b");

		// Let both calls reach their gated await before releasing either —
		// proves the lock is per-path: both are in flight simultaneously.
		await Promise.resolve();
		await Promise.resolve();
		expect(inFlight).toBe(2);

		gateA.resolve();
		gateB.resolve();
		await Promise.all([a, b]);

		expect(overlapObserved).toBe(true);
	});

	it("does not poison the chain for a path after a prior write rejects", async () => {
		const wrapped = withPathWriteLock(async (_dst, content) => {
			if (content === "boom") throw new Error("boom");
			return undefined;
		});

		await expect(wrapped("/tmp/same.txt", "boom")).rejects.toThrow("boom");

		let secondCallbackRan = false;
		const secondWrapped = withPathWriteLock(async (_dst, content) => {
			secondCallbackRan = content === "ok";
			return undefined;
		});
		// Simulate the shared module-level chain by reusing the same `dst`: the
		// rejected first write must not hang or silently swallow a later write
		// to the same path.
		await secondWrapped("/tmp/same.txt", "ok");
		expect(secondCallbackRan).toBe(true);
	});
});
