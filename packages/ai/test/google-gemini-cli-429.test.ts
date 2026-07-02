import { describe, expect, it } from "bun:test";
import { streamGoogleGeminiCli } from "jeopi-ai/providers/google-gemini-cli";
import type { Context, FetchImpl, Model } from "jeopi-ai/types";
import { buildModel } from "jeopi-catalog/build";
import { extractRetryHint } from "jeopi-utils";

// The fail-fast regex used inside the provider to distinguish "known quota errors" (throw immediately)
// from "ambiguous 429s" (retry up to RATE_LIMIT_BUDGET_MS).
// Option A (minimal): only hard quota limits fail-fast; transient rate-limit messages fall through to retry.
const FAIL_FAST_RE = /quota|exhausted/i;
const shouldFailFast = (errorText: string) => FAIL_FAST_RE.test(errorText);
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const cliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (CCA)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const individualQuotaBody = JSON.stringify({
	error: {
		code: 429,
		message:
			"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 28h48m25s.",
		status: "RESOURCE_EXHAUSTED",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.ErrorInfo",
				reason: "QUOTA_EXHAUSTED",
				domain: "cloudcode-pa.googleapis.com",
				metadata: {
					uiMessage: "true",
					model: "gemini-3-flash-agent",
					quotaResetDelay: "28h48m25.991228095s",
					quotaResetTimeStamp: "2026-07-03T18:44:59Z",
				},
			},
			{
				"@type": "type.googleapis.com/google.rpc.RetryInfo",
				retryDelay: "103705.991228095s",
			},
		],
	},
});

describe("google-gemini-cli 429 fail-fast detection", () => {
	it("fails fast on 'Quota exceeded' messages", () => {
		expect(shouldFailFast("Quota exceeded for project")).toBe(true);
	});

	it("fails fast on 'exhausted' messages", () => {
		expect(shouldFailFast("Resource has been exhausted")).toBe(true);
	});

	it("does not fail fast on ambiguous 429 ('Please retry in 5s')", () => {
		expect(shouldFailFast("Please retry in 5s")).toBe(false);
	});

	it("does not fail fast on generic rate-limit text", () => {
		expect(shouldFailFast("Rate limit exceeded, please slow down")).toBe(false);
	});

	it("matches case-insensitively", () => {
		expect(shouldFailFast("QUOTA EXCEEDED")).toBe(true);
		expect(shouldFailFast("Resource Has Been Exhausted")).toBe(true);
	});

	it("does not fail fast on empty error", () => {
		expect(shouldFailFast("")).toBe(false);
	});
});

describe("extractRetryHint – header parsing", () => {
	it("reads retry-after header as seconds", () => {
		const headers = new Headers({ "retry-after": "5" });
		expect(extractRetryHint(headers)).toBe(5_000);
	});

	it("reads x-ratelimit-reset-after header as seconds", () => {
		const headers = new Headers({ "x-ratelimit-reset-after": "30" });
		expect(extractRetryHint(headers)).toBe(30_000);
	});

	it("prefers retry-after over x-ratelimit-reset-after when both are present", () => {
		const headers = new Headers({ "retry-after": "5", "x-ratelimit-reset-after": "30" });
		expect(extractRetryHint(headers)).toBe(5_000);
	});
});

