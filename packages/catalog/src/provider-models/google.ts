import { ANTIGRAVITY_PRIMARY_ENDPOINT, fetchAntigravityDiscoveryModels } from "../discovery/antigravity";
import { fetchGeminiModels } from "../discovery/gemini";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl } from "../types";
import { GEMINI_CLI_VARIANT_COLLAPSE_TABLE } from "../variant-collapse";

export interface GoogleModelManagerConfig {
	apiKey?: string;
	fetch?: FetchImpl;
}

export interface GoogleVertexModelManagerConfig {
	apiKey?: string;
	project?: string;
	location?: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

export interface GoogleAntigravityModelManagerConfig {
	oauthToken?: string;
	endpoint?: string;
	fetch?: FetchImpl;
	/** Stable credential identity; falls back to the token when unavailable. */
	cacheScope?: string;
	/** Resolve a fresh token only when discovery actually needs the network. */
	resolveOAuthToken?: (signal: AbortSignal) => Promise<string | undefined>;
}

export interface GoogleGeminiCliModelManagerConfig {
	oauthToken?: string;
	endpoint?: string;
	fetch?: FetchImpl;
}

const CLOUD_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

function toDiscoveryFetch(fetchImpl: FetchImpl | undefined): typeof fetch | undefined {
	if (!fetchImpl) {
		return undefined;
	}
	return Object.assign(
		(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetchImpl(input, init),
		{ preconnect: fetchImpl.preconnect ?? fetch.preconnect },
	);
}

export function googleModelManagerOptions(
	config?: GoogleModelManagerConfig,
): ModelManagerOptions<"google-generative-ai"> {
	const apiKey = config?.apiKey;
	return {
		providerId: "google",
		...(apiKey
			? { fetchDynamicModels: () => fetchGeminiModels({ apiKey, fetch: toDiscoveryFetch(config?.fetch) }) }
			: undefined),
	};
}

export function googleVertexModelManagerOptions(_config?: GoogleVertexModelManagerConfig): ModelManagerOptions {
	return { providerId: "google-vertex" };
}

export function googleAntigravityModelManagerOptions(
	config?: GoogleAntigravityModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const token = config?.oauthToken?.trim();
	const endpoint = (config?.endpoint ?? ANTIGRAVITY_PRIMARY_ENDPOINT).replace(/\/+$/, "");
	return {
		providerId: "google-antigravity",
		...(token
			? {
					cacheProviderId: `google-antigravity:discovery-v2:${Bun.hash(JSON.stringify([endpoint, config?.cacheScope ?? token])).toString(36)}`,
					dynamicModelsAuthoritative: true,
					preserveAuthoritativeCacheOnFailure: true,
					fetchDynamicModels: async () => {
						const signal = AbortSignal.timeout(10_000);
						const resolvedToken = config?.resolveOAuthToken ? await config.resolveOAuthToken(signal) : token;
						if (!resolvedToken?.trim() || signal.aborted) return null;
						return fetchAntigravityDiscoveryModels({
							token: resolvedToken,
							endpoint: config?.endpoint,
							fetcher: toDiscoveryFetch(config?.fetch),
							signal,
						});
					},
				}
			: undefined),
	};
}

export function googleGeminiCliModelManagerOptions(
	config?: GoogleGeminiCliModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const token = config?.oauthToken;
	const endpoint = config?.endpoint ?? CLOUD_CODE_ASSIST_ENDPOINT;
	return {
		providerId: "google-gemini-cli",
		...(token
			? {
					fetchDynamicModels: async () => {
						const models = await fetchAntigravityDiscoveryModels({
							token,
							endpoint,
							fetcher: toDiscoveryFetch(config?.fetch),
							collapseTable: GEMINI_CLI_VARIANT_COLLAPSE_TABLE,
						});
						if (models === null) {
							return null;
						}
						return models.map(m => ({
							...m,
							provider: "google-gemini-cli" as const,
							baseUrl: endpoint,
						}));
					},
				}
			: undefined),
	};
}
