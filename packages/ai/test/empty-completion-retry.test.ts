/**
 * Contracts for `withEmptyCompletionRetry` (shared by the OpenAI-completions and
 * Anthropic-messages providers): a benign terminal stop with no content/usage is
 * retried a bounded number of times; once any content streams the attempt is
 * committed (no retry, no duplicate `start`); the cap delivers the empty result;
 * backoff failures surface unless the caller aborted.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Context, Usage } from "jeopi-ai/types";
import {
	MAX_EMPTY_COMPLETION_RETRIES,
	transportExhaustedMessages,
	withEmptyCompletionRetry,
	withReplaySafeStreamRetry,
} from "jeopi-ai/utils/empty-completion-retry";
import { AssistantMessageEventStream } from "jeopi-ai/utils/event-stream";

const CTX = {} as Context;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(texts: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: texts.map(text => ({ type: "text" as const, text })),
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
	};
}

function streamFromEvents(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	for (const event of events) stream.push(event);
	return stream;
}

/** start + stop with no content/usage — the flaky-gateway empty completion. */
function emptyAttempt(): AssistantMessageEventStream {
	const message = assistant();
	return streamFromEvents([
		{ type: "start", partial: message },
		{ type: "done", reason: "stop", message },
	] as unknown as AssistantMessageEvent[]);
}

function contentAttempt(): AssistantMessageEventStream {
	const message = assistant(["hello"]);
	return streamFromEvents([
		{ type: "start", partial: message },
		{ type: "text_start", contentIndex: 0, partial: message },
		{ type: "text_delta", contentIndex: 0, delta: "hello", partial: message },
		{ type: "text_end", contentIndex: 0, content: "hello", partial: message },
		{ type: "done", reason: "stop", message },
	] as unknown as AssistantMessageEvent[]);
}

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("withEmptyCompletionRetry", () => {
	it("retries past empty attempts and delivers the first non-empty one", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const stream = withEmptyCompletionRetry({}, CTX, { providerRetryWait: async ms => void waits.push(ms) }, () => {
			attempts++;
			return attempts <= MAX_EMPTY_COMPLETION_RETRIES ? emptyAttempt() : contentAttempt();
		});

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(MAX_EMPTY_COMPLETION_RETRIES + 1);
		expect(waits).toHaveLength(MAX_EMPTY_COMPLETION_RETRIES);
		// Discarded attempts' `start` events must not leak — exactly one survives.
		expect(events.filter(e => e.type === "start")).toHaveLength(1);
		expect(events.some(e => e.type === "text_delta")).toBe(true);
		expect(events.at(-1)?.type).toBe("done");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("delivers the empty result after exhausting the retry cap", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const stream = withEmptyCompletionRetry({}, CTX, { providerRetryWait: async ms => void waits.push(ms) }, () => {
			attempts++;
			return emptyAttempt();
		});

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(MAX_EMPTY_COMPLETION_RETRIES + 1);
		expect(waits).toHaveLength(MAX_EMPTY_COMPLETION_RETRIES);
		expect(events.filter(e => e.type === "start")).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("done");
		expect(result.content).toEqual([]);
	});

	it("does not retry when the first attempt streams content", async () => {
		let attempts = 0;
		let waited = false;
		const stream = withEmptyCompletionRetry(
			{},
			CTX,
			{
				providerRetryWait: async () => {
					waited = true;
				},
			},
			() => {
				attempts++;
				return contentAttempt();
			},
		);

		await drain(stream);

		expect(attempts).toBe(1);
		expect(waited).toBe(false);
	});

	it("commits on streamed thinking and does not retry a thinking-only stop", async () => {
		let attempts = 0;
		const stream = withEmptyCompletionRetry({}, CTX, {}, () => {
			attempts++;
			const message = assistant(); // no visible content; only thinking streams
			return streamFromEvents([
				{ type: "start", partial: message },
				{ type: "thinking_delta", contentIndex: 0, delta: "pondering", partial: message },
				{ type: "done", reason: "stop", message },
			] as unknown as AssistantMessageEvent[]);
		});

		const events = await drain(stream);

		expect(attempts).toBe(1);
		expect(events.some(e => e.type === "thinking_delta")).toBe(true);
	});

	it("propagates a non-abort backoff failure instead of masking the empty result", async () => {
		const stream = withEmptyCompletionRetry(
			{},
			CTX,
			{
				providerRetryWait: async () => {
					throw new Error("wait boom");
				},
			},
			() => emptyAttempt(),
		);

		let caught: unknown;
		try {
			await drain(stream);
		} catch (error) {
			caught = error;
		}
		expect((caught as Error | undefined)?.message).toBe("wait boom");
	});

	it("delivers the empty result when aborted during backoff", async () => {
		const controller = new AbortController();
		let attempts = 0;
		const stream = withEmptyCompletionRetry(
			{},
			CTX,
			{
				signal: controller.signal,
				providerRetryWait: async () => {
					controller.abort();
					throw new Error("aborted");
				},
			},
			() => {
				attempts++;
				return emptyAttempt();
			},
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(1);
		expect(events.at(-1)?.type).toBe("done");
		expect(result.content).toEqual([]);
	});

	it("discards buffered pre-content markers from a retried empty attempt", async () => {
		let attempts = 0;
		const stream = withEmptyCompletionRetry({}, CTX, { providerRetryWait: async () => {} }, () => {
			attempts++;
			if (attempts === 1) {
				const message = assistant();
				return streamFromEvents([
					{ type: "start", partial: message },
					{ type: "thinking_start", contentIndex: 0, partial: message },
					{ type: "done", reason: "stop", message },
				] as unknown as AssistantMessageEvent[]);
			}
			return contentAttempt();
		});

		const events = await drain(stream);

		expect(attempts).toBe(2);
		// The empty attempt's start + thinking_start were discarded; only the
		// successful attempt's events reach the consumer.
		expect(events.filter(e => e.type === "start")).toHaveLength(1);
		expect(events.some(e => e.type === "thinking_start")).toBe(false);
		expect(events.some(e => e.type === "text_delta")).toBe(true);
	});

	it("streams content as it arrives without waiting for the terminal event", async () => {
		let waited = false;
		const message = assistant(["streamed"]);
		const inner = new AssistantMessageEventStream();
		const stream = withEmptyCompletionRetry(
			{},
			CTX,
			{
				providerRetryWait: async () => {
					waited = true;
				},
			},
			() => inner,
		);

		const iterator = stream[Symbol.asyncIterator]();
		// Push content with no terminal yet: the buffered start then the delta must
		// surface before any `done` exists, proving the wrapper does not buffer
		// meaningful content until completion.
		inner.push({ type: "start", partial: message } as unknown as AssistantMessageEvent);
		inner.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "streamed",
			partial: message,
		} as unknown as AssistantMessageEvent);

		expect((await iterator.next()).value?.type).toBe("start");
		expect((await iterator.next()).value?.type).toBe("text_delta");

		inner.push({ type: "done", reason: "stop", message } as unknown as AssistantMessageEvent);
		expect((await iterator.next()).value?.type).toBe("done");
		expect(waited).toBe(false);
	});
});

