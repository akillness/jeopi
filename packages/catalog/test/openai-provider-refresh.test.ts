import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "../src/build";
import { Effort } from "../src/effort";
import { resolveProviderModels } from "../src/model-manager";
import { openaiModelManagerOptions } from "../src/provider-models/openai-compat";
import { openaiCodexModelManagerOptions } from "../src/provider-models/special";
import type { FetchImpl } from "../src/types";

const metadata = {
	openai: {
		models: {
			"gpt-future-sol": {
				name: "GPT Future Sol",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"], output: ["text"] },
				limit: { context: 1_050_000, output: 128_000 },
				cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
			},
		},
	},
};

const tempDirs: string[] = [];
afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function cachePath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeopi-openai-refresh-"));
	tempDirs.push(dir);
	return path.join(dir, "models.db");
}

describe("OpenAI provider refresh", () => {
	it("discovers new, dated, and fine-tuned models with fresh first-party metadata and account availability", async () => {
		const requests: { url: string; authorization: string | null }[] = [];
		const fetch: FetchImpl = async (input, init) => {
			const url = String(input);
			requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
			return Response.json(
				url === "https://models.dev/api.json"
					? metadata
					: {
							data: [
								{ id: "gpt-future-sol" },
								{ id: "gpt-future-sol-2026-09-29" },
								{ id: "ft:gpt-future-sol:org:custom:123" },
								{ id: "gpt-live-1" },
								{ id: "gpt-audio-1.5" },
								{ id: "gpt-4o-transcribe" },
								{ id: "gpt-4o-mini-tts" },
								{ id: "gpt-4o-realtime-preview" },
								{ id: "chatgpt-image-latest" },
								{ id: "o3-deep-research" },
								{ id: "text-embedding-3-small" },
							],
						},
			);
		};
		const options = openaiModelManagerOptions({ apiKey: "account-a", fetch });
		const result = await resolveProviderModels({ ...options, cacheDbPath: await cachePath() }, "online");
		expect(result.stale).toBe(false);
		expect(result.models.map(model => model.id).sort()).toEqual(
			["gpt-future-sol", "gpt-future-sol-2026-09-29", "ft:gpt-future-sol:org:custom:123"].sort(),
		);
		for (const model of result.models) {
			expect(model).toMatchObject({
				provider: "openai",
				api: "openai-responses",
				name: "GPT Future Sol",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_050_000,
				maxTokens: 128_000,
				cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
			});
		}
		expect(requests).toContainEqual({ url: "https://models.dev/api.json", authorization: null });
		expect(requests).toContainEqual({ url: "https://api.openai.com/v1/models", authorization: "Bearer account-a" });
	});

	it("refreshes the catalog on each online request and retains bundled metadata during public metadata outages", async () => {
		let available = ["gpt-5.4"];
		const fetch: FetchImpl = async input => {
			if (String(input) === "https://models.dev/api.json") return new Response("unavailable", { status: 503 });
			return Response.json({ data: available.map(id => ({ id })) });
		};
		const options = { ...openaiModelManagerOptions({ apiKey: "account-a", fetch }), cacheDbPath: await cachePath() };
		const first = await resolveProviderModels(options, "online");
		expect(first.models.map(model => model.id)).toEqual(["gpt-5.4"]);
		expect(first.models[0]).toMatchObject({ reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000 });
		available = ["gpt-5.5"];
		const second = await resolveProviderModels(options, "online");
		expect(second.models.map(model => model.id)).toEqual(["gpt-5.5"]);
		available = [];
		const empty = await resolveProviderModels(options, "online");
		expect(empty.models).toEqual([]);
		expect(empty.stale).toBe(false);
	});

	it("does not reuse another credential's catalog and keeps cached models on API failure", async () => {
		let failed = false;
		const fetch: FetchImpl = async (input, init) => {
			if (String(input) === "https://models.dev/api.json") return Response.json(metadata);
			if (failed) return new Response("unavailable", { status: 503 });
			const id =
				new Headers(init?.headers).get("authorization") === "Bearer account-a" ? "gpt-5.4" : "gpt-future-sol";
			return Response.json({ data: [{ id }] });
		};
		const cacheDbPath = await cachePath();
		const accountA = { ...openaiModelManagerOptions({ apiKey: "account-a", fetch }), cacheDbPath };
		const accountB = { ...openaiModelManagerOptions({ apiKey: "account-b", fetch }), cacheDbPath };
		await resolveProviderModels(accountA, "online");
		const other = await resolveProviderModels(accountB, "online-if-uncached");
		expect(other.models.map(model => model.id)).toEqual(["gpt-future-sol"]);
		failed = true;
		const fallback = await resolveProviderModels(accountB, "online");
		expect(fallback.stale).toBe(true);
		expect(fallback.models.some(model => model.id === "gpt-future-sol")).toBe(true);
	});

	it("uses a Codex account's live list through the configured endpoint without stale bundled models", async () => {
		const requests: string[] = [];
		const fetch: FetchImpl = async input => {
			requests.push(String(input));
			return Response.json({
				models: [
					{
						slug: "gpt-6.1-sol",
						display_name: "GPT-6.1 Sol",
						context_window: 1_050_000,
						supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map(effort => ({ effort })),
						input_modalities: ["text", "image"],
						supported_in_api: true,
					},
				],
			});
		};
		const result = await resolveProviderModels(
			{
				...openaiCodexModelManagerOptions({
					accessToken: "codex-account-a",
					accountId: "account-a",
					clientVersion: "1.0.0",
					baseUrl: "https://codex.example/backend-api/codex/responses/",
					fetch,
				}),
				cacheDbPath: await cachePath(),
			},
			"online",
		);
		expect(requests).toEqual(["https://codex.example/backend-api/codex/models?client_version=1.0.0"]);
		expect(result.models.map(model => model.id)).toEqual(["gpt-6.1-sol"]);
		expect(result.models[0]).toMatchObject({ provider: "openai-codex", reasoning: true, contextWindow: 1_050_000 });
	});

	it("clamps disabled reasoning only for GPT-6 models that reject none", () => {
		for (const [id, expected] of [
			["gpt-6.1-sol", true],
			["gpt-6-astra", true],
			["ft:gpt-6-astra:org:custom:123", true],
			["gpt-6-sol", false],
			["gpt-6-luna", false],
		] as const) {
			const model = buildModel({
				id,
				name: id,
				provider: "openai",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_050_000,
				maxTokens: 128_000,
			});
			expect(model.thinking?.requiresEffort === true).toBe(expected);
			expect(model.thinking?.efforts[0]).toBe(Effort.Low);
		}
	});
});
