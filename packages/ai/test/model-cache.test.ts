import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "jeopi-ai/types";
import { buildModel } from "jeopi-catalog/build";
import { readModelCache, writeModelCache } from "jeopi-catalog/model-cache";
import { removeWithRetries } from "../../utils/src/temp";

const TTL_MS = 24 * 60 * 60 * 1000;

function createModel(id: string, name: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name,
		api: "openai-completions",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 4096,
		maxTokens: 1024,
	});
}

describe("model cache migrations", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-model-cache-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
			dbPath = "";
		}
	});

	it("omits every header from persisted models without mutating the live model", async () => {
		const model = createModel("credential-model", "Credential Model");
		const headers = {
			Authorization: "Bearer synthetic-cache-secret",
			"X-Custom-Credential": "synthetic-arbitrary-secret",
			"X-Public-Header": "synthetic-header-value",
		};
		model.headers = headers;
		writeModelCache("ollama-cloud", 10_000, [model], true, "static-secret-test", dbPath);

		const db = new Database(dbPath, { readonly: true });
		try {
			const row = db.query<{ models: string }, []>("SELECT models FROM model_cache").get();
			expect(row).not.toBeNull();
			expect(JSON.parse(row!.models)[0]).not.toHaveProperty("headers");
			const rawRows = JSON.stringify(db.query("SELECT * FROM model_cache").all());
			for (const [name, value] of Object.entries(headers)) {
				expect(rawRows).not.toContain(name);
				expect(rawRows).not.toContain(value);
			}
		} finally {
			db.close();
		}
		const bytes = await fs.readFile(dbPath);
		for (const value of Object.values(headers)) expect(bytes.includes(value)).toBe(false);
		expect(model.headers).toEqual(headers);
		expect(readModelCache("ollama-cloud", TTL_MS, () => 10_000, dbPath)?.models.map(cached => cached.id)).toEqual([
			model.id,
		]);
	});

	it("invalidates and scrubs schema-8 rows that predate header sanitization", async () => {
		const legacyModel = createModel("legacy-secret-model", "Legacy Secret Model");
		legacyModel.headers = { Authorization: "Bearer synthetic-legacy-secret", "X-Key": "synthetic-legacy-key" };
		const db = new Database(dbPath, { create: true });
		try {
			db.run(`CREATE TABLE model_cache (
				provider_id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
				authoritative INTEGER NOT NULL, static_fingerprint TEXT NOT NULL, models TEXT NOT NULL
			)`);
			db.run("INSERT INTO model_cache VALUES (?, ?, ?, ?, ?, ?)", [
				"ollama-cloud",
				8,
				10_000,
				1,
				"legacy-static",
				JSON.stringify([legacyModel]),
			]);
		} finally {
			db.close();
		}
		expect((await fs.readFile(dbPath)).includes("synthetic-legacy-secret")).toBe(true);
		expect(readModelCache("ollama-cloud", TTL_MS, () => 10_000, dbPath)).toBeNull();
		const bytes = await fs.readFile(dbPath);
		expect(bytes.includes("synthetic-legacy-secret")).toBe(false);
		expect(bytes.includes("synthetic-legacy-key")).toBe(false);
	});

	it("invalidates legacy cached models and lets the next discovery write fresh ones", () => {
		const legacyModel = createModel("legacy-cloud-model", "Legacy Cloud Model");
		const legacyDb = new Database(dbPath, { create: true });
		legacyDb.run(`
			CREATE TABLE model_cache (
				provider_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				authoritative INTEGER NOT NULL DEFAULT 0,
				models TEXT NOT NULL
			)
		`);
		legacyDb.run(
			"INSERT INTO model_cache (provider_id, version, updated_at, authoritative, models) VALUES (?, ?, ?, ?, ?)",
			["ollama-cloud", 2, Date.now(), 1, JSON.stringify([legacyModel])],
		);
		legacyDb.close();

		const migrated = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, Date.now, dbPath);
		expect(migrated).toBeNull();

		const replacementModel = createModel("fresh-cloud-model", "Fresh Cloud Model");
		writeModelCache("ollama-cloud", Date.now(), [replacementModel], true, "static-v3", dbPath);

		const fresh = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, Date.now, dbPath);
		expect(fresh?.models.map(model => model.id)).toEqual(["fresh-cloud-model"]);
		expect(fresh?.staticFingerprint).toBe("static-v3");
	});
});
