import { describe, expect, it } from "bun:test";
import { CATALOG_PROVIDERS } from "jeopi-catalog/provider-models/descriptors";
import {
	buildTencentStaticSeed,
	TENCENT_BASE_URL,
	TENCENT_DEFAULT_MODEL,
	tencentModelManagerOptions,
} from "jeopi-catalog/provider-models/tencent";
import modelsJson from "../src/models.json";

interface BundledModel {
	id: string;
	api: string;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: string[];
}

describe("tencent static seed", () => {
	it("builds exactly the 16 Tencent Cloud MaaS models, all anthropic-messages / provider tencent", () => {
		const models = buildTencentStaticSeed();
		expect(models).toHaveLength(16);
		for (const model of models) {
			expect(model.api).toBe("anthropic-messages");
			expect(model.provider).toBe("tencent");
			expect(model.baseUrl).toBe(TENCENT_BASE_URL);
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(model.contextWindow).toBe(128_000);
			expect(model.maxTokens).toBe(8192);
		}
		expect(models.map(m => m.id)).toEqual([
			"deepseek-v4-pro",
			"deepseek-v4-pro-202606",
			"deepseek-v4-flash",
			"deepseek-v4-flash-202605",
			"deepseek-v3.2",
			"minimax-m3",
			"minimax-m2.7",
			"minimax-m2.5",
			"glm-5.2",
			"glm-5.1",
			"glm-5",
			"glm-5-turbo",
			"glm-5v-turbo",
			"kimi-k2.6",
			"kimi-k2.5",
			"hy-mt2-plus",
		]);
	});

	it("marks every model reasoning-capable except the Hunyuan translation model", () => {
		const models = buildTencentStaticSeed();
		const hunyuan = models.find(m => m.id === "hy-mt2-plus");
		expect(hunyuan?.reasoning).toBe(false);
		for (const model of models.filter(m => m.id !== "hy-mt2-plus")) {
			expect(model.reasoning).toBe(true);
		}
	});

	it("only GLM-5V Turbo accepts image input", () => {
		const models = buildTencentStaticSeed();
		const imageModels = models.filter(m => m.input.includes("image"));
		expect(imageModels.map(m => m.id)).toEqual(["glm-5v-turbo"]);
	});

	it("supports a base-URL override for every model", () => {
		const models = buildTencentStaticSeed("https://custom.tencent.example/v1");
		expect(models.every(m => m.baseUrl === "https://custom.tencent.example/v1")).toBe(true);
	});

	it("tencentModelManagerOptions carries the static seed under providerId tencent", () => {
		const options = tencentModelManagerOptions();
		expect(options.providerId).toBe("tencent");
		expect(options.staticModels).toHaveLength(16);
		expect(options.staticModels?.every(m => m.baseUrl === TENCENT_BASE_URL)).toBe(true);
	});

	it("is registered in CATALOG_PROVIDERS with the expected default model and env var", () => {
		const entry = CATALOG_PROVIDERS.find(p => p.id === "tencent");
		expect(entry).toBeDefined();
		expect(entry?.defaultModel).toBe(TENCENT_DEFAULT_MODEL);
		expect(entry?.envVars).toEqual(["TENCENT_API_KEY"]);
	});
});

describe("tencent bundled catalog", () => {
	it("ships all 16 curated models in the generated models.json", () => {
		const tencent = (modelsJson as Record<string, Record<string, BundledModel>>).tencent;
		expect(tencent).toBeDefined();
		const entries = Object.values(tencent);
		expect(entries).toHaveLength(16);
		for (const model of entries) {
			expect(model.api).toBe("anthropic-messages");
			expect(model.provider).toBe("tencent");
			expect(model.baseUrl).toBe(TENCENT_BASE_URL);
		}
	});
});
