import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "jeopi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage, type OAuthCredential } from "../src/session/auth-storage";

const provider = "google-antigravity";
const endpoint = "https://antigravity.example";
const resources: { dir: string; auth: AuthStorage; restore: () => void }[] = [];

afterEach(async () => {
	for (const { dir, auth, restore } of resources.splice(0)) {
		restore();
		auth.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

function credential(account: string, expires: number): OAuthCredential {
	return {
		type: "oauth",
		access: `stored-access-${account}`,
		refresh: `refresh-${account}`,
		accountId: account,
		email: `${account}@example.com`,
		projectId: `project-${account}`,
		expires,
	};
}

function catalog(id: string) {
	return {
		models: {
			[id]: {
				displayName: `Live ${id}`,
				supportsImages: true,
				supportsThinking: true,
				maxTokens: 321_000,
				maxOutputTokens: 19_000,
			},
		},
	};
}

async function fixture(credentials: OAuthCredential[]) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeopi-antigravity-registry-"));
	const auth = await AuthStorage.create(path.join(dir, "auth.db"));
	const signals: (AbortSignal | undefined)[] = [];
	const resolvedAccounts: string[] = [];
	const resolve = spyOn(auth, "getOAuthAccessAt").mockImplementation(async (id, position, options) => {
		signals.push(options?.signal);
		const account = auth.listOAuthAccounts(id)[position];
		if (!account?.accountId) return undefined;
		resolvedAccounts.push(account.accountId);
		return { ok: true, ...account, accessToken: `fresh-access-${account.accountId}` };
	});
	// An accidental ranked/round-robin resolution must not reach the real OAuth transport.
	const rankedResolution = spyOn(auth, "getApiKey").mockResolvedValue(undefined);
	resources.push({
		dir,
		auth,
		restore: () => {
			resolve.mockRestore();
			rankedResolution.mockRestore();
		},
	});
	await auth.set(provider, credentials);
	const modelsPath = path.join(dir, "models.json");
	await Bun.write(modelsPath, JSON.stringify({ providers: { [provider]: { baseUrl: endpoint } } }));
	const requests: { url: string; authorization: string | null }[] = [];
	const response: { empty: boolean; failure?: "unauthorized" | "network" } = { empty: false };
	const fetch: FetchImpl = async (input, init) => {
		const url = String(input);
		const authorization = new Headers(init?.headers).get("Authorization");
		requests.push({ url, authorization });
		if (url !== `${endpoint}/v1internal:fetchAvailableModels`) return new Response("Unexpected URL", { status: 404 });
		if (response.failure === "network") throw new TypeError("Connection reset");
		if (response.failure === "unauthorized") return new Response("Unauthorized", { status: 401 });
		const account = auth
			.listOAuthAccounts(provider)
			.find(entry => authorization === `Bearer fresh-access-${entry.accountId}`);
		if (!account) return new Response("Unauthorized", { status: 401 });
		return Response.json(response.empty ? { models: {} } : catalog(`future-reasoner-${account.accountId}-2099`));
	};
	const registry = new ModelRegistry(auth, modelsPath, { fetch });
	return {
		auth,
		modelsPath,
		fetch,
		registry,
		resolve,
		rankedResolution,
		signals,
		resolvedAccounts,
		requests,
		response,
	};
}

function modelIds(registry: ModelRegistry): string[] {
	return registry
		.getAll()
		.filter(model => model.provider === provider)
		.map(model => model.id)
		.sort();
}

describe("ModelRegistry Antigravity OAuth discovery", () => {
	it("discovers an unknown latest model using refreshed access when the stored token is expired", async () => {
		const f = await fixture([credential("a", 1)]);
		await f.registry.refreshProvider(provider, "online-if-uncached");
		expect(f.registry.find(provider, "future-reasoner-a-2099")).toMatchObject({
			name: "Live future-reasoner-a-2099",
			api: "google-gemini-cli",
			provider,
			baseUrl: endpoint,
			input: ["text", "image"],
			reasoning: true,
			contextWindow: 321_000,
			maxTokens: 19_000,
		});
		expect(f.requests).toEqual([
			{ url: `${endpoint}/v1internal:fetchAvailableModels`, authorization: "Bearer fresh-access-a" },
		]);
		expect(f.signals).toHaveLength(1);
		expect(f.signals[0]).toBeInstanceOf(AbortSignal);
		expect(f.signals[0]?.aborted).toBe(false);
		expect(f.rankedResolution).not.toHaveBeenCalled();
	});

	it("reuses a fresh authoritative cache after token rotation and expiry without resolving OAuth or fetching", async () => {
		const original = credential("a", Number.MAX_SAFE_INTEGER);
		const f = await fixture([original]);
		await f.registry.refreshProvider(provider, "online");
		await f.auth.set(provider, { ...original, access: "rotated-access-a", expires: 1 });
		f.resolve.mockClear();
		f.requests.length = 0;
		const restarted = new ModelRegistry(f.auth, f.modelsPath, { fetch: f.fetch });
		await restarted.refreshProvider(provider, "online-if-uncached");
		expect(modelIds(restarted)).toEqual(["future-reasoner-a-2099"]);
		expect(f.resolve).not.toHaveBeenCalled();
		expect(f.rankedResolution).not.toHaveBeenCalled();
		expect(f.requests).toEqual([]);
	});

	it("keeps two-account discovery and its cache pinned to the same account across repeated refreshes", async () => {
		const f = await fixture([credential("a", Number.MAX_SAFE_INTEGER), credential("b", Number.MAX_SAFE_INTEGER)]);
		await f.registry.refreshProvider(provider, "online");
		await f.registry.refreshProvider(provider, "online");
		expect(f.resolvedAccounts).toEqual(["a", "a"]);
		expect(f.requests.map(request => request.authorization)).toEqual([
			"Bearer fresh-access-a",
			"Bearer fresh-access-a",
		]);
		expect(modelIds(f.registry)).toEqual(["future-reasoner-a-2099"]);
		f.resolve.mockClear();
		f.requests.length = 0;
		for (let refresh = 0; refresh < 3; refresh++) {
			await f.registry.refreshProvider(provider, "online-if-uncached");
			expect(modelIds(f.registry)).toEqual(["future-reasoner-a-2099"]);
		}
		expect(f.resolve).not.toHaveBeenCalled();
		expect(f.requests).toEqual([]);
		expect(f.rankedResolution).not.toHaveBeenCalled();
	});

	it.each(["denied", "missing", "throw"] as const)(
		"preserves discovered cache without rotating to a sibling when targeted refresh is %s",
		async failure => {
			const f = await fixture([credential("a", 1), credential("b", Number.MAX_SAFE_INTEGER)]);
			await f.registry.refreshProvider(provider, "online");
			expect(modelIds(f.registry)).toEqual(["future-reasoner-a-2099"]);
			f.requests.length = 0;
			f.resolve.mockImplementation(async () => {
				if (failure === "throw") throw new Error("Refresh denied");
				return failure === "missing" ? undefined : { ok: false, error: "Refresh denied" };
			});
			await f.registry.refreshProvider(provider, "online");
			expect(modelIds(f.registry)).toEqual(["future-reasoner-a-2099"]);
			const restarted = new ModelRegistry(f.auth, f.modelsPath, { fetch: f.fetch });
			await restarted.refreshProvider(provider, "offline");
			expect(modelIds(restarted)).toEqual(["future-reasoner-a-2099"]);
			expect(f.requests).toEqual([]);
			expect(f.rankedResolution).not.toHaveBeenCalled();
		},
	);

	it.each(["auth", "unauthorized", "network"] as const)(
		"keeps bundled models when first-ever discovery fails with %s",
		async failure => {
			const f = await fixture([credential("a", 1)]);
			const bundledIds = modelIds(f.registry);
			if (bundledIds.length === 0) throw new Error("Fixture requires bundled Antigravity models");
			if (failure === "auth") f.resolve.mockResolvedValue({ ok: false, error: "Refresh denied" });
			else f.response.failure = failure;
			await f.registry.refreshProvider(provider, "online");
			expect(modelIds(f.registry)).toEqual(bundledIds);
			const restarted = new ModelRegistry(f.auth, f.modelsPath, { fetch: f.fetch });
			await restarted.refreshProvider(provider, "offline");
			expect(modelIds(restarted)).toEqual(bundledIds);
			expect(f.requests).toHaveLength(failure === "auth" ? 0 : 1);
			expect(f.rankedResolution).not.toHaveBeenCalled();
		},
	);

	it.each(["auth", "unauthorized", "network"] as const)(
		"does not resurrect bundled models after empty discovery then %s failure",
		async failure => {
			const f = await fixture([credential("a", 1)]);
			f.response.empty = true;
			await f.registry.refreshProvider(provider, "online");
			expect(modelIds(f.registry)).toEqual([]);
			f.requests.length = 0;
			if (failure === "auth") f.resolve.mockResolvedValue({ ok: false, error: "Refresh denied" });
			else f.response.failure = failure;
			await f.registry.refreshProvider(provider, "online");
			expect(modelIds(f.registry)).toEqual([]);
			await f.registry.refreshProvider(provider, "offline");
			expect(modelIds(f.registry)).toEqual([]);
			const restarted = new ModelRegistry(f.auth, f.modelsPath, { fetch: f.fetch });
			await restarted.refreshProvider(provider, "offline");
			expect(modelIds(restarted)).toEqual([]);
			expect(f.requests).toHaveLength(failure === "auth" ? 0 : 1);
			expect(f.rankedResolution).not.toHaveBeenCalled();
		},
	);

	it("treats a valid empty catalog as authoritative, removing bundled and previously discovered models", async () => {
		const f = await fixture([credential("a", 1)]);
		await f.registry.refreshProvider(provider, "online");
		expect(modelIds(f.registry)).toEqual(["future-reasoner-a-2099"]);
		f.response.empty = true;
		await f.registry.refreshProvider(provider, "online");
		expect(modelIds(f.registry)).toEqual([]);
		f.resolve.mockClear();
		f.requests.length = 0;
		const restarted = new ModelRegistry(f.auth, f.modelsPath, { fetch: f.fetch });
		await restarted.refreshProvider(provider, "online-if-uncached");
		expect(modelIds(restarted)).toEqual([]);
		expect(f.resolve).not.toHaveBeenCalled();
		expect(f.requests).toEqual([]);
	});
});