describe("extractRetryHint – body text parsing", () => {
	it("parses 'retryDelay' JSON field in seconds", () => {
		expect(extractRetryHint(undefined, '"retryDelay": "3s"')).toBe(3_000);
	});

	it("parses 'retryDelay' JSON field in milliseconds", () => {
		expect(extractRetryHint(undefined, '"retryDelay": "500ms"')).toBe(500);
	});

	it("parses 'Please retry in Xs' pattern", () => {
		expect(extractRetryHint(undefined, "Please retry in 5s")).toBe(5_000);
	});

	it("parses 'quota will reset after Xs' simple duration", () => {
		expect(extractRetryHint(undefined, "Your quota will reset after 39s")).toBe(39_000);
	});

	it("parses compound duration 'reset after 1h30m10s'", () => {
		expect(extractRetryHint(undefined, "Your quota will reset after 1h30m10s")).toBe(5_410_000);
	});
	it("parses Cloud Code Assist 'Resets in' quota text", () => {
		expect(extractRetryHint(undefined, "Individual quota reached. Resets in 28h48m25s.")).toBe(103_705_000);
	});

	it("parses Cloud Code Assist quotaResetDelay metadata", () => {
		expect(extractRetryHint(undefined, '"quotaResetDelay":"28h48m25.991228095s"')).toBeCloseTo(103_705_991.228095);
	});

	it("parses Codex-style 'try again in Xms'", () => {
		expect(extractRetryHint(undefined, "try again in 250ms")).toBe(250);
	});

	it("parses Codex-style 'try again in Xs'", () => {
		expect(extractRetryHint(undefined, "try again in 12s")).toBe(12_000);
	});

	it("parses Codex 'Try again in ~X min.' (usage_limit_reached friendly text)", () => {
		// Verbatim shape Codex's parseCodexError builds when usage_limit_reached
		// arrives with a `resets_at` minutes-out reset time. Used to fall
		// through to undefined → the gateway and TUI both had no retry-after
		// signal to honour, so they defaulted to QUOTA_EXHAUSTED's 30-min
		// blanket and rotated immediately even when the actual reset window
		// was much longer.
		expect(extractRetryHint(undefined, "Try again in ~158 min.")).toBe(158 * 60_000);
	});

	it("parses 'try again in X min' / 'X minutes' without the tilde", () => {
		expect(extractRetryHint(undefined, "try again in 5 min")).toBe(5 * 60_000);
		expect(extractRetryHint(undefined, "try again in 90 minutes")).toBe(90 * 60_000);
	});

	it("parses 'try again in X h' / 'X hour' / 'X hours'", () => {
		expect(extractRetryHint(undefined, "try again in 2 h")).toBe(2 * 60 * 60_000);
		expect(extractRetryHint(undefined, "try again in 1 hour")).toBe(60 * 60_000);
		expect(extractRetryHint(undefined, "try again in 3 hours")).toBe(3 * 60 * 60_000);
	});

	it("returns undefined when body contains no recognised delay pattern", () => {
		expect(extractRetryHint(undefined, "Quota exceeded, please try again later")).toBeUndefined();
	});

	it("returns undefined for empty error string and no headers", () => {
		expect(extractRetryHint(undefined, "")).toBeUndefined();
	});
});

describe("google-gemini-cli quota error formatting", () => {
	it("formats Individual quota 429s as actionable reset messages instead of raw JSON", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return new Response(individualQuotaBody, {
				status: 429,
				headers: { "content-type": "application/json" },
			});
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123", email: "user@example.com" }),
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain(
			"Cloud Code Assist API error (429): Cloud Code Assist quota exhausted for gemini-3-flash-agent on user@example.com.",
		);
		expect(result.errorMessage).toContain("Individual quota reached.");
		expect(result.errorMessage).toContain("Your quota will reset after 28h48m25.991228095s (2026-07-03T18:44:59Z).");
		expect(result.errorMessage).toContain("Add another Google account with /login");
		expect(result.errorMessage).not.toContain('"details"');
	});

	it("formats Individual quota 429s with literal newlines in the message field", async () => {
		let calls = 0;
		const bodyWithNewline = `{
  "error": {
    "code": 429,
    "message": "Individual quota reached. Please upgrade your subscription to increase your\n limits. Resets in 28h48m25s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "QUOTA_EXHAUSTED",
        "domain": "cloudcode-pa.googleapis.com",
        "metadata": {
          "uiMessage": "true",
          "model": "gemini-3-flash-agent",
          "quotaResetDelay": "28h48m25.991228095s",
          "quotaResetTimeStamp": "2026-07-03T18:44:59Z"
        }
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "103705.991228095s"
      }
    ]
  }
}`.replace("\\n", "\n"); // Force a literal newline inside the message string

		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return new Response(bodyWithNewline, {
				status: 429,
				headers: { "content-type": "application/json" },
			});
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123", email: "user@example.com" }),
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain(
			"Cloud Code Assist API error (429): Cloud Code Assist quota exhausted for gemini-3-flash-agent on user@example.com.",
		);
		expect(result.errorMessage).toContain("Individual quota reached.");
		expect(result.errorMessage).toContain("Your quota will reset after 28h48m25.991228095s (2026-07-03T18:44:59Z).");
		expect(result.errorMessage).toContain("Add another Google account with /login");
		expect(result.errorMessage).not.toContain('"details"');
	});
});
