import { formatZeroAllowanceNotice } from "../error/rate-limit";

export type HeadersLike = Headers | Record<string, string | undefined> | undefined | null;

const RETRY_AFTER_HINT = "retry-after-ms=";

/**
 * Append `retry-after-ms=<n>` to `message` when `retryAfterMs` is positive and
 * the hint is not already present. Shared across providers so every transport
 * formats retry delays identically for {@link extractRetryHint}.
 */
export function appendRetryAfterHint(message: string, retryAfterMs: number | undefined): string {
	if (retryAfterMs === undefined || retryAfterMs <= 0 || message.includes(RETRY_AFTER_HINT)) {
		return message;
	}
	return `${message} ${RETRY_AFTER_HINT}${retryAfterMs}`;
}

/**
 * Extract the text of an arbitrary thrown value: `Error.message` when it is an
 * `Error`, the string itself when it is a string, otherwise `JSON.stringify`
 * with a `String(error)` fallback so non-JSON-serializable values never throw.
 */
export function errorMessageText(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}

export function formatErrorMessageWithRetryAfter(error: unknown, headers?: HeadersLike): string {
	let message = errorMessageText(error);
	const resolvedHeaders = headers ?? getHeadersFromError(error);
	const zeroLimitHeader = getZeroRateLimitHeader(resolvedHeaders);
	if (zeroLimitHeader && !message.includes(zeroLimitHeader)) {
		message = `${message} ${formatZeroAllowanceNotice(zeroLimitHeader)}`;
	}
	const retryAfterMs = getRetryAfterMsFromHeaders(resolvedHeaders);
	return appendRetryAfterHint(message, retryAfterMs);
}

/**
 * Parse a `retry-after-ms` header value (positive finite milliseconds).
 * Returns `undefined` when missing, empty, non-numeric, or non-positive.
 */
export function parseRetryAfterMsHeader(raw: string | undefined | null): number | undefined {
	if (!raw) return undefined;
	const ms = Number.parseFloat(raw.trim());
	return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : undefined;
}

/**
 * Honor the explicit `x-should-retry` response header used by Anthropic and
 * OpenAI SDKs (`"true"` / `"false"`). Returns `undefined` when absent or
 * unrecognized so callers fall back to status/body heuristics.
 */
export function getShouldRetryFromHeaders(headers: HeadersLike): boolean | undefined {
	if (!headers) return undefined;
	const raw = getHeaderValue(headers, "x-should-retry")?.trim().toLowerCase();
	if (raw === "true") return true;
	if (raw === "false") return false;
	return undefined;
}

/**
 * Detect any `x-ratelimit-limit-*` response header whose numeric value is `0`
 * (e.g. Mistral `x-ratelimit-limit-req-minute: 0` when the plan grants no
 * allowance for the requested model). Returns the header name so callers can
 * surface an actionable zero-allowance notice.
 */
export function getZeroRateLimitHeader(headers: HeadersLike): string | undefined {
	if (!headers) return undefined;
	const entries: Iterable<[string, string | undefined]> =
		headers instanceof Headers ? headers.entries() : Object.entries(headers);
	for (const [key, value] of entries) {
		if (!key.toLowerCase().startsWith("x-ratelimit-limit-")) continue;
		if (typeof value === "string" && /^\s*0+(?:\.0+)?\s*$/.test(value)) {
			return key.toLowerCase();
		}
	}
	return undefined;
}

export function getRetryAfterMsFromHeaders(headers: HeadersLike): number | undefined {
	if (!headers) return undefined;

	const retryAfterMs = parseRetryAfterMsHeader(getHeaderValue(headers, "retry-after-ms"));
	const retryAfter = parseRetryAfterHeader(getHeaderValue(headers, "retry-after"));
	const resetMs = parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset-ms"), "ms");
	const resetSeconds = parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset"), "s");

	const candidates = [retryAfterMs, retryAfter, resetMs, resetSeconds].filter(
		(value): value is number => value !== undefined,
	);
	if (candidates.length === 0) return undefined;
	return Math.max(...candidates);
}

export function getHeadersFromError(error: unknown): HeadersLike {
	if (!error || typeof error !== "object") return undefined;
	const record = error as { headers?: unknown; response?: { headers?: unknown }; cause?: unknown };
	const direct = extractHeaders(record.headers) ?? extractHeaders(record.response?.headers);
	if (direct) return direct;
	if (record.cause) return getHeadersFromError(record.cause);
	return undefined;
}

function extractHeaders(value: unknown): HeadersLike {
	if (!value) return undefined;
	if (value instanceof Headers) return value;
	if (typeof value === "object") return value as Record<string, string | undefined>;
	return undefined;
}

function getHeaderValue(headers: Headers | Record<string, string | undefined>, name: string): string | undefined {
	if (headers instanceof Headers) {
		return headers.get(name) ?? undefined;
	}
	const direct = headers[name];
	if (typeof direct === "string") return direct;
	const lowerName = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName && typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

function parseRetryAfterHeader(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;

	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds > 0) {
		return Math.ceil(seconds * 1000);
	}

	const parsedDate = Date.parse(trimmed);
	if (Number.isFinite(parsedDate)) {
		const delayMs = parsedDate - Date.now();
		if (delayMs > 0) {
			return Math.ceil(delayMs);
		}
	}

	return undefined;
}

function parseResetHeader(raw: string | undefined, unit: "ms" | "s"): number | undefined {
	if (!raw) return undefined;
	const value = Number(raw.trim());
	if (!Number.isFinite(value) || value <= 0) return undefined;

	const now = Date.now();
	if (unit === "ms") {
		if (value > 1e11) {
			const delayMs = value - now;
			return delayMs > 0 ? Math.ceil(delayMs) : undefined;
		}
		return Math.ceil(value);
	}

	if (value > 1e9) {
		const delayMs = value * 1000 - now;
		return delayMs > 0 ? Math.ceil(delayMs) : undefined;
	}
	return Math.ceil(value * 1000);
}
