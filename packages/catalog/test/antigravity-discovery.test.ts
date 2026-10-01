import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fetchAntigravityDiscoveryModels } from "jeopi-catalog/discovery/antigravity";
import { type ModelManagerOptions, resolveProviderModels } from "jeopi-catalog/model-manager";
import {
	type GoogleAntigravityModelManagerConfig,
	googleAntigravityModelManagerOptions,
} from "jeopi-catalog/provider-models/google";
import type { ModelSpec } from "jeopi-catalog/types";

/** Row shape for `it.each` tables asserting a parsed discovery catalog against an expectation. */
type DiscoveryCatalogCase = {
	name: string;
	payload: unknown;
	expected: ModelSpec<"google-gemini-cli">[] | null;
};

/** Row shape for `it.each` tables comparing resolved model IDs against a fixed ID list. */
type IdsTestCase = { name: string; ids: string[] };

const tempDirs = new Set<string>();
const endpoint = "https://antigravity.example";
const token = "test-antigravity-token";

afterEach(async () => {
	await Promise.all([...tempDirs].map(dir => fs.rm(dir, { recursive: true, force: true })));
	tempDirs.clear();
});

function fakeFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
	return Object.assign(handler, { preconnect() {} });
}

function modelPayload(id: string) {
	return {
		models: {
			[id]: {
				displayName: id,
				supportsImages: true,
				supportsThinking: true,
				maxTokens: 321_000,
				maxOutputTokens: 19_000,
			},
		},
	};
}

function staticModel(id: string): ModelSpec<"google-gemini-cli"> {
	return {
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: endpoint,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 80_000,
		maxTokens: 8_000,
	};
}

async function cachePath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeopi-antigravity-cache-"));
	tempDirs.add(dir);
	return path.join(dir, "models.db");
}

function manager(
	cacheDbPath: string,
	config: GoogleAntigravityModelManagerConfig,
	staticModels: ModelSpec<"google-gemini-cli">[] = [],
): ModelManagerOptions<"google-gemini-cli"> {
	return {
		...googleAntigravityModelManagerOptions(config),
		cacheDbPath,
		staticModels,
		cacheTtlMs: 1_000,
		now: () => 100,
	};
}

