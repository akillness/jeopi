import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "jeopi-agent-core";
import { type AdvisorAgent, AdvisorRuntime, isPermanentAdvisorError } from "jeopi-cli/advisor/runtime";

function makeUserMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

describe("isPermanentAdvisorError", () => {
	it("identifies permanent model/auth errors and ignores transient ones", () => {
		expect(
			isPermanentAdvisorError(new Error('404 {"error":{"type":"not_found_error","message":"model: foo"}}')),
		).toBe(true);
		expect(isPermanentAdvisorError("model_not_found: gpt-nonexistent")).toBe(true);
		expect(isPermanentAdvisorError("401 invalid_api_key")).toBe(true);
		expect(isPermanentAdvisorError("403 permission_error")).toBe(true);
		expect(isPermanentAdvisorError("429 rate_limit_exceeded")).toBe(false);
		expect(isPermanentAdvisorError("503 overloaded_error")).toBe(false);
		expect(isPermanentAdvisorError("stream stalled while waiting")).toBe(false);
	});
});

describe("AdvisorRuntime permanent error circuit breaker", () => {
	it("disables permanently after a 404 model error, skips subsequent turns, and re-enables on reset()", async () => {
		let promptCalls = 0;
		const notifiedErrors: unknown[] = [];
		const messages: AgentMessage[] = [makeUserMessage("turn 1", 100)];
		let failWith404 = true;

		const state: AdvisorAgent["state"] = { messages: [], model: { id: "claude-opus-missing" } };
		const agent: AdvisorAgent = {
			state,
			prompt: async () => {
				promptCalls++;
				if (failWith404) {
					state.error =
						'404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-missing"}}';
				} else {
					state.error = undefined;
				}
			},
			abort: () => {},
			reset: () => {
				state.messages = [];
				state.error = undefined;
			},
			rollbackTo: count => {
				state.messages.length = count;
			},
		};

		const runtime = new AdvisorRuntime(agent, {
			snapshotMessages: () => messages,
			enqueueAdvice: () => {},
			notifyFailure: error => {
				notifiedErrors.push(error);
			},
		});

		// Turn 1 hits 404 -> permanently disables runtime after single attempt.
		runtime.onTurnEnd(messages);
		await runtime.waitForCatchup(1_000, 1);

		expect(promptCalls).toBe(1);
		expect(runtime.isPermanentlyDisabled).toBe(true);
		expect(notifiedErrors).toHaveLength(1);

		// Subsequent turns do not retry the broken model and waitForCatchup returns immediately.
		messages.push(makeUserMessage("turn 2", 200));
		runtime.onTurnEnd(messages);
		messages.push(makeUserMessage("turn 3", 300));
		runtime.onTurnEnd(messages);
		await runtime.waitForCatchup(1_000, 1);

		expect(promptCalls).toBe(1);
		expect(notifiedErrors).toHaveLength(1);

		// reset() clears the latch (e.g. after switching to a valid advisor model).
		failWith404 = false;
		runtime.reset();
		expect(runtime.isPermanentlyDisabled).toBe(false);

		messages.push(makeUserMessage("turn 4", 400));
		runtime.onTurnEnd(messages);
		await runtime.waitForCatchup(1_000, 1);

		expect(promptCalls).toBe(2);
		runtime.dispose();
	});
});
