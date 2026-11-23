import { describe, expect, it } from "bun:test";
import { type AssistantMessage, isBillingCapUsageLimit, isUsageLimitOutcome } from "jeopi-ai";
import * as AIError from "jeopi-ai/error";

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("error-id classification", () => {
	it("composes timeout with transient", () => {
		const id = AIError.classify(new Error("provider stream stall timeout"), "anthropic-messages");
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Class)).toBe(true);
	});

	it("classifies OpenAI stream_read_error as transient", () => {
		const assistant = message({
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			errorMessage: "Error Code stream_read_error: stream_read_error",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("keeps provider content filters non-retryable", () => {
		const error = new AIError.ProviderResponseError("incomplete: content_filter", {
			provider: "openrouter",
			kind: "content-blocked",
		});
		const id = AIError.classify(error, "openai-responses");
		expect(AIError.is(id, AIError.Flag.ContentBlocked)).toBe(true);
		expect(AIError.is(id, AIError.Flag.ProviderFinishError)).toBe(false);
		expect(AIError.retriable(id)).toBe(false);
	});

	it("keeps raw status fallback unclassified", () => {
		const id = 503;
		expect(AIError.is(id, AIError.Flag.Class)).toBe(false);
		expect(id).toBe(503);
	});

	it("gates stale Responses replay errors by API", () => {
		const text = "Item with id 'resp_123' not found";
		const anthropicId = AIError.classify(new Error(text), "anthropic-messages");
		const responsesId = AIError.classify(new Error(text), "openai-responses");
		expect(AIError.is(anthropicId, AIError.Flag.StaleResponsesItem)).toBe(false);
		expect(AIError.is(responsesId, AIError.Flag.StaleResponsesItem)).toBe(true);
	});

	it("walks causes and preserves carried ids", () => {
		const inner = AIError.attach(new Error("inner"), AIError.create(AIError.Flag.ThinkingLoop));
		const outer = new Error("outer", { cause: inner });
		const id = AIError.classify(outer, "anthropic-messages");
		expect(AIError.is(id, AIError.Flag.ThinkingLoop)).toBe(true);
	});

	it("combines wrapper text classification with cause ids", () => {
		const cause = AIError.attach(new Error("quota reached"), AIError.create(AIError.Flag.UsageLimit));
		const outer = new Error("network stream stall", { cause });
		const id = AIError.classify(outer, "anthropic-messages");
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
	});

	it("upgrades a stamped status fallback after final error text exists", () => {
		const assistant = message({
			errorId: 503,
			errorStatus: 503,
			errorMessage: "usage limit reached",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Class)).toBe(true);
		expect(assistant.errorId).toBe(id);
	});

	it("merges existing cause-chain kinds with finalized error text kinds", () => {
		const assistant = message({
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
			errorMessage: "usage limit reached",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.ThinkingLoop)).toBe(true);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
		expect(assistant.errorId).toBe(id);
	});

	it("classifies inflected stream stall watchdogs as timeout + transient, except under terminal 4xx", () => {
		const id = AIError.classifyMessage(
			message({ errorMessage: "Anthropic stream stalled while waiting for the next event" }),
		);
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);

		const clientDenied = AIError.classifyMessage(
			message({ errorStatus: 400, errorMessage: "Anthropic stream stalled while waiting for the next event" }),
		);
		expect(AIError.is(clientDenied, AIError.Flag.Timeout)).toBe(false);
		expect(AIError.retriable(clientDenied)).toBe(false);
	});

	it("classifies mid-stream drops as retryable transient errors unless paired with terminal 4xx", () => {
		for (const errorMessage of [
			"stream disconnected before completion",
			"websocket closed before response.completed",
			"stream ended before message_stop",
		]) {
			const err = new Error(errorMessage);
			expect(AIError.isTransientStreamDropError(err)).toBe(true);
			expect(AIError.isProviderRetryableError(err)).toBe(true);
			const id = AIError.classifyMessage(message({ errorMessage }));
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
			expect(AIError.retriable(id)).toBe(true);
		}

		const badRequest = new AIError.ProviderHttpError("stream disconnected before completion", 400);
		expect(AIError.isProviderRetryableError(badRequest)).toBe(false);
		expect(AIError.retriable(AIError.classify(badRequest))).toBe(false);
	});

	it("classifies HTTP 402 billing caps as UsageLimit while leaving non-billing 402 and 400 untouched", () => {
		const billingJson = '{"error":{"type":"billing_error","message":"Account balance depleted"}}';
		expect(isUsageLimitOutcome(402, billingJson)).toBe(true);
		expect(isBillingCapUsageLimit(402, billingJson)).toBe(true);
		expect(AIError.isUsageLimit(new AIError.ProviderHttpError(billingJson, 402))).toBe(true);

		const billingVerification = "Billing verification failed for this account";
		expect(isUsageLimitOutcome(402, billingVerification)).toBe(true);
		expect(isUsageLimitOutcome(400, billingVerification)).toBe(false);

		const subscriptionOnly = "A subscription is required for this endpoint; your credits are unchanged";
		expect(isUsageLimitOutcome(402, subscriptionOnly)).toBe(false);
		expect(isBillingCapUsageLimit(402, subscriptionOnly)).toBe(false);
	});
});