describe("withReplaySafeStreamRetry guards", () => {
	it("does not prematurely commit on toolcall_start before argument delta arrives", async () => {
		let attempts = 0;
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async () => {} },
			() => {
				attempts++;
				if (attempts === 1) {
					const empty = assistant();
					const err: AssistantMessage = {
						...empty,
						stopReason: "error",
						errorMessage: "Stream ended without a finish reason",
					};
					return streamFromEvents([
						{ type: "start", partial: empty },
						{ type: "toolcall_start", contentIndex: 0, partial: empty },
						{ type: "error", reason: "error", error: err },
					] as unknown as AssistantMessageEvent[]);
				}
				return contentAttempt();
			},
			{ retryProviderErrors: true, maxProviderErrorRetries: 1 },
		);

		const events = await drain(stream);
		const result = await stream.result();
		expect(attempts).toBe(2);
		expect(events.some(e => e.type === "toolcall_start")).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("skips provider-error replay when message is marked in transportExhaustedMessages", async () => {
		let attempts = 0;
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async () => {} },
			() => {
				attempts++;
				const err: AssistantMessage = {
					...assistant(),
					stopReason: "error",
					errorStatus: 503,
					errorMessage: "503 Service Unavailable",
				};
				transportExhaustedMessages.add(err);
				return streamFromEvents([
					{ type: "error", reason: "error", error: err },
				] as unknown as AssistantMessageEvent[]);
			},
			{ retryProviderErrors: true, maxProviderErrorRetries: 2 },
		);

		const result = await stream.result();
		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("does not retry pause_turn stops or when acceptEmptyResponse is true", async () => {
		let pauseAttempts = 0;
		const pauseStream = withEmptyCompletionRetry({}, CTX, { providerRetryWait: async () => {} }, () => {
			pauseAttempts++;
			const message: AssistantMessage = {
				...assistant(),
				stopDetails: { type: "pause_turn" },
			};
			return streamFromEvents([{ type: "done", reason: "stop", message }] as unknown as AssistantMessageEvent[]);
		});
		await drain(pauseStream);
		expect(pauseAttempts).toBe(1);

		let acceptAttempts = 0;
		const acceptStream = withEmptyCompletionRetry(
			{},
			CTX,
			{ providerRetryWait: async () => {}, acceptEmptyResponse: true },
			() => {
				acceptAttempts++;
				const message = assistant();
				return streamFromEvents([{ type: "done", reason: "stop", message }] as unknown as AssistantMessageEvent[]);
			},
		);
		await drain(acceptStream);
		expect(acceptAttempts).toBe(1);
	});

	it("surfaces synchronous attempt() throws cleanly via outer stream", async () => {
		const stream = withEmptyCompletionRetry({}, CTX, { providerRetryWait: async () => {} }, () => {
			throw new Error("sync transport init failure");
		});
		await expect(stream.result()).rejects.toThrow("sync transport init failure");
	});

	it("still retries transient provider errors when acceptEmptyResponse is true", async () => {
		let attempts = 0;
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ acceptEmptyResponse: true, providerRetryWait: async () => {} },
			() => {
				attempts++;
				if (attempts === 1) {
					const err: AssistantMessage = {
						...assistant(),
						stopReason: "error",
						errorMessage: "Stream ended without a finish reason",
					};
					return streamFromEvents([
						{ type: "error", reason: "error", error: err },
					] as unknown as AssistantMessageEvent[]);
				}
				return contentAttempt();
			},
			{ retryEmptyCompletion: true, retryProviderErrors: true, maxProviderErrorRetries: 1 },
		);
		const result = await stream.result();
		expect(attempts).toBe(2);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});
});
