import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

describe("jeopi shared 429 cooldown bridge", () => {
	const dirs: string[] = [];
	const prevPool = process.env.JEO_SHARED_AUTH_POOL_PATH;

	afterEach(() => {
		if (prevPool === undefined) delete process.env.JEO_SHARED_AUTH_POOL_PATH;
		else process.env.JEO_SHARED_AUTH_POOL_PATH = prevPool;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("persists shared cooldowns on markUsageLimitReached and honors external cooldowns for sibling switching", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jeopi-shared-cd-"));
		dirs.push(dir);
		const poolPath = join(dir, "cooldowns.json");
		process.env.JEO_SHARED_AUTH_POOL_PATH = poolPath;

		// Seed shared cooldown for account alpha@example.com from jeo-code
		writeFileSync(
			poolPath,
			JSON.stringify({
				version: 1,
				updatedAt: Date.now(),
				cooldowns: {
					"openai:email:alpha@example.com": {
						blockedUntil: Date.now() + 120_000,
						reason: "rate_limit",
						source: "jeo-code",
					},
				},
			}),
			{ mode: 0o600 },
		);

		const store = await SqliteAuthCredentialStore.open(":memory:");
		const storage = new AuthStorage(store, { sharedCooldown: true, usageProviderResolver: () => undefined });
		await storage.set("openai-codex", [
			{
				type: "oauth",
				access: "tok-alpha",
				refresh: "ref-alpha",
				expires: Date.now() + 3_600_000,
				email: "alpha@example.com",
			},
			{
				type: "oauth",
				access: "tok-beta",
				refresh: "ref-beta",
				expires: Date.now() + 3_600_000,
				email: "beta@example.com",
			},
		]);

		// Because alpha is cooled down via shared pool, AuthStorage selects beta
		const picked = await storage.getApiKey("openai-codex", "sess-1");
		expect(picked).toBe("tok-beta");

		// Blocking beta via markUsageLimitReached writes back to shared cooldowns file
		await storage.markUsageLimitReached("openai-codex", "sess-1", { retryAfterMs: 60_000 });
		const saved = await Bun.file(poolPath).json();
		expect(saved.cooldowns["openai:email:beta@example.com"]?.blockedUntil).toBeGreaterThan(Date.now());
		storage.close();
	});
});
