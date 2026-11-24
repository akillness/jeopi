import { describe, expect, it } from "bun:test";
import { classify, Flag, isUsageLimit } from "jeopi-ai/error/flags";
import {
	calculateRateLimitBackoffMs,
	isBillingCapUsageLimit,
	isUsageLimitOutcome,
	isUsageLimitStatus,
	parseRateLimitReason,
} from "jeopi-ai/error/rate-limit";
import { isProviderRetryableError } from "jeopi-ai/error/retryable";
import { getShouldRetryFromHeaders } from "jeopi-ai/utils/retry-after";

describe("parseRateLimitReason", () => {
	it("classifies Google Quota exceeded as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Cloud Code Assist API error (429): Quota exceeded for aiplatform.googleapis.com"),
		).toBe("QUOTA_EXHAUSTED");
	});

	// "Resource has been exhausted (e.g. check quota)" is a quota/daily-limit error — long wait.
	// Only the literal phrase "resource exhausted" (gRPC status name) is MODEL_CAPACITY.
	it("classifies 'Resource has been exhausted (e.g. check quota)' as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Cloud Code Assist API error (429): Resource has been exhausted (e.g. check quota)."),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies 'resource exhausted' (exact gRPC phrase) as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("resource exhausted")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	it("classifies Too many requests as RATE_LIMIT_EXCEEDED", () => {
		expect(parseRateLimitReason("Cloud Code Assist API error (429): Too many requests")).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("classifies per minute errors as RATE_LIMIT_EXCEEDED", () => {
		expect(parseRateLimitReason("Requests per minute limit reached")).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("classifies overloaded 529 as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("Service overloaded 529")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	it("classifies internal server error as SERVER_ERROR", () => {
		expect(parseRateLimitReason("Internal Server Error (500)")).toBe("SERVER_ERROR");
	});

	it("returns UNKNOWN for unrecognised messages", () => {
		expect(parseRateLimitReason("Something completely unexpected happened")).toBe("UNKNOWN");
	});

	it("classifies Codex usage limit error as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Codex error event: The usage limit has been reached (code=usage_limit_reached)"),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies account rate limits as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies OpenCode Go insufficient balance as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("401 Insufficient balance. Manage your billing here: https://opencode.ai/workspace/demo"),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies Antigravity capacity-exhausted as QUOTA_EXHAUSTED, not transient MODEL_CAPACITY", () => {
		// Antigravity returns "You have exhausted your capacity on this model. Your
		// quota will reset after 3h6m38s." The literal "capacity" used to win the
		// classifier race and land in MODEL_CAPACITY_EXHAUSTED (45-75s backoff),
		// blocking the agent from rotating to another OAuth account even though the
		// "quota will reset" suffix is the long-wait, switch-account signal.
		expect(
			parseRateLimitReason(
				"Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h6m38s.",
			),
		).toBe("QUOTA_EXHAUSTED");
	});
});

describe("isUsageLimit", () => {
	it("detects account rate limits as credential-rotatable usage limits", () => {
		expect(
			isUsageLimit(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			),
		).toBe(true);
	});

	it("detects OpenCode Go insufficient balance as a credential-rotatable usage limit", () => {
		expect(
			isUsageLimit("401 Insufficient balance. Manage your billing here: https://opencode.ai/workspace/demo"),
		).toBe(true);
	});

	it("detects Antigravity capacity-exhausted message as a usage-limit error", () => {
		// Without this branch `markUsageLimitReached` is never invoked, so the
		// session sticks to the exhausted OAuth account instead of rotating —
		// see `agent-session.ts` line 8314 and `auth-storage.ts` line 3457.
		expect(
			isUsageLimit(
				"Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h6m38s.",
			),
		).toBe(true);
	});

	// Antigravity / Cloud Code Assist returns this phrasing for an exhausted
	// project quota; `parseRateLimitReason` already maps it to QUOTA_EXHAUSTED
	// via the generic `quota` substring, but `isUsageLimitError` decides
	// whether the auth layer rotates to a sibling OAuth credential, so it
	// must match too — otherwise the session stays pinned to the exhausted
	// account (see issue #2198).
	it("detects Antigravity 'Individual quota reached' as a credential-rotatable usage limit", () => {
		expect(
			isUsageLimit(
				"Cloud Code Assist API error (429): Individual quota reached. Contact your administrator to enable overages.",
			),
		).toBe(true);
	});

	it("detects bare 'quota reached' phrasing", () => {
		expect(isUsageLimit("quota reached")).toBe(true);
		expect(isUsageLimit("quota_reached")).toBe(true);
	});

	it("detects OpenAI quota payload codes as credential-rotatable usage limits", () => {
		for (const message of ["insufficient_quota", "usage_limit_exceeded", "usage_limit_reached"]) {
			expect(isUsageLimit(message)).toBe(true);
		}
		expect(isUsageLimitStatus(429)).toBe(true);
		expect(isUsageLimitStatus(400)).toBe(false);
	});
});

