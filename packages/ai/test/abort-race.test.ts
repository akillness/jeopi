import { describe, expect, it } from "bun:test";
import { raceWithSignal } from "jeopi-ai/utils/abort";

describe("raceWithSignal", () => {
	it("retains cancellation reason without leaking work rejected before helper entry", async () => {
		const controller = new AbortController();
		const cancellationReason = new Error("caller cancelled while work was starting");
		const workFailure = new Error("already-started shared work rejected");
		const { promise: work, reject } = Promise.withResolvers<never>();
		controller.abort(cancellationReason);
		reject(workFailure);

		// Only observe the caller's result: Bun must report any unhandled work rejection.
		await expect(raceWithSignal(work, controller.signal)).rejects.toBe(cancellationReason);
	});
});
