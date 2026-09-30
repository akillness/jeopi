import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "jeopi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage, type OAuthCredential } from "../src/session/auth-storage";

const resources: { dir: string; auth: AuthStorage }[] = [];
afterEach(async () => {
	for (const { dir, auth } of resources.splice(0)) {
		auth.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function createCodexCacheFixture(): Promise<{
	auth: AuthStorage;
	modelsPath: string;
	fetch: FetchImpl;
	requests: string[];
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeopi-codex-registry-"));
	const auth = await AuthStorage.create(":memory:");
	resources.push({ dir, auth });
	const modelsPath = path.join(dir, "models.json");
	await Bun.write(modelsPath, JSON.stringify({ providers: {} }));
	const requests: string[] = [];
	const fetch: FetchImpl = async input => {
		const url = String(input);
		requests.push(url);
		if (url.includes("registry.npmjs.org")) return Response.json({ version: "1.0.0" });
		return Response.json({
			models: [
				{
					slug: "gpt-oauth-cached-only",
					display_name: "OAuth cached model",
					context_window: 400_000,
					default_reasoning_level: "high",
					input_modalities: ["text", "image"],
					supported_in_api: true,
				},
			],
		});
	};
	return { auth, modelsPath, fetch, requests };
}

describe("OpenAI account model cache across restarts", () => {
	for (const provider of ["openai", "openai-codex"] as const) {
		it(`restores ${provider} live models synchronously and isolates another account`, async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeopi-openai-registry-"));
			const auth = await AuthStorage.create(":memory:");
			resources.push({ dir, auth });
			auth.setRuntimeApiKey(provider, "account-a");
			const modelsPath = path.join(dir, "models.json");
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: {},
				}),
			);
			let networkCalls = 0;
			const fetch: FetchImpl = async input => {
				networkCalls++;
				const url = String(input);
				if (url.includes("registry.npmjs.org")) return Response.json({ version: "1.0.0" });
				if (url === "https://models.dev/api.json") return Response.json({});
				if (provider === "openai") return Response.json({ data: [{ id: "gpt-new-account-only" }] });
				return Response.json({
					models: [
						{
							slug: "gpt-new-account-only",
							display_name: "New account model",
							context_window: 400_000,
							default_reasoning_level: "high",
							input_modalities: ["text", "image"],
							supported_in_api: true,
						},
					],
				});
			};
			const initial = new ModelRegistry(auth, modelsPath, { fetch });
			await initial.refreshProvider(provider, "online");
			expect(initial.find(provider, "gpt-new-account-only")?.baseUrl).toContain(
				provider === "openai" ? "api.openai.com" : "chatgpt.com",
			);
			const callsAfterRefresh = networkCalls;
			const restarted = new ModelRegistry(auth, modelsPath, { fetch });
			expect(restarted.find(provider, "gpt-new-account-only")).toMatchObject({
				id: "gpt-new-account-only",
				provider,
			});
			expect(networkCalls).toBe(callsAfterRefresh);
			auth.setRuntimeApiKey(provider, "account-b");
			const otherAccount = new ModelRegistry(auth, modelsPath, { fetch });
			expect(otherAccount.find(provider, "gpt-new-account-only")).toBeUndefined();
		});
	}

	it("restores the cached live catalog with multiple OAuth credentials without network discovery", async () => {
		const { auth, modelsPath, fetch, requests } = await createCodexCacheFixture();
		const credentials: OAuthCredential[] = ["a", "b"].map(account => ({
			type: "oauth",
			access: `access-${account}`,
			refresh: `refresh-${account}`,
			accountId: `account-${account}`,
			email: `${account}@example.com`,
			expires: Date.now() + 60_000,
		}));
		await auth.set("openai-codex", credentials);
		const initial = new ModelRegistry(auth, modelsPath, { fetch });
		await initial.refreshProvider("openai-codex", "online");
		expect(initial.find("openai-codex", "gpt-oauth-cached-only")).toMatchObject({ contextWindow: 400_000 });
		const requestsAfterRefresh = [...requests];
		const restarted = new ModelRegistry(auth, modelsPath, { fetch });
		expect(restarted.find("openai-codex", "gpt-oauth-cached-only")).toMatchObject({
			provider: "openai-codex",
			contextWindow: 400_000,
		});
		expect(requests).toEqual(requestsAfterRefresh);
	});

	it("preserves an OAuth account's cached catalog after access-token expiry and rotation", async () => {
		const { auth, modelsPath, fetch, requests } = await createCodexCacheFixture();
		const credential: OAuthCredential = {
			type: "oauth",
			access: "original-access",
			refresh: "original-refresh",
			accountId: "stable-account",
			email: "stable@example.com",
			expires: Date.now() + 60_000,
		};
		await auth.set("openai-codex", credential);
		const initial = new ModelRegistry(auth, modelsPath, { fetch });
		await initial.refreshProvider("openai-codex", "online");
		expect(initial.find("openai-codex", "gpt-oauth-cached-only")).toMatchObject({ contextWindow: 400_000 });
		const requestsAfterRefresh = [...requests];
		await auth.set("openai-codex", { ...credential, expires: Date.now() - 1_000 });
		const expiredRestart = new ModelRegistry(auth, modelsPath, { fetch });
		expect(expiredRestart.find("openai-codex", "gpt-oauth-cached-only")).toMatchObject({ contextWindow: 400_000 });
		await auth.set("openai-codex", {
			...credential,
			access: "rotated-access",
			refresh: "rotated-refresh",
			expires: Date.now() + 60_000,
		});
		const rotatedRestart = new ModelRegistry(auth, modelsPath, { fetch });
		expect(rotatedRestart.find("openai-codex", "gpt-oauth-cached-only")).toMatchObject({ contextWindow: 400_000 });
		expect(requests).toEqual(requestsAfterRefresh);
	});
});