describe("Antigravity live discovery", () => {
	it("surfaces a future model with provider-native API, capabilities, and reported limits", async () => {
		const models = await fetchAntigravityDiscoveryModels({
			token,
			endpoint: `${endpoint}/`,
			fetcher: fakeFetch(async () => Response.json(modelPayload("future-reasoner-2099"))),
		});
		expect(models).toEqual([
			expect.objectContaining({
				id: "future-reasoner-2099",
				name: "future-reasoner-2099",
				api: "google-gemini-cli",
				provider: "google-antigravity",
				baseUrl: endpoint,
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 321_000,
				maxTokens: 19_000,
			}),
		]);
	});

	it.each<DiscoveryCatalogCase>([
		{ name: "explicit empty map", payload: { models: {} }, expected: [] },
		{ name: "missing map", payload: {}, expected: null },
		{ name: "null map", payload: { models: null }, expected: null },
		{ name: "array map", payload: { models: [] }, expected: null },
		{ name: "array of metadata", payload: { models: [{ displayName: "not-an-id" }] }, expected: null },
		{ name: "scalar model metadata", payload: { models: { broken: 42 } }, expected: null },
		{ name: "null model metadata", payload: { models: { broken: null } }, expected: null },
		{ name: "array model metadata", payload: { models: { broken: [] } }, expected: null },
		{
			name: "mixed valid and malformed model metadata",
			payload: { models: { ...modelPayload("valid").models, broken: null } },
			expected: null,
		},
	])("distinguishes $name from an authoritative catalog", async ({ payload, expected }) => {
		const models = await fetchAntigravityDiscoveryModels({
			token,
			endpoint,
			fetcher: fakeFetch(async () => Response.json(payload)),
		});
		expect(models).toEqual(expected);
	});

	it.each(["", " \t\n"])("does not send a discovery request for a blank token %j", async blankToken => {
		let requests = 0;
		const models = await fetchAntigravityDiscoveryModels({
			token: blankToken,
			fetcher: fakeFetch(async () => {
				requests++;
				return Response.json(modelPayload("must-not-be-discovered"));
			}),
		});
		expect({ models, requests }).toEqual({ models: null, requests: 0 });
	});

	it("aborts the active request and does not try fallback endpoints after caller cancellation", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		let requests = 0;
		const discovery = fetchAntigravityDiscoveryModels({
			token,
			signal: controller.signal,
			fetcher: fakeFetch(async (_input, init) => {
				requests++;
				started.resolve();
				const signal = init?.signal;
				if (!signal) return Response.json(modelPayload("uncancelable-request"));
				return new Promise<Response>((_resolve, reject) => {
					const abort = () => reject(new DOMException("Canceled by caller", "AbortError"));
					if (signal.aborted) abort();
					else signal.addEventListener("abort", abort, { once: true });
				});
			}),
		});
		await started.promise;
		controller.abort();
		const models = await discovery;
		expect({ models, requests }).toEqual({ models: null, requests: 1 });
	});

	it("still uses a fallback endpoint after a non-cancellation transport failure", async () => {
		let requests = 0;
		const models = await fetchAntigravityDiscoveryModels({
			token,
			fetcher: fakeFetch(async () => {
				requests++;
				if (requests === 1) throw new TypeError("Connection reset");
				return Response.json(modelPayload("fallback-model"));
			}),
		});
		expect(models?.map(model => model.id)).toEqual(["fallback-model"]);
		expect(requests).toBe(2);
	});

	it("does not start discovery when the caller is already canceled", async () => {
		let requests = 0;
		const models = await fetchAntigravityDiscoveryModels({
			token,
			signal: AbortSignal.abort(),
			fetcher: fakeFetch(async () => {
				requests++;
				return Response.json(modelPayload("must-not-be-discovered"));
			}),
		});
		expect({ models, requests }).toEqual({ models: null, requests: 0 });
	});
});

