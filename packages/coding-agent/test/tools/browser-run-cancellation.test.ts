import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "../../src/eval/js/shared/runtime";
import { bindBrowserRunFacade, waitForBrowserRun } from "../../src/tools/browser/run-cancellation";

describe("browser run cancellation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts run-scoped wait() before a stale continuation can mutate the tab", async () => {
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "browser-run-cancellation-test" });
		const timeoutSignal = AbortSignal.timeout(20);
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, runAc.signal]);
		const state: { lateNavigation?: string; displays: string[] } = { displays: [] };
		const { promise: cancelRejection, reject } = Promise.withResolvers<never>();
		const hooks: RuntimeHooks = {
			onText: chunk => state.displays.push(chunk),
			onDisplay: output => state.displays.push(JSON.stringify(output)),
			callTool: async () => undefined,
		};
		timeoutSignal.addEventListener("abort", () => reject(new Error("Browser code execution timed out after 20ms")), {
			once: true,
		});
		runtime.setRunScope({
			wait: (ms: number): Promise<unknown> => waitForBrowserRun(ms, signal),
			tab: bindBrowserRunFacade(
				{
					goto: async (url: string): Promise<void> => {
						state.lateNavigation = url;
					},
				},
				signal,
			),
		});

		const run = Promise.race([
			runtime.run(
				'try { await wait(60); } catch {} await tab.goto("https://late.example"); display("late display");',
				"browser-run-cancellation-test.js",
				hooks,
			),
			cancelRejection,
		]);
		vi.advanceTimersByTime(20);
		await expect(run).rejects.toThrow("Browser code execution timed out after 20ms");
		runAc.abort(new Error("Browser run ended"));
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		await Promise.resolve();

		expect(state.lateNavigation).toBeUndefined();
		expect(state.displays).toEqual([]);
	});

	it("resolves wait(predicate) with the first truthy value", async () => {
		vi.useRealTimers();
		const controller = new AbortController();
		let calls = 0;

		const wait = waitForBrowserRun(() => (++calls >= 3 ? "ready" : null), controller.signal, { interval: 10 });

		await expect(wait).resolves.toBe("ready");
		expect(calls).toBe(3);
	});

	it("fails wait(predicate) with a named timeout error instead of stalling", async () => {
		vi.useRealTimers();
		const controller = new AbortController();

		const wait = waitForBrowserRun(() => false, controller.signal, { timeout: 50, interval: 10 });

		await expect(wait).rejects.toThrow("wait(predicate) timed out after 50ms");
	});

	it("rejects wait(predicate) when the run aborts mid-poll", async () => {
		vi.useRealTimers();
		const controller = new AbortController();

		const wait = waitForBrowserRun(() => false, controller.signal, { timeout: 5000 });
		controller.abort(new Error("browser run ended"));

		await expect(wait).rejects.toThrow("browser run ended");
	});

	it("rejects wait() input that is neither milliseconds nor a predicate", async () => {
		const controller = new AbortController();

		await expect(waitForBrowserRun("soon" as never, controller.signal)).rejects.toThrow(
			"wait(...) expects milliseconds (number) or a predicate function to poll",
		);
	});
});
