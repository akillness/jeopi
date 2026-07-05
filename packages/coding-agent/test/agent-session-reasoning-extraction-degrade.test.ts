import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "jeopi-agent-core";
import type { AssistantMessage, Model } from "jeopi-ai";
import { createMockModel } from "jeopi-ai/providers/mock";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { AgentSession } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { TempDir } from "jeopi-utils";

/**
 * A `reasoning_extraction` classifier refusal is payload-shape-bound: resending
 * the identical batch (unsigned prior thinking replayed as plaintext) predictably
 * re-refuses. `AgentSession` degrades once — strips unsigned thinking/redactedThinking
 * from active context and resends on the *same* model — instead of pinning a
 * configured fallback or burning the generic backoff ladder on an unchanged payload.
 */

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function priorUnsignedThinkingTurn(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Prior unsigned scratch reasoning from an earlier turn." },
			{ type: "text", text: "Earlier answer." },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now() - 1000,
	};
}

describe("AgentSession reasoning_extraction degrade", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-reasoning-extraction-degrade-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	it("strips unsigned prior thinking and resends on the same model instead of pinning the configured fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const reasoningExtractionDetails = {
			type: "refusal",
			category: "reasoning_extraction",
			explanation:
				"This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.",
		};

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [priorUnsignedThinkingTurn(primaryModel)],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider !== primaryModel.provider || model.id !== primaryModel.id) {
					throw new Error(
						`reasoning_extraction degrade should retry the same model, not fall back to ${model.provider}/${model.id}`,
					);
				}
				primaryAttempts += 1;
				if (primaryAttempts === 1) {
					mock.push({
						content: ["Blocked."],
						stopReason: "error",
						stopDetails: reasoningExtractionDetails,
						errorMessage: `Refusal (reasoning_extraction): ${reasoningExtractionDetails.explanation}`,
					});
				} else {
					mock.push({ content: ["Recovered without replaying prior thinking."] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			// A fallback chain is configured but must NOT be used: the reasoning_extraction
			// degrade takes priority over the fallback-pin ladder and resends same-model.
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Trigger a reasoning_extraction refusal");
		await session.waitForIdle();

		// Resent on the same model twice; the configured fallback was never touched.
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);

		const lastMessage = session.messages.at(-1);
		if (lastMessage?.role !== "assistant") {
			throw new Error("Expected final assistant message");
		}
		expect(lastMessage.stopReason).toBe("stop");

		// The unsigned thinking from the earlier turn was stripped from active context;
		// its text content survives.
		const strippedTurn = session.messages.find(
			m => m.role === "assistant" && m.content.some(b => b.type === "text" && b.text === "Earlier answer."),
		) as AssistantMessage | undefined;
		expect(strippedTurn).toBeDefined();
		expect(strippedTurn?.content.some(b => b.type === "thinking")).toBe(false);
	});
});
