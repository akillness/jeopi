import { type } from "arktype";
import type { Api, FetchImpl, ModelSpec, Provider } from "../types";
import { discoveryFetch, isRecord } from "../utils";

const MODELS_PATH = "/models";

/**
 * Uses a cancellable timer rather than the native abort-timeout helper so
 * successful fast discovery requests do not leave armed timeout signals for
 * concurrent GC to trip over later.
 */
async function withOpenAICompatibleDiscoveryTimeout<T>(
	timeoutMs: number,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
		timeoutMs,
	);
	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Minimal OpenAI-style model entry shape consumed by discovery.
 *
 * Providers may return additional fields; this type only captures
 * fields that are useful for generic normalization.
 */
export interface OpenAICompatibleModelRecord {
	id?: unknown;
	name?: unknown;
	object?: unknown;
	owned_by?: unknown;
	[key: string]: unknown;
}

/**
 * Tolerant envelope for OpenAI-compatible `/models` responses.
 *
 * Common providers return `{ data: [...] }`, but variants such as
 * `{ models: [...] }`, `{ result: [...] }`, or direct arrays are also
 * accepted during extraction.
 */
export interface OpenAICompatibleModelsEnvelope {
	data?: unknown;
	models?: unknown;
	result?: unknown;
	items?: unknown;
	[key: string]: unknown;
}

const openAICompatibleModelRecordSchema = type({
	id: "string >= 1",
	"name?": "string | null",
	"object?": "unknown",
	"owned_by?": "unknown",
});

const openAICompatibleModelsEnvelopeSchema = type({
	"data?": "unknown",
	"models?": "unknown",
	"result?": "unknown",
	"items?": "unknown",
});

const openAICompatibleModelsPayloadSchema = type("unknown[]").or(openAICompatibleModelsEnvelopeSchema);

type ParsedOpenAICompatibleModelRecord = typeof openAICompatibleModelRecordSchema.infer;
/**
 * Context passed to custom OpenAI-compatible model mappers.
 */
export interface OpenAICompatibleModelMapperContext<TApi extends Api> {
	api: TApi;
	provider: Provider;
	baseUrl: string;
}

/**
 * Options for fetching and normalizing OpenAI-compatible `/models` catalogs.
 */
export interface FetchOpenAICompatibleModelsOptions<TApi extends Api> {
	/** API type assigned to normalized models. */
	api: TApi;
	/** Provider id assigned to normalized models. */
	provider: Provider;
	/** Provider base URL used for both fetch and normalized model records. */
	baseUrl: string;
	/** Optional bearer token for Authorization header. */
	apiKey?: string;
	/** Additional request headers. */
	headers?: Record<string, string>;
	/** Optional AbortSignal for request cancellation; caller owns its lifecycle. */
	signal?: AbortSignal;
	/** Optional cancellable request timeout used when `signal` is omitted. */
	timeoutMs?: number;
	/** Optional fetch implementation override for testing/custom runtimes. */
	fetch?: FetchImpl;
	/** Follow Anthropic's `has_more` / `last_id` cursor protocol via `after_id`. */
	pagination?: "anthropic";
	/**
	 * Optional post-normalization filter.
	 * Return false to skip a model.
	 */
	filterModel?: (entry: OpenAICompatibleModelRecord, model: ModelSpec<TApi>) => boolean;
	/**
	 * Optional mapper override for provider-specific quirks.
	 * Return null to skip a model.
	 */
	mapModel?: (
		entry: OpenAICompatibleModelRecord,
		defaults: ModelSpec<TApi>,
		context: OpenAICompatibleModelMapperContext<TApi>,
	) => ModelSpec<TApi> | null;
}

/**
 * Fetches and normalizes an OpenAI-compatible `/models` catalog.
 *
 * Returns `null` on transport/protocol failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchOpenAICompatibleModels<TApi extends Api>(
	options: FetchOpenAICompatibleModelsOptions<TApi>,
): Promise<ModelSpec<TApi>[] | null> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	if (!baseUrl) {
		return null;
	}

	const requestHeaders: Record<string, string> = {
		Accept: "application/json",
		...options.headers,
	};
	if (options.apiKey) {
		requestHeaders.Authorization = `Bearer ${options.apiKey}`;
	}

	const fetchImpl = discoveryFetch(options.fetch);
	const fetchEntries = async (signal?: AbortSignal): Promise<ParsedOpenAICompatibleModelRecord[] | null> => {
		const entries: ParsedOpenAICompatibleModelRecord[] = [];
		const cursors = new Set<string>();
		let url = `${baseUrl}${MODELS_PATH}`;
		while (true) {
			let payload: unknown;
			try {
				const response = await fetchImpl(url, {
					method: "GET",
					headers: requestHeaders,
					signal,
				});
				if (!response.ok) return null;
				payload = await response.json();
			} catch {
				return null;
			}
			const page = extractModelEntries(payload);
			if (page === null) return null;
			entries.push(...page);
			if (options.pagination !== "anthropic" || !isRecord(payload) || payload.has_more !== true) {
				return entries;
			}
			const cursor = payload.last_id;
			// A broken/repeated cursor must not loop or cache an incomplete catalog.
			if (typeof cursor !== "string" || cursor.length === 0 || cursors.has(cursor) || page.length === 0) {
				return null;
			}
			cursors.add(cursor);
			url = `${baseUrl}${MODELS_PATH}?after_id=${encodeURIComponent(cursor)}`;
		}
	};
	const entries =
		options.signal !== undefined
			? await fetchEntries(options.signal)
			: options.timeoutMs !== undefined
				? await withOpenAICompatibleDiscoveryTimeout(options.timeoutMs, fetchEntries)
				: await fetchEntries();
	if (entries === null) return null;

	const context: OpenAICompatibleModelMapperContext<TApi> = {
		api: options.api,
		provider: options.provider,
		baseUrl,
	};

	const deduped = new Map<string, ModelSpec<TApi>>();
	for (const entry of entries) {
		const defaults: ModelSpec<TApi> = {
			id: entry.id,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
			api: options.api,
			provider: options.provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		};

		// `mapModel` returning null skips the entry (documented contract); only a
		// missing mapper falls back to the defaults.
		const mapped = options.mapModel ? options.mapModel(entry, defaults, context) : defaults;
		if (!mapped || typeof mapped.id !== "string" || mapped.id.length === 0) {
			continue;
		}
		if (options.filterModel && !options.filterModel(entry, mapped)) {
			continue;
		}
		deduped.set(mapped.id, mapped);
	}

	return Array.from(deduped.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return "";
	}
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function extractModelEntries(payload: unknown): ParsedOpenAICompatibleModelRecord[] | null {
	return extractModelEntriesFromNode(payload);
}

function extractModelEntriesFromNode(node: unknown): ParsedOpenAICompatibleModelRecord[] | null {
	const parsedPayload = openAICompatibleModelsPayloadSchema(node);
	if (parsedPayload instanceof type.errors) {
		return null;
	}
	if (Array.isArray(parsedPayload)) {
		const parsedEntries = parsedPayload
			.map(entry => openAICompatibleModelRecordSchema(entry))
			.flatMap(entry => (entry instanceof type.errors ? [] : [entry]));
		return parsedEntries;
	}
	for (const candidate of [parsedPayload.data, parsedPayload.models, parsedPayload.result, parsedPayload.items]) {
		if (candidate === undefined) {
			continue;
		}
		const nested = extractModelEntriesFromNode(candidate);
		if (nested !== null) {
			return nested;
		}
	}

	return null;
}
