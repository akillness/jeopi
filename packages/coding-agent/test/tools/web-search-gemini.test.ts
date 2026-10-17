import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, Model } from "jeopi-ai";
import type { FetchImpl } from "jeopi-ai/types";
import { buildModel } from "jeopi-catalog/build";
import type { SearchParams } from "jeopi-cli/web/search/providers/base";
import { GeminiProvider, searchGemini } from "jeopi-cli/web/search/providers/gemini";

type ModelAwareSearchParams = SearchParams & { model?: Model };

type CapturedRequest = {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | null;
};

const SSE_RESPONSE =
	'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini answer"}]}}],"modelVersion":"gemini-2.5-flash"}}\n\n';
const DEVELOPER_SSE_RESPONSE =
	'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Developer answer"}]},"groundingMetadata":{"webSearchQueries":["latest Bun version"],"groundingChunks":[{"web":{"uri":"https://bun.sh","title":"Bun"}}],"groundingSupports":[{"segment":{"text":"Developer answer"},"groundingChunkIndices":[0]}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7},"modelVersion":"gemini-2.5-flash"}\n\n';
const ARGON_SSE_RESPONSE =
	'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Argon answer"}]}}]}}\n\n';

function makeActiveModel(provider: string, id: string, api: Model["api"]): Model {
	return buildModel({
		provider,
		id,
		name: `${provider}/${id}`,
		api,
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function makeOAuthAuthStorage(
	accessByProvider: Record<string, { accessToken: string; projectId: string }>,
): AuthStorage {
	return {
		async getOAuthAccess(provider: string) {
			return accessByProvider[provider];
		},
		hasOAuth(provider: string) {
			return provider in accessByProvider;
		},
	} as unknown as AuthStorage;
}

describe("searchGemini tools serialization", () => {
	let capturedRequest: CapturedRequest | null = null;

	const fakeAuthStorage = {
		async getOAuthAccess() {
			return {
				accessToken: "test-access-token",
				projectId: "test-project",
			};
		},
		hasOAuth() {
			return true;
		},
	} as unknown as AuthStorage;

	const apiKeyAuthStorage = {
		async getOAuthAccess() {
			return undefined;
		},
		hasOAuth() {
			return false;
		},
		hasAuth(provider: string) {
			return provider === "google";
		},
		async getApiKey(provider: string) {
			return provider === "google" ? "test-gemini-api-key" : undefined;
		},
	} as unknown as AuthStorage;

	function mockGeminiFetch(responseText = SSE_RESPONSE): FetchImpl {
		capturedRequest = null;
		return (url, init) => {
			const headers = new Headers(init?.headers);
			capturedRequest = {
				url: String(url),
				headers: Object.fromEntries(headers.entries()),
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};
			return Promise.resolve(
				new Response(responseText, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
		capturedRequest = null;
	});

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Gemini test prompt",
		} as const;
	}

	it("treats a standard Google developer API key as available", () => {
		const provider = new GeminiProvider();
		expect(provider.isAvailable(apiKeyAuthStorage)).toBe(true);
	});

	it("routes API key auth through the developer API with Google Search grounding", async () => {
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE);
		const response = await searchGemini({
			...makeParams("developer api"),
			authStorage: apiKeyAuthStorage,
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
		expect(capturedRequest?.headers["x-goog-api-key"]).toBe("test-gemini-api-key");
		expect(capturedRequest?.body).toMatchObject({
			tools: [{ googleSearch: {} }],
		});
		expect(response).toMatchObject({
			answer: "Developer answer",
			sources: [{ title: "Bun", url: "https://bun.sh" }],
			searchQueries: ["latest Bun version"],
			usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
		});
	});

	it("uses Antigravity OAuth, requestModelId, and requested-model fallback for an Argon search", async () => {
		const activeModel = {
			...makeActiveModel("google-antigravity", "gemini-4-argon-low", "google-gemini-cli"),
			requestModelId: "gemini-4-argon-medium",
		};
		const authStorage = makeOAuthAuthStorage({
			"google-gemini-cli": { accessToken: "cli-token", projectId: "cli-project" },
			"google-antigravity": { accessToken: "argon-token", projectId: "argon-project" },
		});

		const response = await searchGemini({
			...makeParams("argon search"),
			authStorage,
			model: activeModel,
			antigravityEndpointMode: "production",
			fetch: mockGeminiFetch(ARGON_SSE_RESPONSE),
		});

		expect(capturedRequest?.url).toBe(
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		);
		expect(capturedRequest?.headers.authorization).toBe("Bearer argon-token");
		expect(capturedRequest?.body).toMatchObject({ model: "gemini-4-argon-medium", project: "argon-project" });
		expect(response.model).toBe("gemini-4-argon-medium");
	});

	it("uses the selected Gemini CLI model and CLI OAuth credential", async () => {
		const activeModel = makeActiveModel("google-gemini-cli", "gemini-4-argon-high", "google-gemini-cli");
		const authStorage = makeOAuthAuthStorage({
			"google-gemini-cli": { accessToken: "cli-token", projectId: "cli-project" },
			"google-antigravity": { accessToken: "argon-token", projectId: "argon-project" },
		});

		await searchGemini({
			...makeParams("gemini cli search"),
			authStorage,
			model: activeModel,
			fetch: mockGeminiFetch(),
		});

		expect(capturedRequest?.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(capturedRequest?.headers.authorization).toBe("Bearer cli-token");
		expect(capturedRequest?.body).toMatchObject({ model: "gemini-4-argon-high", project: "cli-project" });
	});

	it("does not fall back to another Gemini provider or API key when selected Antigravity OAuth is unavailable", async () => {
		let fetchCalled = false;
		const authStorage = {
			async getOAuthAccess(provider: string) {
				return provider === "google-gemini-cli"
					? { accessToken: "cli-token", projectId: "cli-project" }
					: undefined;
			},
			hasOAuth(provider: string) {
				return provider === "google-gemini-cli";
			},
			async getApiKey() {
				return "developer-api-key";
			},
		} as unknown as AuthStorage;
		const activeModel = makeActiveModel("google-antigravity", "gemini-4-argon-low", "google-gemini-cli");
		const fetchMock: FetchImpl = () => {
			fetchCalled = true;
			return Promise.resolve(new Response(ARGON_SSE_RESPONSE, { status: 200 }));
		};

		await expect(
			searchGemini({ ...makeParams("missing Argon auth"), authStorage, model: activeModel, fetch: fetchMock }),
		).rejects.toThrow(/credential|auth/i);
		expect(fetchCalled).toBe(false);
	});

	it("keeps Gemini CLI auth and the default model for an unrelated active model", async () => {
		const activeModel = makeActiveModel("openai-codex", "gpt-5.5", "openai-codex-responses");
		const authStorage = makeOAuthAuthStorage({
			"google-gemini-cli": { accessToken: "cli-token", projectId: "cli-project" },
		});

		await searchGemini({
			...makeParams("unrelated model"),
			authStorage,
			model: activeModel,
			fetch: mockGeminiFetch(),
		});

		expect(capturedRequest?.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(capturedRequest?.headers.authorization).toBe("Bearer cli-token");
		expect(capturedRequest?.body?.model).toBe("gemini-2.5-flash");
		expect(capturedRequest?.body?.model).not.toBe(activeModel.id);
	});

	it("forwards the active model through GeminiProvider.search to the outbound request", async () => {
		const activeModel = makeActiveModel("google-antigravity", "gemini-4-argon-medium", "google-gemini-cli");
		const authStorage = makeOAuthAuthStorage({
			"google-antigravity": { accessToken: "argon-token", projectId: "argon-project" },
		});
		const params: ModelAwareSearchParams = {
			...makeParams("provider dispatch"),
			authStorage,
			model: activeModel,
			antigravityEndpointMode: "sandbox",
			fetch: mockGeminiFetch(),
		};

		await new GeminiProvider().search(params);

		expect(capturedRequest?.url).toBe(
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		);
		expect(capturedRequest?.headers.authorization).toBe("Bearer argon-token");
		expect(capturedRequest?.body).toMatchObject({ model: "gemini-4-argon-medium" });
	});

	it("sends default googleSearch tool when no passthrough payloads are provided", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({ ...makeParams("default tools"), fetch: fetchMock });

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }],
		});
	});

	it("passes through googleSearch payload into googleSearch tool", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("google payload"),
			google_search: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } },
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } } }],
		});
	});

	it("includes codeExecution and urlContext tools when provided", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("extended tools"),
			code_execution: {},
			url_context: { allowedDomains: ["example.com"] },
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }, { codeExecution: {} }, { urlContext: { allowedDomains: ["example.com"] } }],
		});
	});
});
