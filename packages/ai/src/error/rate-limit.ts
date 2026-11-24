import { extractRetryHint } from "jeopi-utils";

/**
 * Rate limit reason classification and backoff calculation utilities.
 * Ported from opencode-antigravity-auth plugin for consistency.
 */

export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "INSUFFICIENT_G1_CREDITS_BALANCE"
	| "RATE_LIMIT_EXCEEDED"
	| "CONCURRENT_LIMIT"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000; // 30s
const CONCURRENT_LIMIT_BACKOFF_MS = 5 * 1000; // 5s
const MODEL_CAPACITY_BASE_MS = 45 * 1000; // 45s base
const MODEL_CAPACITY_JITTER_MS = 30 * 1000; // ±15s
const SERVER_ERROR_BACKOFF_MS = 20 * 1000; // 20s

const ACCOUNT_RATE_LIMIT_PATTERN =
	/\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const INSUFFICIENT_BALANCE_PATTERN = /insufficient.?balance/i;
// Prepaid-credit exhaustion phrased around the credit balance rather than a
// quota: OpenRouter "This request would exceed your available credits given
// your current in-flight requests" (402) and "Insufficient credits",
// "credits exhausted". Account-local, so rotate to a sibling credential.
const CREDITS_EXHAUSTED_PATTERN =
	/\b(?:exceed\w*|insufficient|not enough)\b[^\n]{0,40}\bcredits?\b|\bcredits?\b[^\n]{0,40}\b(?:exhausted|depleted|unavailable)\b/i;
// model" with `error_code: credits_required`.
const ANTHROPIC_CREDITS_REQUIRED_PATTERN = /\busage credits are required\b|\bcredits_required\b/i;
// Prepaid-balance exhaustion: Cursor ERROR_USAGE_PRICING_REQUIRED (code 44, 429).
const PREPAID_BALANCE_EXHAUSTED_PATTERN =
	/\busage_pricing_required\b|\bprepaid balance\b[^\n]{0,40}\b(?:used up|exhausted|depleted)\b/i;
// Account billing ceilings: Anthropic "monthly spend limit" and Google "monthly spending cap".
const SPEND_LIMIT_PATTERN = /spend(?:ing)?[\s_-]?(?:limit|cap)\b/i;
// LiteLLM rejects a spent virtual key with HTTP 422 and "Budget Exceeded" / "Budget has been exceeded!".
const BUDGET_EXCEEDED_PATTERN = /\bbudget(?:[\s_-]+has[\s_-]+been)?[\s_-]+exceeded\b/i;
const SUBSCRIPTION_CAP_PATTERN =
	/\b(?:subscription|plan|membership)\b[^\n]{0,80}\b(?:rate.?limits?|quota|cap)\b|\b(?:rate.?limits?|quota|cap)\b[^\n]{0,80}\b(?:subscription|plan|membership)\b/i;
const TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN = /\bper\s+(?:second|minute)\b/i;

function matchesSubscriptionCapText(errorMessage: string): boolean {
	return SUBSCRIPTION_CAP_PATTERN.test(errorMessage) && !TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN.test(errorMessage);
}

const OPENROUTER_DAILY_FREE_LIMIT_PATTERN = /\bfree[-_ ]models[-_ ]per[-_ ]day\b/i;
const CLINE_PASS_QUOTA_PATTERN = /clinepass limit|free limit reached on model/i;
const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/gi;
const CONCURRENT_LIMIT_PATTERN =
	/\btoo many\s+concurren\w*\s+(?:requests?|invocations?)\b|\bconcurren\w*\b[^\n]{0,60}\b(?:limit|quota|exceed\w*|reach\w*)\b|\b(?:limit|quota|exceed\w*|reach\w*)\b[^\n]{0,60}\bconcurren\w*\b|\bconcurren[a-z]*[-_](?:[a-z]+[_-])*(?:limit|quota|exceed\w*|reach\w*)/i;
const ACCOUNT_SCOPED_403_PATTERN =
	/\b(?:overall|account|organization|team|workspace)\b[^\n]{0,40}\b(?:message |request )?rate.?limit\b|\byour\b[^\n]{0,30}\b(?:limit )?will reset\b/i;