describe("Antigravity discovery cache", () => {
	it.each([undefined, "", " \t"])(
		"keeps static models without sending requests when credentials are absent: %j",
		async oauthToken => {
			let requests = 0;
			const options = manager(
				await cachePath(),
				{
					oauthToken,
					endpoint,
					fetch: fakeFetch(async () => {
						requests++;
						return Response.json(modelPayload("unauthenticated-model"));
					}),
				},
				[staticModel("available-offline")],
			);
			const result = await resolveProviderModels(options, "online");
			expect(result.models.map(model => model.id)).toEqual(["available-offline"]);
			expect(requests).toBe(0);
		},
	);

	it.each<IdsTestCase>([
		{ name: "nonempty", ids: ["future-only"] },
		{ name: "empty", ids: [] },
	])("replaces stale static IDs with a successful $name catalog and reuses its cache", async ({ ids }) => {
		const cacheDbPath = await cachePath();
		let requests = 0;
		const options = manager(
			cacheDbPath,
			{
				oauthToken: token,
				endpoint,
				fetch: fakeFetch(async () => {
					requests++;
					return Response.json(ids.length ? modelPayload(ids[0]!) : { models: {} });
				}),
			},
			[staticModel("retired-static-id")],
		);
		const live = await resolveProviderModels(options, "online");
		expect(live.models.map(model => model.id)).toEqual(ids);
		expect(live.stale).toBe(false);
		const cached = await resolveProviderModels({ ...options, now: () => 101 }, "online-if-uncached");
		expect(cached.models.map(model => model.id)).toEqual(ids);
		expect(cached.stale).toBe(false);
		expect(requests).toBe(1);
	});

	it("persists an empty replacement instead of resurrecting previously discovered IDs", async () => {
		const cacheDbPath = await cachePath();
		let empty = false;
		let requests = 0;
		const options = manager(cacheDbPath, {
			oauthToken: token,
			endpoint,
			fetch: fakeFetch(async () => {
				requests++;
				return Response.json(empty ? { models: {} } : modelPayload("removed-from-account"));
			}),
		});
		const initial = await resolveProviderModels(options, "online");
		expect(initial.models.map(model => model.id)).toEqual(["removed-from-account"]);
		empty = true;
		const refreshed = await resolveProviderModels({ ...options, now: () => 200 }, "online");
		expect(refreshed.models).toEqual([]);
		const cached = await resolveProviderModels({ ...options, now: () => 201 }, "online-if-uncached");
		expect(cached.models).toEqual([]);
		expect(cached.stale).toBe(false);
		expect(requests).toBe(2);
	});

	it.each(["malformed", "unauthorized", "network"])(
		"preserves discovered entries after a %s refresh failure",
		async failure => {
			const cacheDbPath = await cachePath();
			let failing = false;
			const options = manager(cacheDbPath, {
				oauthToken: token,
				endpoint,
				fetch: fakeFetch(async () => {
					if (!failing) return Response.json(modelPayload("previously-discovered"));
					if (failure === "malformed") return Response.json({ models: { broken: null } });
					if (failure === "unauthorized") return new Response("Unauthorized", { status: 401 });
					throw new TypeError("Connection reset");
				}),
			});
			await resolveProviderModels(options, "online");
			failing = true;
			const failed = await resolveProviderModels({ ...options, now: () => 200 }, "online");
			expect(failed.models.map(model => model.id)).toEqual(["previously-discovered"]);
			expect(failed.stale).toBe(true);
			const offline = await resolveProviderModels({ ...options, now: () => 201 }, "offline");
			expect(offline.models.map(model => model.id)).toEqual(["previously-discovered"]);
		},
	);

	it.each(["auth", "unauthorized", "network"])(
		"keeps static fallback when the first discovery fails with %s",
		async failure => {
			let requests = 0;
			const options = manager(
				await cachePath(),
				{
					oauthToken: token,
					endpoint,
					resolveOAuthToken: async () => {
						if (failure === "auth") throw new Error("Refresh denied");
						return token;
					},
					fetch: fakeFetch(async () => {
						requests++;
						if (failure === "unauthorized") return new Response("Unauthorized", { status: 401 });
						throw new TypeError("Connection reset");
					}),
				},
				[staticModel("available-offline")],
			);
			const failed = await resolveProviderModels(options, "online");
			expect(failed.models.map(model => model.id)).toEqual(["available-offline"]);
			expect(failed.stale).toBe(true);
			const offline = await resolveProviderModels(options, "offline");
			expect(offline.models.map(model => model.id)).toEqual(["available-offline"]);
			expect(requests).toBe(failure === "auth" ? 0 : 1);
		},
	);

	it.each(["auth", "unauthorized", "network"])(
		"preserves an empty snapshot through %s failure and expired offline refresh",
		async failure => {
			let failing = false;
			let requests = 0;
			const options = manager(
				await cachePath(),
				{
					oauthToken: token,
					endpoint,
					resolveOAuthToken: async () => {
						if (failing && failure === "auth") throw new Error("Refresh denied");
						return token;
					},
					fetch: fakeFetch(async () => {
						requests++;
						if (!failing) return Response.json({ models: {} });
						if (failure === "unauthorized") return new Response("Unauthorized", { status: 401 });
						throw new TypeError("Connection reset");
					}),
				},
				[staticModel("retired-static-id")],
			);
			expect((await resolveProviderModels(options, "online")).models).toEqual([]);
			failing = true;
			const failed = await resolveProviderModels({ ...options, now: () => 200 }, "online");
			expect(failed.models).toEqual([]);
			expect(failed.stale).toBe(true);
			const offline = await resolveProviderModels({ ...options, now: () => 1_101 }, "offline");
			expect(offline.models).toEqual([]);
			expect(offline.stale).toBe(true);
			expect(requests).toBe(failure === "auth" ? 1 : 2);
		},
	);

	it.each<IdsTestCase>([
		{ name: "nonempty", ids: ["previously-discovered"] },
		{ name: "empty", ids: [] },
	])("does not renew a $name snapshot's TTL after a failed refresh", async ({ ids }) => {
		let now = 100;
		let requests = 0;
		const options = {
			...manager(
				await cachePath(),
				{
					oauthToken: token,
					endpoint,
					fetch: fakeFetch(async () => {
						requests++;
						if (requests === 1) return Response.json(ids.length ? modelPayload(ids[0]!) : { models: {} });
						if (requests === 2) throw new TypeError("Connection reset");
						return Response.json(modelPayload("recovered-model"));
					}),
				},
				[staticModel("retired-static-id")],
			),
			now: () => now,
		};
		expect((await resolveProviderModels(options, "online")).models.map(model => model.id)).toEqual(ids);
		now = 1_050;
		const failed = await resolveProviderModels(options, "online");
		expect(failed.models.map(model => model.id)).toEqual(ids);
		expect(failed.stale).toBe(true);
		now = 1_099;
		const cached = await resolveProviderModels(options, "online-if-uncached");
		expect(cached.models.map(model => model.id)).toEqual(ids);
		expect(cached.stale).toBe(false);
		expect(requests).toBe(2);
		now = 1_101;
		const recovered = await resolveProviderModels(options, "online-if-uncached");
		expect(recovered.models.map(model => model.id)).toEqual(["recovered-model"]);
		expect(recovered.stale).toBe(false);
		expect(requests).toBe(3);
	});

	it("retains static merge fallback for an unrelated provider that opts out", async () => {
		let failing = false;
		const options: ModelManagerOptions<"google-gemini-cli"> = {
			providerId: "google-gemini-cli",
			cacheDbPath: await cachePath(),
			staticModels: [{ ...staticModel("static-fallback"), provider: "google-gemini-cli" }],
			dynamicModelsAuthoritative: true,
			preserveAuthoritativeCacheOnFailure: false,
			cacheTtlMs: 1_000,
			now: () => 100,
			fetchDynamicModels: async () => {
				if (failing) throw new TypeError("Connection reset");
				return [{ ...staticModel("discovered-model"), provider: "google-gemini-cli" }];
			},
		};
		expect((await resolveProviderModels(options, "online")).models.map(model => model.id)).toEqual([
			"discovered-model",
		]);
		failing = true;
		const failed = await resolveProviderModels(options, "online");
		expect(failed.models.map(model => model.id).sort()).toEqual(["discovered-model", "static-fallback"]);
		expect(failed.stale).toBe(true);
		const offline = await resolveProviderModels(options, "offline");
		expect(offline.models.map(model => model.id).sort()).toEqual(["discovered-model", "static-fallback"]);
	});

	it.each([
		{ name: "endpoint", first: { endpoint }, second: { endpoint: "https://other-antigravity.example" } },
		{ name: "token", first: { oauthToken: "account-one" }, second: { oauthToken: "account-two" } },
		{ name: "explicit scope", first: { cacheScope: "account-one" }, second: { cacheScope: "account-two" } },
		{
			name: "endpoint within the same explicit scope",
			first: { endpoint, cacheScope: "stable-account" },
			second: { endpoint: "https://other-antigravity.example", cacheScope: "stable-account" },
		},
	])("isolates cached catalogs by $name", async ({ first, second }) => {
		const cacheDbPath = await cachePath();
		const firstOptions = manager(cacheDbPath, {
			oauthToken: token,
			endpoint,
			...first,
			fetch: fakeFetch(async () => Response.json(modelPayload("first-account-model"))),
		});
		await resolveProviderModels(firstOptions, "online");
		const secondOptions = manager(cacheDbPath, {
			oauthToken: token,
			endpoint,
			...second,
			fetch: fakeFetch(async () => Response.json(modelPayload("second-account-model"))),
		});
		const secondResult = await resolveProviderModels(secondOptions, "online-if-uncached");
		expect(secondResult.models.map(model => model.id)).toEqual(["second-account-model"]);
		const firstAgain = await resolveProviderModels(firstOptions, "offline");
		expect(firstAgain.models.map(model => model.id)).toEqual(["first-account-model"]);
	});

	it("reuses a stable account scope across token rotation without refreshing credentials or the network", async () => {
		const cacheDbPath = await cachePath();
		await resolveProviderModels(
			manager(cacheDbPath, {
				oauthToken: "old-token",
				endpoint,
				cacheScope: "stable-account",
				fetch: fakeFetch(async () => Response.json(modelPayload("account-model"))),
			}),
			"online",
		);
		let resolutions = 0;
		let requests = 0;
		const rotated = manager(cacheDbPath, {
			oauthToken: "rotated-token",
			endpoint,
			cacheScope: "stable-account",
			resolveOAuthToken: async () => {
				resolutions++;
				return "fresh-token";
			},
			fetch: fakeFetch(async () => {
				requests++;
				return Response.json(modelPayload("unexpected-refresh"));
			}),
		});
		const result = await resolveProviderModels(rotated, "online-if-uncached");
		expect(result.models.map(model => model.id)).toEqual(["account-model"]);
		expect({ resolutions, requests }).toEqual({ resolutions: 0, requests: 0 });
	});

	it("resolves credentials only for a due network fetch and authenticates with the refreshed token", async () => {
		const cacheDbPath = await cachePath();
		let resolutions = 0;
		const options = manager(cacheDbPath, {
			oauthToken: "expired-token",
			endpoint,
			cacheScope: "stable-account",
			resolveOAuthToken: async (_signal: AbortSignal) => {
				resolutions++;
				return "fresh-token";
			},
			fetch: fakeFetch(async (_input, init) =>
				new Headers(init?.headers).get("Authorization") === "Bearer fresh-token"
					? Response.json(modelPayload("authenticated-model"))
					: new Response("Unauthorized", { status: 401 }),
			),
		});
		await resolveProviderModels(options, "offline");
		expect(resolutions).toBe(0);
		const live = await resolveProviderModels(options, "online-if-uncached");
		expect(live.models.map(model => model.id)).toEqual(["authenticated-model"]);
		expect(resolutions).toBe(1);
		await resolveProviderModels({ ...options, now: () => 101 }, "online-if-uncached");
		expect(resolutions).toBe(1);
		const expired = await resolveProviderModels({ ...options, now: () => 1_101 }, "online-if-uncached");
		expect(expired.models.map(model => model.id)).toEqual(["authenticated-model"]);
		expect(resolutions).toBe(2);
	});

	it.each(["throw", "undefined", "blank"])(
		"preserves cached discovery and sends no stale token when the resolver returns %s",
		async failure => {
			const cacheDbPath = await cachePath();
			await resolveProviderModels(
				manager(cacheDbPath, {
					oauthToken: token,
					endpoint,
					cacheScope: "stable-account",
					fetch: fakeFetch(async () => Response.json(modelPayload("cached-model"))),
				}),
				"online",
			);
			let requests = 0;
			const options = manager(cacheDbPath, {
				oauthToken: token,
				endpoint,
				cacheScope: "stable-account",
				resolveOAuthToken: async () => {
					if (failure === "throw") throw new Error("Refresh denied");
					return failure === "undefined" ? undefined : "  ";
				},
				fetch: fakeFetch(async () => {
					requests++;
					return Response.json(modelPayload("must-not-replace-cache"));
				}),
			});
			const failed = await resolveProviderModels(options, "online");
			expect(failed.models.map(model => model.id)).toEqual(["cached-model"]);
			expect(failed.stale).toBe(true);
			expect(requests).toBe(0);
			const offline = await resolveProviderModels(options, "offline");
			expect(offline.models.map(model => model.id)).toEqual(["cached-model"]);
		},
	);
});
