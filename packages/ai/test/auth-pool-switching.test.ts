import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "jeopi-ai/auth-storage";
import * as oauthUtils from "jeopi-ai/registry/oauth";
import type { OAuthCredentials } from "jeopi-ai/registry/oauth/types";
import { antigravityRankingStrategy, antigravityUsageProvider } from "jeopi-ai/usage/google-antigravity";
import { removeWithRetries } from "../../utils/src/temp";

function farExpiry(): number {
	return Date.now() + 60 * 60_000;
}

describe("Antigravity per-model quota scoping and switching", () => {
	let tempDir = "";
	let store: AuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-antigravity-pool-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("selects the unblocked account per model family (Argon weekly vs Flash daily)", async () => {
		if (!store) throw new Error("test setup failed");
		const futureDaily = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
		const futureWeekly = new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString();

		const usageFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
			if (auth.includes("acc-1")) {
				// Account 1: Argon exhausted (weekly), Flash healthy (daily)
				return new Response(
					JSON.stringify({
						models: {
							"gemini-4-argon-high": {
								apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
								modelProvider: "MODEL_PROVIDER_GOOGLE",
								quotaInfo: { resetTime: futureWeekly },
							},
							"gemini-3.8-flash-high": {
								apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
								modelProvider: "MODEL_PROVIDER_GOOGLE",
								quotaInfo: { remainingFraction: 0.92, resetTime: futureDaily },
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			// Account 2: Argon healthy (weekly), Flash exhausted (daily)
			return new Response(
				JSON.stringify({
					models: {
						"gemini-4-argon-high": {
							apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
							modelProvider: "MODEL_PROVIDER_GOOGLE",
							quotaInfo: { remainingFraction: 0.26, resetTime: futureWeekly },
						},
						"gemini-3.8-flash-high": {
							apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
							modelProvider: "MODEL_PROVIDER_GOOGLE",
							quotaInfo: { resetTime: futureDaily },
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		authStorage = new AuthStorage(store, {
			usageFetch: usageFetch as unknown as typeof fetch,
			usageProviderResolver: provider => (provider === "google-antigravity" ? antigravityUsageProvider : undefined),
			rankingStrategyResolver: provider =>
				provider === "google-antigravity" ? antigravityRankingStrategy : undefined,
		});

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const cred = credentials["google-antigravity"] as OAuthCredentials | undefined;
			if (!cred) return null;
			return { apiKey: cred.access, newCredentials: cred };
		});

		await authStorage.set("google-antigravity", [
			{
				type: "oauth",
				access: "acc-1",
				refresh: "ref-1",
				expires: farExpiry(),
				email: "one@example.com",
				projectId: "proj-1",
			},
			{
				type: "oauth",
				access: "acc-2",
				refresh: "ref-2",
				expires: farExpiry(),
				email: "two@example.com",
				projectId: "proj-2",
			},
		]);

		// For gemini-4-argon-high, only acc-2 has quota
		const argonKey = await authStorage.getApiKey("google-antigravity", "sess-argon", {
			modelId: "gemini-4-argon-high",
		});
		expect(argonKey).toBe("acc-2");

		// For gemini-3.8-flash-high, only acc-1 has quota
		const flashKey = await authStorage.getApiKey("google-antigravity", "sess-flash", {
			modelId: "gemini-3.8-flash-high",
		});
		expect(flashKey).toBe("acc-1");

		// Exhausting Argon on acc-2 in sess-shared must NOT block Flash on acc-2
		await authStorage.getApiKey("google-antigravity", "sess-shared", { modelId: "gemini-4-argon-high" });
		const markResult = await authStorage.markUsageLimitReached("google-antigravity", "sess-shared", {
			modelId: "gemini-4-argon-high",
			retryAfterMs: 60_000,
		});
		// acc-1 is already exhausted for Argon, so no Argon sibling is available
		expect(markResult.switched).toBe(false);
	});
	test("keeps distinct OAuth credentials without email/accountId isolated during usage refresh", async () => {
		if (!store) throw new Error("test setup failed");
		authStorage = new AuthStorage(store);
		await authStorage.set("github-copilot", [
			{
				type: "oauth",
				access: "ghu_individual_token_123",
				refresh: "ghu_individual_token_123",
				expires: Date.now() + 60_000,
			},
			{
				type: "oauth",
				access: "ghu_enterprise_token_456",
				refresh: "ghu_enterprise_token_456",
				expires: Date.now() + 60_000,
				enterpriseUrl: "ghe.example.com",
			},
		]);
		const first = await authStorage.getApiKey("github-copilot", undefined, {
			baseUrl: "https://api.githubcopilot.com",
			modelId: "gpt-4o",
		});
		const second = await authStorage.getApiKey("github-copilot", undefined, {
			baseUrl: "https://api.githubcopilot.com",
			modelId: "gpt-4o",
		});
		expect(JSON.parse(first!).token).toBe("ghu_individual_token_123");
		expect(JSON.parse(first!).enterpriseUrl).toBeUndefined();
		expect(JSON.parse(second!).token).toBe("ghu_enterprise_token_456");
		expect(JSON.parse(second!).enterpriseUrl).toBe("ghe.example.com");
	});
});
