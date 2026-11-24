import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, Model } from "jeopi-ai";
import { buildModel } from "jeopi-catalog/build";
import {
	countContextOverrun,
	fitOutputTokensToContextWindow,
	MIN_FITTED_OUTPUT_TOKENS,
	type OutputBudgetTokenizer,
} from "../src/output-budget";

const baseModel: Model = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 4096,
});

const fixedTokenizer: OutputBudgetTokenizer = {
	countTokens: fragments => fragments.join("").length,
	countMessage: msg => {
		if (msg.role === "user") return typeof msg.content === "string" ? msg.content.length : 100;
		return 100;
	},
};

function anchorAssistant(inputTokens: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: baseModel.api,
		provider: baseModel.provider,
		model: baseModel.id,
		usage: {
			input: inputTokens,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 50,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

describe("output-budget context window guard", () => {
	it("clamps maxTokens to remaining context room and enforces MIN_FITTED_OUTPUT_TOKENS floor", () => {
		const ctx: Context = {
			messages: [anchorAssistant(7500, 1000), { role: "user", content: "x".repeat(200), timestamp: 2000 }],
		};
		// Anchor (7500 input + 50 output = 7550) + tail 200*1.1=220 + framing 16 + headway 64 = 7850 -> room 2150 (< 4096).
		expect(fitOutputTokensToContextWindow(baseModel, ctx, 4096, fixedTokenizer)).toBe(2150);

		const nearlyFull: Context = {
			messages: [anchorAssistant(9800, 1000)],
		};
		expect(fitOutputTokensToContextWindow(baseModel, nearlyFull, 4096, fixedTokenizer)).toBe(
			MIN_FITTED_OUTPUT_TOKENS,
		);
	});

	it("preserves explicit omission on OpenRouter models and skips Anthropic Claude 4.5+ self-truncating models", () => {
		const openRouter: Model = buildModel({
			id: "deepseek/deepseek-chat",
			name: "DeepSeek via OpenRouter",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 4096,
		});
		const ctx: Context = { messages: [anchorAssistant(8500, 1000)] };
		expect(fitOutputTokensToContextWindow(openRouter, ctx, undefined, fixedTokenizer)).toBeUndefined();

		const claude45: Model = buildModel({
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 4096,
		});
		expect(fitOutputTokensToContextWindow(claude45, ctx, 4096, fixedTokenizer)).toBe(4096);
	});

	it("detects local context overrun when prompt leaves less room than MIN_FITTED_OUTPUT_TOKENS", () => {
		const fits: Context = {
			messages: [{ role: "user", content: "x".repeat(2000), timestamp: 1000 }],
		};
		expect(countContextOverrun(fits, baseModel, fixedTokenizer)).toBeUndefined();

		const over: Context = {
			messages: [{ role: "user", content: "x".repeat(9200), timestamp: 1000 }],
		};
		expect(countContextOverrun(over, baseModel, fixedTokenizer)).toBe(9200);
	});
});
