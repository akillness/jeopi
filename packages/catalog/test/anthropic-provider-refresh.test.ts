import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "../src/model-manager";
import { anthropicModelManagerOptions } from "../src/provider-models/openai-compat";
import type { FetchImpl } from "../src/types";

const tempDirs: string[] = [];
afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function cachePath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeopi-anthropic-refresh-"));
	tempDirs.push(dir);
	return path.join(dir, "models.db");
}

function liveModel(id: string) {
	return {
		id,
		display_name: `Live ${id}`,
		max_input_tokens: 1_000_000,
		max_tokens: 128_000,
		capabilities: { thinking: { supported: true }, image_input: { supported: true } },
	};
}

describe("Anthropic provider refresh", () => {
	it("discovers every page using OAuth and first-party capabilities even when public metadata is unavailable", async () => {
		const requests: { url: string; bearer: string | null; apiKey: string | null }[] = [];
		const fetch: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url === "https://models.dev/api.json") return new Response("unavailable", { status: 503 });
			const headers = new Headers(init?.headers);
			requests.push({ url, bearer: headers.get("authorization"), apiKey: headers.get("x-api-key") });
			if (url === "https://api.anthropic.com/v1/models") {
				return Response.json({ data: [liveModel("claude-opus-5-5")], has_more: true, last_id: "claude-opus-5-5" });
			}
			if (url === "https://api.anthropic.com/v1/models?after_id=claude-opus-5-5") {
				return Response.json({
					data: [liveModel("claude-sonnet-5-5"), liveModel("claude-sonnet-6-2")],
					has_more: false,
				});
			}
			throw new Error(`Unexpected endpoint: ${url}`);
		};
		const result = await resolveProviderModels(
			{ ...anthropicModelManagerOptions({ apiKey: "sk-ant-oat01-test", fetch }), cacheDbPath: await cachePath() },
			"online",
		);
		expect(result.stale).toBe(false);
		for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-6-2"]) {
			expect(result.models.find(model => model.id === id)).toMatchObject({
				name: `Live ${id}`,
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com/v1",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				thinking: { mode: "anthropic-adaptive", effortMap: { high: "xhigh", xhigh: "max" } },
			});
		}
		expect(requests).toEqual([
			{ url: "https://api.anthropic.com/v1/models", bearer: "Bearer sk-ant-oat01-test", apiKey: null },
			{
				url: "https://api.anthropic.com/v1/models?after_id=claude-opus-5-5",
				bearer: "Bearer sk-ant-oat01-test",
				apiKey: null,
			},
		]);
	});

	it.each(["https://proxy.example/anthropic", "https://proxy.example/anthropic/v1/"])(
		"normalizes %s without duplicating /v1 and uses API-key authentication",
		async baseUrl => {
			const fetch: FetchImpl = async (input, init) => {
				if (String(input) === "https://models.dev/api.json") return Response.json({});
				expect(String(input)).toBe("https://proxy.example/anthropic/v1/models");
				const headers = new Headers(init?.headers);
				expect(headers.get("x-api-key")).toBe("sk-ant-api03-test");
				expect(headers.get("authorization")).toBeNull();
				return Response.json({ data: [liveModel("claude-sonnet-6-2")], has_more: false });
			};
			const options = anthropicModelManagerOptions({ apiKey: "sk-ant-api03-test", baseUrl, fetch });
			const models = await options.fetchDynamicModels?.();
			expect(models?.map(model => model.id)).toEqual(["claude-sonnet-6-2"]);
		},
	);

	it("prefers live limits and explicit disabled capabilities while retaining reference pricing", async () => {
		const fetch: FetchImpl = async input => {
			if (String(input) === "https://models.dev/api.json") {
				return Response.json({
					anthropic: {
						models: {
							"claude-sonnet-6-2": {
								tool_call: true,
								reasoning: true,
								modalities: { input: ["text", "image"] },
								limit: { context: 200_000, output: 8_192 },
								cost: { input: 2, output: 10 },
							},
						},
					},
				});
			}
			return Response.json({
				data: [
					{
						...liveModel("claude-sonnet-6-2"),
						capabilities: { thinking: { supported: false }, image_input: { supported: false } },
					},
				],
				has_more: false,
			});
		};
		const models = await anthropicModelManagerOptions({ apiKey: "key", fetch }).fetchDynamicModels?.();
		expect(models?.[0]).toMatchObject({
			reasoning: false,
			input: ["text"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 2, output: 10 },
		});
	});

	it.each(["http-error", "invalid-json", "missing-cursor", "repeated-cursor"])(
		"keeps the complete cache rather than persisting a partial catalog on %s",
		async failure => {
			let fail = false;
			let pages = 0;
			const fetch: FetchImpl = async input => {
				if (String(input) === "https://models.dev/api.json") return Response.json({});
				if (!fail) return Response.json({ data: [liveModel("claude-sonnet-6-2")], has_more: false });
				pages++;
				if (pages === 1 || failure === "repeated-cursor") {
					return Response.json({
						data: [liveModel("claude-opus-6-2")],
						has_more: true,
						...(failure !== "missing-cursor" && { last_id: "claude-opus-6-2" }),
					});
				}
				return failure === "invalid-json" ? new Response("not JSON") : new Response("unavailable", { status: 503 });
			};
			const options = { ...anthropicModelManagerOptions({ apiKey: "key", fetch }), cacheDbPath: await cachePath() };
			await resolveProviderModels(options, "online");
			fail = true;
			const fallback = await resolveProviderModels(options, "online");
			expect(fallback.stale).toBe(true);
			expect(fallback.models.some(model => model.id === "claude-sonnet-6-2")).toBe(true);
			expect(fallback.models.some(model => model.id === "claude-opus-6-2")).toBe(false);
			expect(pages).toBe(failure === "missing-cursor" ? 1 : 2);
		},
	);
});