const CN_QUOTA_EXHAUSTED_PATTERN =
	/(?:使用|用量).{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/;
const CN_TRANSIENT_CAP_PATTERN =
	/速率.{0,30}上限|频率.{0,30}上限|每分钟.{0,30}上限|并发.{0,30}上限|使用.{0,30}(?:速率|频率|每分钟|并发).{0,30}上限/;
const CN_THROTTLE_PATTERN = /速率(?:限制|过快)|频率(?:过高|过快)|过于频繁|稍后[重再]试/;
const DASHSCOPE_TOKEN_LIMIT_DOC_PATTERN = /error-code[^()\s]*#token-limit/i;
const DASHSCOPE_TOKEN_LIMIT_MESSAGE_PATTERN =
	/\byou exceeded your current quota, please check your plan and billing details\b/i;

/** True for DashScope/Bailian's documented OpenAI-compatible TPM/TPS throttle. */
export function isDashScopeTokenLimitText(errorMessage: string): boolean {
	return (
		DASHSCOPE_TOKEN_LIMIT_DOC_PATTERN.test(errorMessage) && DASHSCOPE_TOKEN_LIMIT_MESSAGE_PATTERN.test(errorMessage)
	);
}

const TPM_RPM_THROTTLE_PATTERN =
	/\b(?:tpm|rpm)\b[^\n]{0,40}\b(?:exhaust\w*|exceed\w*|limit\w*|throttl\w*|reach\w*)\b|\b(?:exhaust\w*|exceed\w*|limit\w*|throttl\w*|reach\w*)\b[^\n]{0,40}\b(?:tpm|rpm)\b|\bRateLimitExceeded\.(?:Endpoint)?(?:TPM|RPM)\w*/i;
const ZERO_ALLOWANCE_PATTERN = /\bx-ratelimit-limit-[a-z0-9-]+:\s*0(?![\d.])/i;

/**
 * Actionable suffix for a 429 whose `header` (an `x-ratelimit-limit-*` name)
 * reported a zero allowance. Recognized by {@link matchesUsageLimitText},
 * {@link parseRateLimitReason}, and {@link isBillingCapUsageLimit}.
 */
export function formatZeroAllowanceNotice(header: string): string {
	return `(${header}: 0 — this plan grants no allowance for the model; switch models or upgrade the plan)`;
}

const GOOGLE_RPC_ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";
const GOOGLE_RPC_QUOTA_FAILURE_TYPE = "type.googleapis.com/google.rpc.QuotaFailure";
const GOOGLE_RPC_RETRY_INFO_TYPE = "type.googleapis.com/google.rpc.RetryInfo";
const ANTIGRAVITY_MODEL_QUOTA_PATTERN = /\bexhausted your capacity on this model\b/i;
const LONG_RATE_LIMIT_DELAY_MS = 5 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Parse an embedded JSON object from an error message. */
export function parseJsonBody(errorMessage: string): Record<string, unknown> | undefined {
	const start = errorMessage.indexOf("{");
	const end = errorMessage.lastIndexOf("}");
	if (start < 0 || end < start) return undefined;
	try {
		const parsed: unknown = JSON.parse(errorMessage.slice(start, end + 1));
		return asRecord(parsed);
	} catch {
		return undefined;
	}
}

/**
 * Classify structured Google RESOURCE_EXHAUSTED bodies before consulting text.
 * Cloud Code Assist prefixes the JSON with its HTTP error label, so accept an
 * embedded top-level object as well as a raw JSON body.
 */
function parseGoogleRpcRateLimitReason(errorMessage: string): RateLimitReason | undefined {
	const body = parseJsonBody(errorMessage);
	const error = asRecord(body?.error);
	if (typeof error?.status !== "string" || error.status.trim().toUpperCase() !== "RESOURCE_EXHAUSTED") {
		return undefined;
	}
	if (!Array.isArray(error.details)) return undefined;

	let sawGenericRateLimitInfo = false;
	for (const value of error.details) {
		const detail = asRecord(value);
		if (detail?.["@type"] !== GOOGLE_RPC_ERROR_INFO_TYPE || typeof detail.reason !== "string") continue;
		const reason = detail.reason.trim().toUpperCase();
		switch (reason) {
			case "MODEL_CAPACITY_EXHAUSTED":
			case "MODEL_CAPACITY_EXCEEDED":
				return "MODEL_CAPACITY_EXHAUSTED";
			case "QUOTA_EXHAUSTED":
				return "QUOTA_EXHAUSTED";
			case "INSUFFICIENT_G1_CREDITS_BALANCE":
				return "INSUFFICIENT_G1_CREDITS_BALANCE";
			case "RATE_LIMIT_EXCEEDED": {
				if (
					(typeof error.message === "string" && ANTIGRAVITY_MODEL_QUOTA_PATTERN.test(error.message)) ||
					ANTIGRAVITY_MODEL_QUOTA_PATTERN.test(errorMessage)
				) {
					return "QUOTA_EXHAUSTED";
				}
				sawGenericRateLimitInfo = true;
				break;
			}
		}
	}

	let sawShortWindowViolation = false;
	for (const value of error.details) {
		const detail = asRecord(value);
		if (detail?.["@type"] !== GOOGLE_RPC_QUOTA_FAILURE_TYPE || !Array.isArray(detail.violations)) continue;
		for (const v of detail.violations) {
			const violation = asRecord(v);
			const quotaValue = violation?.quotaValue;
			if (
				(typeof quotaValue === "string" || typeof quotaValue === "number") &&
				/^\s*0+(?:\.0+)?\s*$/.test(String(quotaValue))
			) {
				return "QUOTA_EXHAUSTED";
			}
			const quotaId = typeof violation?.quotaId === "string" ? violation.quotaId.toLowerCase() : "";
			const quotaMetric = typeof violation?.quotaMetric === "string" ? violation.quotaMetric.toLowerCase() : "";
			const combined = `${quotaId} ${quotaMetric}`;
			if (combined.includes("perday") || combined.includes("daily") || combined.includes("per_day")) {
				return "QUOTA_EXHAUSTED";
			}
			if (
				combined.includes("perminute") ||
				combined.includes("per_minute") ||
				combined.includes("persecond") ||
				combined.includes("per_second") ||
				combined.includes("per100seconds") ||
				combined.includes("per_100_seconds")
			) {
				sawShortWindowViolation = true;
			}
		}
	}
	if (sawShortWindowViolation || sawGenericRateLimitInfo) {
		const retryDelayMs = extractRetryHint(undefined, errorMessage);
		return retryDelayMs !== undefined && retryDelayMs >= LONG_RATE_LIMIT_DELAY_MS
			? "QUOTA_EXHAUSTED"
			: "RATE_LIMIT_EXCEEDED";
	}

	for (const value of error.details) {
		const detail = asRecord(value);
		if (detail?.["@type"] !== GOOGLE_RPC_RETRY_INFO_TYPE) continue;
		const retryDelayMs = extractRetryHint(undefined, errorMessage);
		if (retryDelayMs !== undefined) {
			return retryDelayMs >= LONG_RATE_LIMIT_DELAY_MS ? "QUOTA_EXHAUSTED" : "RATE_LIMIT_EXCEEDED";
		}
	}

	return undefined;
}

function isQuotaExhaustedReason(reason: RateLimitReason): boolean {
	return reason === "QUOTA_EXHAUSTED" || reason === "INSUFFICIENT_G1_CREDITS_BALANCE";
}

/**
 * Classify a rate-limit error message into a reason category.
 */
export function parseRateLimitReason(errorMessage: string): RateLimitReason {
	const structuredReason = parseGoogleRpcRateLimitReason(errorMessage);
	if (structuredReason !== undefined) return structuredReason;
	const lowerWithStatus = errorMessage.toLowerCase();
	const lower = lowerWithStatus.replace(RESOURCE_EXHAUSTED_PATTERN, "");
	const hasResourceExhaustedStatus = lower !== lowerWithStatus;

	if (
		lower.includes("quota will reset") ||
		lower.includes("exhausted your capacity") ||
		ZERO_ALLOWANCE_PATTERN.test(errorMessage)
	) {
		return "QUOTA_EXHAUSTED";
	}

	if (CN_QUOTA_EXHAUSTED_PATTERN.test(errorMessage) && !CN_TRANSIENT_CAP_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (isDashScopeTokenLimitText(errorMessage)) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (CONCURRENT_LIMIT_PATTERN.test(errorMessage)) {
		return "CONCURRENT_LIMIT";
	}

	if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("529") || lower.includes("503")) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (SPEND_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (BUDGET_EXCEEDED_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (matchesSubscriptionCapText(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (CLINE_PASS_QUOTA_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (ANTHROPIC_CREDITS_REQUIRED_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (PREPAID_BALANCE_EXHAUSTED_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("per minute") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("presque") ||
		TPM_RPM_THROTTLE_PATTERN.test(errorMessage)
	) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (
		lower.includes("exhausted") ||
		lower.includes("quota") ||
		lower.includes("usage limit") ||
		lower.includes("run out of credits") ||
		lower.includes("out of credits") ||
		lower.includes("spending-limit") ||
		lower.includes("spending limit") ||
		lower.includes("access_terminated_error") ||
		INSUFFICIENT_BALANCE_PATTERN.test(errorMessage) ||
		CREDITS_EXHAUSTED_PATTERN.test(errorMessage)
	) {
		return "QUOTA_EXHAUSTED";
	}

	if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) {
		return "SERVER_ERROR";
	}

	if (hasResourceExhaustedStatus) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	return "UNKNOWN";
}

/**
 * Calculate backoff delay in ms for a given rate limit reason.
 * MODEL_CAPACITY gets jitter to prevent thundering herd.
 */
export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
	switch (reason) {
		case "INSUFFICIENT_G1_CREDITS_BALANCE":
		case "QUOTA_EXHAUSTED":
			return QUOTA_EXHAUSTED_BACKOFF_MS;
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
		case "CONCURRENT_LIMIT":
			return CONCURRENT_LIMIT_BACKOFF_MS;
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
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|exhaust(?:ed|ion)?|insufficient)|额度不足|额度耗尽|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|insufficient_g1_credits_balance|balance.?exhausted|run out of credits|out of credits|out of (?:extra )?usage|spending[- _]?limit|personal-team-blocked|clinepass limit|free limit reached on model|access_terminated_error/i;

export function isUsageLimitStatus(status: number | undefined): boolean {
	return status === 429 || status === 402;
}

const STATUS_402_QUOTA_PATTERN =
	/\b(?:payment(?:\s+is)?[-_.\s]*required|deactivated_workspace|insufficient.?(?:balance|credits?|account.?funds)|requires?\s+more\s+credits|billing[-_.\s]*(?:verification|error|issue)|can only afford)\b/i;

const BILLING_ERROR_CODE_PATTERN = /^billing_(?:error|not_configured)$/i;
const BILLING_ERROR_FIELD_PATTERN = /\b(?:type|code|param)=billing_(?:error|not_configured)(?=[\s)]|$)/i;

export function is402BillingCapBody(message: string | undefined): boolean {
	if (message === undefined || isOpaqueStatusBody(message)) return true;
	if (BILLING_ERROR_CODE_PATTERN.test(message) || BILLING_ERROR_FIELD_PATTERN.test(message)) return true;
	const body = parseJsonBody(message);
	const error = asRecord(body?.error) ?? body;
	if (
		[error?.type, error?.code, error?.param].some(
			value => typeof value === "string" && BILLING_ERROR_CODE_PATTERN.test(value),
		)
	) {
		return true;
	}
	if (STATUS_402_QUOTA_PATTERN.test(message)) return true;
	const reason = parseRateLimitReason(message);
	return isQuotaExhaustedReason(reason) || reason === "CONCURRENT_LIMIT";
}

const OUT_OF_CREDIT_PATTERN = /\bout of credit|\badd (?:more )?credit|\btop ?up\b|\bcredit balance\b/i;

// OpenRouter 402 "This request would exceed your available credits given your
// current in-flight requests. Retry after in-flight requests settle, or add
// credits." The balance is reserved by the account's own running requests and
// frees as they finish, so the stated `retry-after-ms` window can clear it.
const IN_FLIGHT_CREDIT_RESERVATION_PATTERN = /\bin-flight requests\b/i;

/**
 * Whether a usage-limit failure is a *billing* cap rather than a window that
 * reopens on a clock.
 */
export function isBillingCapUsageLimit(status: number | undefined, message: string | undefined): boolean {
	if (message === undefined) return false;
	const reason = parseRateLimitReason(message);
	if (reason === "CONCURRENT_LIMIT" && status !== 402) return false;
	if (isDashScopeTokenLimitText(message) || IN_FLIGHT_CREDIT_RESERVATION_PATTERN.test(message)) return false;
	if (status === 402) return is402BillingCapBody(message);
	return (
		reason === "INSUFFICIENT_G1_CREDITS_BALANCE" ||
		/\binsufficient_g1_credits_balance\b/i.test(message) ||
		OUT_OF_CREDIT_PATTERN.test(message) ||
		INSUFFICIENT_BALANCE_PATTERN.test(message) ||
		CREDITS_EXHAUSTED_PATTERN.test(message) ||
		PREPAID_BALANCE_EXHAUSTED_PATTERN.test(message) ||
		SPEND_LIMIT_PATTERN.test(message) ||
		ANTHROPIC_CREDITS_REQUIRED_PATTERN.test(message) ||
		/\binsufficient_quota\b/i.test(message) ||
		ZERO_ALLOWANCE_PATTERN.test(message)
	);
}

/**
 * Returns true for failures that should burn one credential and rotate to a
 * sibling account.
 */
export function isUsageLimitOutcome(status: number | undefined, message: string | undefined): boolean {
	const structuredReason = message ? parseGoogleRpcRateLimitReason(message) : undefined;
	if (structuredReason !== undefined) return isQuotaExhaustedReason(structuredReason);
	if (isConcurrencyCapExclusion(status, message)) return false;
	if (message && matchesUsageLimitText(message)) return true;
	if ((status === 403 || status === undefined) && message && isAccountScopedCapText(message)) return true;
	if (status === 402 && is402BillingCapBody(message)) return true;
	if (!isUsageLimitStatus(status)) return false;
	if (!message || isOpaqueStatusBody(message)) return true;
	const reason = parseRateLimitReason(message);
	return isQuotaExhaustedReason(reason);
}

/**
 * A usage-limit status body is opaque when it carries no signal beyond the
 * status itself — empty, whitespace-only, the status digits with HTTP/JSON
 * framing, or generic punctuation.
 */
export function isOpaqueStatusBody(message: string): boolean {
	const cleaned = message
		.replace(/\b(?:429|402)\b/g, "")
		.replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "")
		.replace(/\(?\bno body\b\)?/gi, "");
	return (
		!/[a-z\d]{3,}/i.test(cleaned) &&
		!CN_QUOTA_EXHAUSTED_PATTERN.test(cleaned) &&
		!CN_TRANSIENT_CAP_PATTERN.test(cleaned) &&
		!CN_THROTTLE_PATTERN.test(cleaned)
	);
}

/**
 * Internal text matcher for usage/quota-limit phrasing.
 */
export function matchesUsageLimitText(errorMessage: string): boolean {
	const structuredReason = parseGoogleRpcRateLimitReason(errorMessage);
	if (structuredReason !== undefined) return isQuotaExhaustedReason(structuredReason);
	if (isDashScopeTokenLimitText(errorMessage)) return false;
	if (TPM_RPM_THROTTLE_PATTERN.test(errorMessage) && parseRateLimitReason(errorMessage) === "RATE_LIMIT_EXCEEDED") {
		return false;
	}
	return (
		USAGE_LIMIT_PATTERN.test(errorMessage) ||
		ANTHROPIC_CREDITS_REQUIRED_PATTERN.test(errorMessage) ||
		PREPAID_BALANCE_EXHAUSTED_PATTERN.test(errorMessage) ||
		CREDITS_EXHAUSTED_PATTERN.test(errorMessage) ||
		(CN_QUOTA_EXHAUSTED_PATTERN.test(errorMessage) && !CN_TRANSIENT_CAP_PATTERN.test(errorMessage)) ||
		BUDGET_EXCEEDED_PATTERN.test(errorMessage) ||
		SPEND_LIMIT_PATTERN.test(errorMessage) ||
		ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage) ||
		matchesSubscriptionCapText(errorMessage) ||
		OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage) ||
		ZERO_ALLOWANCE_PATTERN.test(errorMessage)
	);
}

export function isAccountScopedCapText(message: string): boolean {
	return ACCOUNT_SCOPED_403_PATTERN.test(message);
}

export function isConcurrencyCapExclusion(status: number | undefined, message: string | undefined): boolean {
	return message !== undefined && parseRateLimitReason(message) === "CONCURRENT_LIMIT" && status !== 402;
}
