import type { ProviderConfigInput } from "jeopi-cli/config/model-registry";

/** Fixed context-promotion contract, independent of a subscription's current catalog. */
export const codexContextFixture: ProviderConfigInput = {
	api: "openai-codex-responses",
	apiKey: "test-key",
	baseUrl: "https://chatgpt.com/backend-api",
	models: [
		{
			id: "gpt-5.3-codex-spark",
			name: "Small context fixture",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 128_000,
			contextPromotionTarget: "openai-codex/gpt-5.5",
		},
		{
			id: "gpt-5.3-codex",
			name: "Codex session fixture",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		},
		{
			id: "gpt-5.5",
			name: "Large context fixture",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_050_000,
			maxTokens: 128_000,
		},
	],
};
