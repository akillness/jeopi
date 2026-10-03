import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "jeopi-ai";
import type { OAuthLoginCallbacks } from "jeopi-ai/oauth/types";
import { anthropicProvider } from "jeopi-ai/registry/anthropic";
import { openaiCodexDeviceProvider } from "jeopi-ai/registry/openai-codex-device";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { AuthStorage } from "jeopi-cli/session/auth-storage";

const callbacks: OAuthLoginCallbacks = { onAuth: () => {}, onPrompt: async () => "" };
let dir: string;
let auth: AuthStorage;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeopi-login-refresh-"));
	auth = await AuthStorage.create(":memory:");
});
afterEach(async () => {
	vi.restoreAllMocks();
	auth.close();
	await fs.rm(dir, { recursive: true, force: true });
});

function registry(fetch: FetchImpl): ModelRegistry {
	return new ModelRegistry(auth, path.join(dir, "models.yml"), { fetch });
}

function model(id: string) {
	return {
		id,
		display_name: id,
		max_input_tokens: 1_000_000,
		max_tokens: 128_000,
		capabilities: { thinking: { supported: true }, image_input: { supported: true } },
	};
}

describe("ModelRegistry login", () => {
	it("bypasses a fresh catalog after re-login and makes newly released models immediately selectable", async () => {
		await auth.set("anthropic", {
			type: "oauth",
			access: "sk-ant-oat01-test",
			refresh: "test",
			expires: Date.now() + 3_600_000,
		});
		let available = ["claude-sonnet-6-1"];
		const fetch: FetchImpl = async (input, init) => {
			if (String(input) === "https://models.dev/api.json") return Response.json({});
			expect(String(input)).toBe("https://api.anthropic.com/v1/models");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-ant-oat01-test");
			return Response.json({ data: available.map(model), has_more: false });
		};
		const models = registry(fetch);
		await models.refreshProvider("anthropic", "online");
		expect(models.find("anthropic", "claude-sonnet-6-1")).toBeDefined();
		expect(models.find("anthropic", "claude-sonnet-6-2")).toBeUndefined();
		available = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-6-2"];
		await models.refreshProvider("anthropic", "online-if-uncached");
		expect(models.find("anthropic", "claude-sonnet-6-2")).toBeUndefined();
		vi.spyOn(anthropicProvider, "login").mockResolvedValue({
			access: "sk-ant-oat01-test",
			refresh: "test",
			expires: Date.now() + 3_600_000,
		});
		await models.login("anthropic", callbacks);
		for (const id of available) {
			expect(
				models.getAvailable().find(candidate => candidate.provider === "anthropic" && candidate.id === id),
			).toMatchObject({
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				thinking: { mode: "anthropic-adaptive" },
			});
		}
	});

	it("does not discover models or save credentials when authentication fails", async () => {
		const requested: string[] = [];
		const models = registry(async input => {
			requested.push(String(input));
			return Response.json({});
		});
		vi.spyOn(anthropicProvider, "login").mockRejectedValue(new Error("Authorization denied"));
		await expect(models.login("anthropic", callbacks)).rejects.toThrow("Authorization denied");
		expect(requested).toEqual([]);
		expect(auth.has("anthropic")).toBe(false);
	});

	it("keeps a successful login and cached models when discovery is unavailable", async () => {
		const models = registry(async () => new Response("unavailable", { status: 503 }));
		vi.spyOn(anthropicProvider, "login").mockResolvedValue({
			access: "sk-ant-oat01-test",
			refresh: "test",
			expires: Date.now() + 3_600_000,
		});
		await models.login("anthropic", callbacks);
		expect(auth.hasOAuth("anthropic")).toBe(true);
		expect(
			models.getAvailable().some(model => model.provider === "anthropic" && model.id === "claude-opus-4-8"),
		).toBe(true);
	});

	it("discovers Codex models after device login using the provider that stores the credentials", async () => {
		const requests: string[] = [];
		const models = registry(async input => {
			requests.push(String(input));
			return Response.json({
				models: [
					{
						slug: "gpt-6-device-test",
						display_name: "Device model",
						context_window: 272_000,
						supported_in_api: true,
						input_modalities: ["text"],
						supported_reasoning_levels: ["low", "high"].map(effort => ({ effort })),
					},
				],
			});
		});
		vi.spyOn(openaiCodexDeviceProvider, "login").mockResolvedValue({
			access: "codex-device-token",
			refresh: "test",
			expires: Date.now() + 3_600_000,
			accountId: "device-account",
		});
		await models.login("openai-codex-device", callbacks);
		expect(auth.hasOAuth("openai-codex")).toBe(true);
		expect(auth.has("openai-codex-device")).toBe(false);
		expect(
			models.getAvailable().find(model => model.provider === "openai-codex" && model.id === "gpt-6-device-test"),
		).toMatchObject({ name: "Device model", contextWindow: 272_000 });
		expect(requests.some(url => url.includes("/codex/models"))).toBe(true);
	});
});
