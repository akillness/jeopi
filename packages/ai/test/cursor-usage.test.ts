import { describe, expect, it } from "bun:test";
import { type AuthCredentialStore, AuthStorage } from "jeopi-ai/auth-storage";
import type { FetchImpl } from "jeopi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "jeopi-ai/usage";
import { cursorUsageProvider, parseCursorUsage } from "jeopi-ai/usage/cursor";

function usageParams(credential: UsageFetchParams["credential"]): UsageFetchParams {
	return { provider: "cursor", credential };
}

function jsonFetch(payload: unknown, status = 200): FetchImpl {
	return async () =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
}

describe("cursor usage provider", () => {
	describe("parseCursorUsage", () => {
		it("returns null for non-record or unrecognized payloads", () => {
			expect(parseCursorUsage(null)).toBeNull();
			expect(parseCursorUsage(undefined)).toBeNull();
			expect(parseCursorUsage("invalid")).toBeNull();
			expect(parseCursorUsage([])).toBeNull();
			expect(parseCursorUsage({ startOfMonth: "2026-07-01T00:00:00.000Z", unrelated: "value" })).toBeNull();
		});

		it("normalizes request quotas, monthly reset, and status", () => {
			const report = parseCursorUsage({
				"gpt-4": { numRequests: 150, maxRequestUsage: 500 },
				"claude-3-5-sonnet": { used: 100, limit: 100 },
				startOfMonth: "2026-07-01T00:00:00.000Z",
			});

			expect(report?.limits).toEqual([
				expect.objectContaining({
					id: "cursor:requests:gpt-4",
					label: "gpt-4 requests",
					status: "ok",
					window: { id: "monthly", label: "Monthly", resetsAt: Date.parse("2026-08-01T00:00:00.000Z") },
					amount: expect.objectContaining({
						used: 150,
						limit: 500,
						remaining: 350,
						usedFraction: 0.3,
						unit: "requests",
					}),
				}),
				expect.objectContaining({ id: "cursor:requests:claude-3-5-sonnet", status: "exhausted" }),
			]);
		});

		it("normalizes USD buckets and direct billing-cycle reset timestamps", () => {
			const report = parseCursorUsage({
				planUsage: { used: 15.5, limit: 20 },
				"usd-custom": { amountUsed: 45, amountLimit: 50 },
				billingCycleEnd: "2026-07-20T00:00:00.000Z",
			});

			expect(report?.limits).toEqual([
				expect.objectContaining({
					id: "cursor:usd:planusage",
					label: "planUsage spend",
					amount: expect.objectContaining({ unit: "usd", used: 15.5, limit: 20 }),
					window: expect.objectContaining({ resetsAt: Date.parse("2026-07-20T00:00:00.000Z") }),
				}),
				expect.objectContaining({ id: "cursor:usd:usd-custom", status: "warning" }),
			]);
		});
	});

	describe("default registration", () => {
		it("registers Cursor in AuthStorage's default usage resolver", async () => {
			const store: AuthCredentialStore = {
				close() {},
				listAuthCredentials() {
					return [];
				},
				updateAuthCredential() {},
				deleteAuthCredential() {},
				tryDisableAuthCredentialIfMatches() {
					return false;
				},
				replaceAuthCredentialsForProvider() {
					return [];
				},
				upsertAuthCredentialForProvider() {
					return [];
				},
				deleteAuthCredentialsForProvider() {},
				getCache() {
					return null;
				},
				setCache() {},
				cleanExpiredCache() {},
			};
			const storage = new AuthStorage(store);
			await storage.reload();
			try {
				expect(storage.usageProviderFor("cursor")).toBe(cursorUsageProvider);
			} finally {
				storage.close();
			}
		});
	});

	describe("cursorUsageProvider", () => {
		it("supports Cursor OAuth and access-token credentials only when populated", () => {
			expect(cursorUsageProvider.supports?.(usageParams({ type: "oauth", accessToken: "oauth-token" }))).toBe(true);
			expect(cursorUsageProvider.supports?.(usageParams({ type: "api_key", apiKey: "access-token" }))).toBe(true);
			expect(cursorUsageProvider.supports?.(usageParams({ type: "oauth" }))).toBe(false);
			expect(
				cursorUsageProvider.supports?.({
					provider: "openai-codex",
					credential: { type: "oauth", accessToken: "token" },
				}),
			).toBe(false);
		});

		it("fetches Cursor usage with bearer auth and credential metadata", async () => {
			let requestUrl: string | undefined;
			let requestHeaders: Headers | undefined;
			const fetch: FetchImpl = async (input, init) => {
				requestUrl = String(input);
				requestHeaders = new Headers(init?.headers);
				return new Response(JSON.stringify({ "gpt-4": { numRequests: 10, maxRequestUsage: 100 } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			};
			const ctx: UsageFetchContext = { fetch };

			const report = await cursorUsageProvider.fetchUsage(
				usageParams({ type: "oauth", accessToken: "test-token", email: "user@example.com", accountId: "acc_123" }),
				ctx,
			);

			expect(requestUrl).toBe("https://api2.cursor.sh/auth/usage");
			expect(requestHeaders?.get("accept")).toBe("application/json");
			expect(requestHeaders?.get("authorization")).toBe("Bearer test-token");
			expect(report?.metadata).toEqual({ email: "user@example.com", accountId: "acc_123" });
			expect(report?.limits[0]?.id).toBe("cursor:requests:gpt-4");
		});

		it("returns null safely for malformed payloads, HTTP failures, and fetch errors", async () => {
			expect(
				await cursorUsageProvider.fetchUsage(usageParams({ type: "oauth", accessToken: "token" }), {
					fetch: jsonFetch({}),
				}),
			).toBeNull();
			expect(
				await cursorUsageProvider.fetchUsage(usageParams({ type: "oauth", accessToken: "token" }), {
					fetch: jsonFetch({ error: "forbidden" }, 403),
				}),
			).toBeNull();
			const fetch: FetchImpl = async () => {
				throw new Error("Network error");
			};
			expect(
				await cursorUsageProvider.fetchUsage(usageParams({ type: "oauth", accessToken: "token" }), { fetch }),
			).toBeNull();
		});
	});
});