describe("isUsageLimitOutcome", () => {
	it("rotates on bare/opaque 429 bodies (status-only fallback)", () => {
		expect(isUsageLimitOutcome(429, undefined)).toBe(true);
		expect(isUsageLimitOutcome(429, "")).toBe(true);
		expect(isUsageLimitOutcome(429, "429")).toBe(true);
		expect(isUsageLimitOutcome(429, "HTTP 429")).toBe(true);
		expect(isUsageLimitOutcome(429, "Error 429")).toBe(true);
		expect(isUsageLimitOutcome(429, "{}")).toBe(true);
	});

	it("rotates on 429 carrying quota payload codes", () => {
		for (const message of ["insufficient_quota", "usage_limit_exceeded", "usage_limit_reached"]) {
			expect(isUsageLimitOutcome(429, message)).toBe(true);
		}
	});

	it("keeps informative transient 429s in the upstream-backoff lane", () => {
		// RATE_LIMIT_EXCEEDED — generic throttling.
		expect(isUsageLimitOutcome(429, "Cloud Code Assist API error (429): Too many requests")).toBe(false);
		expect(isUsageLimitOutcome(429, "Requests per minute limit reached")).toBe(false);
		// MODEL_CAPACITY_EXHAUSTED — provider overload, not account quota.
		expect(isUsageLimitOutcome(429, "Service overloaded 529")).toBe(false);
		// UNKNOWN but carries a transient retry hint — body is informative,
		// so we defer to parseRateLimitReason and stay out of the quota lane.
		expect(isUsageLimitOutcome(429, "Please retry in 5s")).toBe(false);
	});

	it("still rotates on 429 with explicit account rate-limit framing", () => {
		expect(
			isUsageLimitOutcome(
				429,
				'{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			),
		).toBe(true);
	});

	it("rotates on usage-limit message regardless of status", () => {
		expect(isUsageLimitOutcome(undefined, "usage_limit_reached")).toBe(true);
		expect(isUsageLimitOutcome(500, "insufficient_quota")).toBe(true);
	});

	it("does not rotate on auth/invalid-request statuses with unrelated bodies", () => {
		expect(isUsageLimitOutcome(401, "Invalid API key")).toBe(false);
		expect(isUsageLimitOutcome(400, "invalid_request_error: model unsupported")).toBe(false);
	});
});

describe("calculateRateLimitBackoffMs", () => {
	it("returns 45–75s range for MODEL_CAPACITY_EXHAUSTED (jitter)", () => {
		for (let i = 0; i < 20; i++) {
			const ms = calculateRateLimitBackoffMs("MODEL_CAPACITY_EXHAUSTED");
			expect(ms).toBeGreaterThanOrEqual(45_000);
			expect(ms).toBeLessThanOrEqual(75_000);
		}
	});
});

describe("upstream rate-limit and retryability guards", () => {
	it("treats OpenRouter 402 in-flight credit reservations as non-billing-cap", () => {
		const msg =
			"This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.";
		expect(isBillingCapUsageLimit(402, msg)).toBe(false);
		expect(isBillingCapUsageLimit(402, "Insufficient credits. Add more credits to continue.")).toBe(true);
	});

	it("classifies structured Google RPC RESOURCE_EXHAUSTED bodies accurately", () => {
		const capacityErr = `Cloud Code Assist API error (429): ${JSON.stringify({
			error: {
				status: "RESOURCE_EXHAUSTED",
				message: "No capacity available for model",
				details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "MODEL_CAPACITY_EXHAUSTED" }],
			},
		})}`;
		expect(parseRateLimitReason(capacityErr)).toBe("MODEL_CAPACITY_EXHAUSTED");
		expect(isUsageLimitOutcome(429, capacityErr)).toBe(false);

		const g1CreditsErr = JSON.stringify({
			error: {
				status: "RESOURCE_EXHAUSTED",
				details: [
					{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "INSUFFICIENT_G1_CREDITS_BALANCE" },
				],
			},
		});
		expect(parseRateLimitReason(g1CreditsErr)).toBe("INSUFFICIENT_G1_CREDITS_BALANCE");
		expect(isUsageLimitOutcome(429, g1CreditsErr)).toBe(true);
		expect(isBillingCapUsageLimit(429, g1CreditsErr)).toBe(true);
	});

	it("excludes concurrency limits and DashScope token-limit TPM throttles from account usage limits", () => {
		const concurrent = "HTTP 429: too many concurrent requests for this key";
		expect(parseRateLimitReason(concurrent)).toBe("CONCURRENT_LIMIT");
		expect(isUsageLimitOutcome(429, concurrent)).toBe(false);
		expect((classify(new Error(concurrent)) & Flag.Transient) !== 0).toBe(true);
		expect((classify(new Error(concurrent)) & Flag.UsageLimit) !== 0).toBe(false);

		const dashscope =
			"You exceeded your current quota, please check your plan and billing details (https://help.aliyun.com/error-code#token-limit)";
		expect(parseRateLimitReason(dashscope)).toBe("RATE_LIMIT_EXCEEDED");
		expect(isUsageLimitOutcome(429, dashscope)).toBe(false);
		expect(isBillingCapUsageLimit(429, dashscope)).toBe(false);
	});

	it("honors x-should-retry headers and classifies Aliyun MM 400 and Codex body read errors as retryable", () => {
		expect(getShouldRetryFromHeaders({ "x-should-retry": "false" })).toBe(false);
		expect(getShouldRetryFromHeaders({ "X-Should-Retry": "true" })).toBe(true);

		const nonRetryable500 = Object.assign(new Error("500 Internal Server Error"), {
			status: 500,
			headers: { "x-should-retry": "false" },
		});
		expect(isProviderRetryableError(nonRetryable500)).toBe(false);

		const aliyun400 = Object.assign(new Error("400 Failed to download multimodal content"), { status: 400 });
		expect(isProviderRetryableError(aliyun400)).toBe(true);
		expect((classify(aliyun400) & Flag.Transient) !== 0).toBe(true);

		const codexBody = new Error("error occurred while reading the response body");
		expect(isProviderRetryableError(codexBody)).toBe(true);
		expect((classify(codexBody) & Flag.Transient) !== 0).toBe(true);
	});
});
