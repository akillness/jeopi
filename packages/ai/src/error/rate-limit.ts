/**
 * Rate limit reason classification and backoff calculation utilities.
 * Ported from opencode-antigravity-auth plugin for consistency.
 */

export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMIT_EXCEEDED"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000; // 30s
const MODEL_CAPACITY_BASE_MS = 45 * 1000; // 45s base
const MODEL_CAPACITY_JITTER_MS = 30 * 1000; // ±15s
const SERVER_ERROR_BACKOFF_MS = 20 * 1000; // 20s

const ACCOUNT_RATE_LIMIT_PATTERN =
	/\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const INSUFFICIENT_BALANCE_PATTERN = /insufficient.?balance/i;

/**
 * Classify a rate-limit error message into a reason category.
 * Priority order: QUOTA (Antigravity "quota will reset") > MODEL_CAPACITY > QUOTA (account) >
 * RATE_LIMIT > QUOTA (generic) > SERVER_ERROR > UNKNOWN.
 *
 * "resource exhausted" maps to MODEL_CAPACITY (transient, short wait)
 * "quota exceeded" / "quota will reset" maps to QUOTA_EXHAUSTED (long wait, switch account)
 */
export function parseRateLimitReason(errorMessage: string): RateLimitReason {
	const lower = errorMessage.toLowerCase();

	// Antigravity / Cloud Code Assist surface multi-hour daily-quota exhaustion as
	// "You have exhausted your capacity on this model. Your quota will reset after …".
	// The literal "capacity" used to pre-empt the QUOTA branch even though "quota
	// will reset" is the long-wait signal — short-circuit here before the
	// MODEL_CAPACITY fallthrough so credential rotation (not 60s backoff) kicks in.
	if (lower.includes("quota will reset") || lower.includes("exhausted your capacity")) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("capacity") ||
		lower.includes("overloaded") ||
		lower.includes("529") ||
		lower.includes("503") ||
		lower.includes("resource exhausted")
	) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("per minute") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("presque")
	) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (
		lower.includes("exhausted") ||
		lower.includes("quota") ||
		lower.includes("usage limit") ||
		INSUFFICIENT_BALANCE_PATTERN.test(errorMessage)
	) {
		return "QUOTA_EXHAUSTED";
	}

	if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) {
		return "SERVER_ERROR";
	}

	return "UNKNOWN";
}

/**
 * Calculate backoff delay in ms for a given rate limit reason.
 * MODEL_CAPACITY gets jitter to prevent thundering herd.
 */
export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
	switch (reason) {
		case "QUOTA_EXHAUSTED":
			return QUOTA_EXHAUSTED_BACKOFF_MS;
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
		case "MODEL_CAPACITY_EXHAUSTED":
			return MODEL_CAPACITY_BASE_MS + Math.random() * MODEL_CAPACITY_JITTER_MS;
		case "SERVER_ERROR":
			return SERVER_ERROR_BACKOFF_MS;
		default:
			return QUOTA_EXHAUSTED_BACKOFF_MS; // conservative default
	}
}

/** Detect usage/quota limit errors in error messages (persistent, requires credential switch). */
const USAGE_LIMIT_PATTERN =
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|exhaust(?:ed|ion)?|insufficient)|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|insufficient_g1_credits_balance/i;

const OUT_OF_CREDIT_PATTERN = /\bout of credit|\badd (?:more )?credit|\btop ?up\b|\bcredit balance\b/i;
const CREDITS_EXHAUSTED_PATTERN = /\bcredits?\s+(?:are\s+)?(?:exhausted|depleted|unavailable)\b/i;
const SPEND_LIMIT_PATTERN = /\bspending[- _]?limit\b/i;

const STATUS_402_QUOTA_PATTERN =
	/\b(?:payment(?:\s+is)?[-_.\s]*required|deactivated_workspace|insufficient.?(?:balance|credits?|account.?funds)|requires?\s+more\s+credits|billing[-_.\s]*(?:verification|error|issue)|can only afford)\b/i;

// Machine fields survive provider parsing even when the human detail is generic.
const BILLING_ERROR_CODE_PATTERN = /^billing_(?:error|not_configured)$/i;
const BILLING_ERROR_FIELD_PATTERN = /\b(?:type|code|param)=billing_(?:error|not_configured)(?=[\s)]|$)/i;

