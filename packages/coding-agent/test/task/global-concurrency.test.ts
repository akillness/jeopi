import { afterEach, describe, expect, it } from "bun:test";
import { getGlobalSpawnSemaphore, resetGlobalSpawnSemaphoresForTests } from "jeopi-cli/task/global-concurrency";

afterEach(() => {
	resetGlobalSpawnSemaphoresForTests();
});

describe("global spawn concurrency", () => {
	it("shares the same top-level semaphore across callers and resizes in place", async () => {
		const semA = getGlobalSpawnSemaphore(2, 0);
		const semB = getGlobalSpawnSemaphore(2, 0);
		expect(semA).toBe(semB);

		await semA.acquire();
		await semB.acquire();

		let thirdAcquired = false;
		const third = semA.acquire().then(() => {
			thirdAcquired = true;
		});
		await Promise.resolve();
		expect(thirdAcquired).toBe(false);

		semB.release();
		await third;
		expect(thirdAcquired).toBe(true);

		semA.release();
		semA.release();
	});

	it("separates nested depth >= 1 semaphore from top-level to prevent parent-child deadlocks", async () => {
		const top = getGlobalSpawnSemaphore(2, 0);
		const nested = getGlobalSpawnSemaphore(2, 1);
		expect(top).not.toBe(nested);

		// Saturate all top-level slots
		await top.acquire();
		await top.acquire();

		// Nested spawn can still acquire without deadlocking on the saturated top-level pool
		let nestedAcquired = false;
		await nested.acquire().then(() => {
			nestedAcquired = true;
		});
		expect(nestedAcquired).toBe(true);

		nested.release();
		top.release();
		top.release();
	});
});