function parseJsonBody(message: string): Record<string, unknown> | undefined {
	const start = message.indexOf("{");
	if (start === -1) return undefined;
	try {
		const parsed: unknown = JSON.parse(message.slice(start));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * HTTP status codes that, absent richer body classification, represent an
 * account-local usage cap rather than a bad credential or a transient blip.
 * HTTP 402 Payment Required represents an account-billing cap when opaque,
 * payment/deactivation/balance/funds/billing-error-worded, or QUOTA_EXHAUSTED.
 * Always combine with {@link isUsageLimitOutcome} when a message is available.
 */
export function isUsageLimitStatus(status: number | undefined): boolean {
	return status === 429 || status === 402;
}

export function is402BillingCapBody(message: string | undefined): boolean {
	if (message === undefined || isOpaqueStatusBody(message)) return true;
	if (BILLING_ERROR_CODE_PATTERN.test(message) || BILLING_ERROR_FIELD_PATTERN.test(message)) return true;
	const body = parseJsonBody(message);
	const errorObj =
		body?.error && typeof body.error === "object" && !Array.isArray(body.error)
			? (body.error as Record<string, unknown>)
			: body;
	if (
		[errorObj?.type, errorObj?.code, errorObj?.param].some(
			value => typeof value === "string" && BILLING_ERROR_CODE_PATTERN.test(value),
		)
	) {
		return true;
	}
	if (STATUS_402_QUOTA_PATTERN.test(message)) return true;
	return parseRateLimitReason(message) === "QUOTA_EXHAUSTED";
}

/**
 * True when a usage-limit failure reflects a billing/credit cap (cannot recover
 * by waiting out a short quota reset window).
 */
export function isBillingCapUsageLimit(status: number | undefined, message: string | undefined): boolean {
	if (message === undefined) return false;
	if (status === 402) return is402BillingCapBody(message);
	return (
		/\binsufficient_g1_credits_balance\b/i.test(message) ||
		OUT_OF_CREDIT_PATTERN.test(message) ||
		INSUFFICIENT_BALANCE_PATTERN.test(message) ||
		CREDITS_EXHAUSTED_PATTERN.test(message) ||
		SPEND_LIMIT_PATTERN.test(message) ||
		/\binsufficient_quota\b/i.test(message)
	);
}

/**
 * Returns true for failures that should burn one credential and rotate to a
 * sibling account. Decision tree:
 *
 *  1. Status 402 → delegate to {@link is402BillingCapBody}.
 *  2. Body matches {@link matchesUsageLimitText} → rotate.
 *  3. Status is not 429/402 → backoff (caller's domain).
 *  4. Body is absent or {@link isOpaqueStatusBody opaque} → rotate conservatively.
 *  5. Body has content → defer to {@link parseRateLimitReason}. Only
 *     `QUOTA_EXHAUSTED` rotates.
 */
export function isUsageLimitOutcome(status: number | undefined, message: string | undefined): boolean {
	if (status === 402) return is402BillingCapBody(message);
	if (message && matchesUsageLimitText(message)) return true;
	if (!isUsageLimitStatus(status)) return false;
	if (!message || isOpaqueStatusBody(message)) return true;
	return parseRateLimitReason(message) === "QUOTA_EXHAUSTED";
}

/**
 * A 429/402 body is opaque when it carries no signal beyond the status itself —
 * empty, whitespace-only, the status digits with HTTP/JSON framing, or
 * generic punctuation. Anything else (retry hints, capacity wording, error
 * descriptions) is informative enough to defer to the classifier.
 */
export function isOpaqueStatusBody(message: string): boolean {
	const cleaned = message
		.replace(/\b(?:402|429)\b/g, "")
		.replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "");
	return !/[a-z\d]{3,}/i.test(cleaned);
}

/**
 * Internal text matcher for usage/quota-limit phrasing. NOT part of the public
 * API — callers classify through {@link import("./flags").isUsageLimit} (the
 * flag accessor). `flags.ts` consumes this to populate `Flag.UsageLimit`, and
 * {@link isUsageLimitOutcome} uses it for the account-rotation decision.
 */
export function matchesUsageLimitText(errorMessage: string): boolean {
	return USAGE_LIMIT_PATTERN.test(errorMessage) || ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage);
}
