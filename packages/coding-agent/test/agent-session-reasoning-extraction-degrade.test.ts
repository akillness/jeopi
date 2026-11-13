import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, filterProviderReplayMessages } from "jeopi-agent-core";
import type { AssistantMessage, Context, Message, Model } from "jeopi-ai";
import { convertAnthropicMessages } from "jeopi-ai/providers/anthropic";
import { createMockModel } from "jeopi-ai/providers/mock";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { AgentSession, type AgentSessionEvent } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import {
	type CustomMessage,
	convertToLlm,
	type InterruptedThinkingDetails,
	USER_INTERRUPT_LABEL,
} from "jeopi-cli/session/messages";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { TempDir } from "jeopi-utils";

/** A refusal permits one genuine context repair, never unchanged-payload retries or fallback cycling. */

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

function legacyInterruptedThinking(text: string): CustomMessage<InterruptedThinkingDetails> {
	return { role: "custom", customType: "interrupted-thinking", content: text, display: false, timestamp: 1 };
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

	it("does not journal refused tool partials after a deferred extension finishes", async () => {
		const model = getBundledModel("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const blocked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const terminal = Promise.withResolvers<void>();
		const details = {
			type: "refusal",
			category: "reasoning_extraction",
			explanation: "Private reasoning was requested.",
		};
		const errorMessage = `Refusal (reasoning_extraction): ${details.explanation}`;
		const mock = createMockModel({ id: model.id, provider: model.provider });
		mock.push({
			content: [{ type: "toolCall", id: "deferred-unsafe-1", name: "write", arguments: { path: "LICENSE" } }],
			stopReason: "error",
			stopDetails: details,
			errorMessage,
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], messages: [], tools: [] },
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			extensionRunner: {
				hasHandlers: (type: string) => type === "message_end",
				emitBeforeAgentStart: async () => undefined,
				emit: async (event: { type: string; message?: AgentMessage }) => {
					if (event.type === "message_end" && event.message?.role === "toolResult") {
						blocked.resolve();
						await release.promise;
					}
				},
			} as never,
		});
		session.subscribe(event => {
			if (event.type === "agent_end") terminal.resolve();
		});
		const prompt = session.prompt("Complete the edit.");
		try {
			await blocked.promise;
			await terminal.promise;
			expect(session.messages.findLast(message => message.role === "assistant")).toMatchObject({
				content: [],
				stopReason: "error",
				stopDetails: details,
				errorMessage,
			});
		} finally {
			release.resolve();
			await prompt;
			await session.waitForIdle();
		}
		const restored = session.sessionManager.buildSessionContext().messages;
		expect(restored.findLast(message => message.role === "assistant")).toMatchObject({
			content: [],
			stopReason: "error",
			stopDetails: details,
			errorMessage,
		});
		expect(restored.filter(message => message.role === "toolResult")).toEqual([]);
		expect(session.messages.filter(message => message.role === "toolResult")).toEqual([]);
	});

	it.each(["claude-opus-5-5", "claude-sonnet-5-5"])(
		"drops legacy private continuity before the first official request: %s",
		modelId => {
			const model = getBundledModel("anthropic", modelId);
			if (!model) throw new Error("Expected bundled Anthropic model");
			const history: AgentMessage[] = [
				legacyInterruptedThinking("PRIVATE_LEGACY_REASONING"),
				{ role: "user", content: "Continue the coding task.", timestamp: 2 },
			];
			const before = structuredClone(history);
			const converted = convertToLlm(history, model);
			expect(converted).toEqual([
				{ role: "user", content: "Continue the coding task.", attribution: "user", timestamp: 2 },
			]);
			expect(history).toEqual(before);
		},
	);

	it("preserves third-party legacy continuity when its endpoint permits reasoning replay", () => {
		const model = getBundledModel("nanogpt", "deepseek-reasoner");
		if (!model) throw new Error("Expected bundled third-party reasoning model");
		const converted = convertToLlm([legacyInterruptedThinking("Native reasoning continuity.")], model);
		expect(converted).toEqual([
			expect.objectContaining({
				role: "developer",
				content: [{ type: "text", text: "Native reasoning continuity." }],
			}),
		]);
	});

	it.each(["claude-opus-5-5", "claude-sonnet-5-5"])(
		"repairs independent legacy plaintext refusals without losing native history: %s",
		async modelId => {
			const model = getBundledModel("anthropic", modelId);
			const fallback = getBundledModel("openai", "gpt-4o-mini");
			if (!model || !fallback) throw new Error("Expected bundled models");
			const nativeTurn = priorUnsignedThinkingTurn(model);
			nativeTurn.content = [
				{ type: "thinking", thinking: "Signed reasoning.", thinkingSignature: "native-signature" },
				{ type: "redactedThinking", data: "opaque-native-blob" },
				{ type: "text", text: "Earlier answer." },
			];
			const contexts: Message[][] = [];
			const requestedModels: string[] = [];
			const mock = createMockModel({ id: model.id, provider: model.provider });
			const details = {
				type: "refusal",
				category: "reasoning_extraction",
				explanation: "Private reasoning was requested in context.",
			};
			const agent = new Agent({
				getApiKey: m => `${m.provider}-test-key`,
				convertToLlm,
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [nativeTurn, legacyInterruptedThinking("PRIVATE_FIRST_CONTINUITY")],
				},
				streamFn: (requestedModel, context, options) => {
					requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
					contexts.push(structuredClone(context.messages));
					mock.push(
						contexts.length % 2 === 1
							? {
									content: ["Blocked."],
									stopReason: "error",
									stopDetails: details,
									errorMessage: `Refusal (reasoning_extraction): ${details.explanation}`,
								}
							: { content: [`Answer ${contexts.length / 2}.`] },
					);
					return mock.stream(requestedModel, context, options);
				},
			});
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.fallbackChains": { default: [`${fallback.provider}/${fallback.id}`] },
			});
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				convertToLlm,
			});
			await session.prompt("Complete the first edit.");
			await session.waitForIdle();
			expect(session.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Answer 1." }],
			});
			agent.appendMessage(legacyInterruptedThinking("PRIVATE_SECOND_CONTINUITY"));
			await session.prompt("Complete the independent second edit.");
			await session.waitForIdle();
			expect(session.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Answer 2." }],
			});
			expect(requestedModels).toEqual(Array(4).fill(`${model.provider}/${model.id}`));
			for (const index of [0, 2])
				expect(JSON.stringify(contexts[index])).toContain(
					index === 0 ? "PRIVATE_FIRST_CONTINUITY" : "PRIVATE_SECOND_CONTINUITY",
				);
			for (const index of [1, 3]) {
				expect(JSON.stringify(contexts[index])).not.toContain("PRIVATE_");
				expect(contexts[index]).toContainEqual(nativeTurn);
			}
		},
	);

	it.each(
		["claude-opus-5-5", "claude-sonnet-5-5"].flatMap(modelId =>
			[
				"clean request",
				"repair still refused",
				"refusal-only thinking",
				"raw-only history",
				"already filtered legacy",
				"safe continuity marker",
				"unsafe tool call",
			].map(scenario => ({ modelId, scenario })),
		),
	)("surfaces reasoning_extraction without cycling: $modelId / $scenario", async ({ modelId, scenario }) => {
		const model = getBundledModel<"anthropic-messages">("anthropic", modelId);
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Expected bundled test models");
		const details = {
			type: "refusal",
			category: "reasoning_extraction",
			explanation:
				"This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.",
		};
		const errorMessage = `Refusal (reasoning_extraction): ${details.explanation}`;
		const requestedModels: string[] = [];
		const contexts: Message[][] = [];
		const events: AgentSessionEvent[] = [];
		const mock = createMockModel({ id: model.id, provider: model.provider });
		const expectedAttempts = scenario === "repair still refused" ? 2 : 1;
		const agent = new Agent({
			getApiKey: m => `${m.provider}-test-key`,
			convertToLlm: messages => convertToLlm(messages, scenario === "already filtered legacy" ? model : undefined),
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages:
					scenario === "repair still refused" ||
					scenario === "unsafe tool call" ||
					scenario === "already filtered legacy"
						? [legacyInterruptedThinking("PRIVATE_LEGACY_CONTINUITY")]
						: scenario === "raw-only history"
							? [priorUnsignedThinkingTurn(model)]
							: scenario === "safe continuity marker"
								? [
										{
											...legacyInterruptedThinking("The previous response was interrupted."),
											details: {
												interruptedAt: 1,
												provider: model.provider,
												model: model.id,
												reasoningIncluded: false,
											},
										},
									]
								: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				contexts.push(structuredClone(context.messages));
				// An erroneous resend finishes deterministically, so the assertion—not
				// a timeout or the production backoff budget—detects unwanted retries.
				mock.push(
					requestedModels.length > expectedAttempts
						? { content: ["Unexpected retry succeeded."] }
						: {
								content:
									scenario === "clean request"
										? ["Blocked."]
										: scenario === "unsafe tool call"
											? [
													{
														type: "toolCall",
														id: "unsafe-1",
														name: "write",
														arguments: { path: "LICENSE", content: "partial" },
													},
													"Blocked.",
												]
											: [
													{
														type: "thinking",
														thinking: "Fresh reasoning emitted by this refused response.",
													},
													"Blocked.",
												],
								stopReason: "error",
								stopDetails: details,
								errorMessage,
							},
				);
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { default: [`${fallback.provider}/${fallback.id}`] },
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			convertToLlm: messages => convertToLlm(messages, scenario === "already filtered legacy" ? model : undefined),
		});
		const unsubscribe = session.subscribe(event => events.push(event));
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			await session.prompt("Summarize the completed coding work.");
			await session.waitForIdle();
			expect(requestedModels).toEqual(Array(expectedAttempts).fill(`${model.provider}/${model.id}`));
			const finalMessage = session.messages.findLast(message => message.role === "assistant");
			expect(finalMessage).toMatchObject({
				role: "assistant",
				content: [],
				stopReason: "error",
				stopDetails: details,
				errorMessage,
			});
			expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(expectedAttempts - 1);
			expect(events.filter(event => event.type === "retry_fallback_applied")).toEqual([]);
			expect(events.filter(event => event.type === "auto_retry_end")).toContainEqual(
				expect.objectContaining({ success: false, finalError: errorMessage }),
			);
			if (scenario === "repair still refused") {
				expect(JSON.stringify(contexts[0])).toContain("PRIVATE_LEGACY_CONTINUITY");
				expect(JSON.stringify(contexts[1])).not.toContain("PRIVATE_LEGACY_CONTINUITY");
			}
			const restoredMessages = session.sessionManager.buildSessionContext().messages;
			expect(restoredMessages.findLast(message => message.role === "assistant")).toMatchObject({
				role: "assistant",
				content: [],
				stopReason: "error",
				stopDetails: details,
				errorMessage,
			});
			for (const history of [session.messages, restoredMessages]) {
				const replay = filterProviderReplayMessages(convertToLlm(history));
				const wire = convertAnthropicMessages(replay, model, false);
				expect(JSON.stringify(wire)).not.toContain("Fresh reasoning emitted by this refused response.");
				expect(JSON.stringify(wire)).not.toContain(errorMessage);
				if (scenario === "unsafe tool call") expect(JSON.stringify(wire)).not.toContain("unsafe-1");
			}
		} finally {
			waitSpy.mockRestore();
			unsubscribe();
		}
	});

	it.each(
		["claude-opus-5-5", "claude-sonnet-5-5"].flatMap(modelId => [false, true].map(refuse => ({ modelId, refuse }))),
	)(
		"isolates Anthropic side requests from legacy plaintext and live state: $modelId / refusal=$refuse",
		async ({ modelId, refuse }) => {
			const model = getBundledModel("anthropic", modelId);
			if (!model) throw new Error("Expected bundled Anthropic model");
			const signed = {
				type: "thinking",
				thinking: "Signed native reasoning.",
				thinkingSignature: "native-signature",
			} as const;
			const redacted = { type: "redactedThinking", data: "opaque-native-blob" } as const;
			const toolCall = { type: "toolCall", id: "read-1", name: "read", arguments: { path: "LICENSE" } } as const;
			const historicalTurn: AssistantMessage = {
				...priorUnsignedThinkingTurn(model),
				content: [
					{ type: "thinking", thinking: "PRIVATE_HISTORY_REASONING" },
					signed,
					redacted,
					{ type: "text", text: "I inspected the license." },
					toolCall,
				],
			};
			const toolResult: AgentMessage = {
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "License permits this coding task." }],
				isError: false,
				timestamp: 1,
			};
			const continuity: CustomMessage<InterruptedThinkingDetails> = {
				role: "custom",
				customType: "interrupted-thinking",
				content: "PRIVATE_INTERRUPTED_REASONING",
				display: false,
				timestamp: 2,
			};
			const messages: AgentMessage[] = [historicalTurn, toolResult, continuity];
			const agent = new Agent({ initialState: { model, systemPrompt: ["Coding assistant"], messages, tools: [] } });
			const journal = SessionManager.inMemory();
			const capturedContexts: Context[] = [];
			const mock = createMockModel({ id: model.id, provider: model.provider });
			const explanation =
				"This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.";
			const errorMessage = `Refusal (reasoning_extraction): ${explanation}`;
			session = new AgentSession({
				agent,
				sessionManager: journal,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
				sideStreamFn: (requestedModel, context, options) => {
					capturedContexts.push(structuredClone(context));
					mock.push(
						refuse
							? {
									content: ["Blocked."],
									stopReason: "error",
									errorMessage,
									stopDetails: { type: "refusal", category: "reasoning_extraction", explanation },
								}
							: { content: ["The license permits the requested work."] },
					);
					return mock.stream(requestedModel, context, options);
				},
			});
			const streaming: AssistantMessage = {
				...priorUnsignedThinkingTurn(model),
				content: [
					{ type: "thinking", thinking: "PRIVATE_STREAM_REASONING" },
					{ type: "text", text: "The current edit is almost complete." },
				],
			};
			agent.emitExternalEvent({ type: "message_start", message: streaming });
			const beforeMessages = structuredClone(session.messages);
			const beforeStreaming = structuredClone(agent.state.streamMessage);
			const beforeJournal = structuredClone(journal.getEntries());
			if (refuse) {
				await expect(
					session.runEphemeralTurn({ promptText: "Summarize the completed coding work." }),
				).rejects.toThrow(errorMessage);
			} else {
				const result = await session.runEphemeralTurn({ promptText: "Summarize the completed coding work." });
				expect(result.replyText).toBe("The license permits the requested work.");
			}
			expect(capturedContexts).toHaveLength(1);
			const context = capturedContexts[0]!;
			expect(JSON.stringify(context.messages)).not.toContain("PRIVATE_INTERRUPTED_REASONING");
			expect(context.messages).toContainEqual(historicalTurn);
			expect(context.messages).toContainEqual(expect.objectContaining(toolResult));
			expect(context.messages).toContainEqual(streaming);
			expect(context.messages.at(-1)?.content).toEqual([
				{ type: "text", text: "Summarize the completed coding work." },
			]);
			expect(session.messages).toEqual(beforeMessages);
			expect(agent.state.streamMessage).toEqual(beforeStreaming);
			expect(journal.getEntries()).toEqual(beforeJournal);
		},
	);

	it("preserves native unsigned reasoning for a third-party side request", async () => {
		const model = getBundledModel("nanogpt", "deepseek-reasoner");
		if (!model) throw new Error("Expected bundled native reasoning model");
		const history = priorUnsignedThinkingTurn(model);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				messages: [history, { role: "user", content: "Continue the main task.", timestamp: 1 }],
				tools: [],
			},
		});
		const contexts: Message[][] = [];
		const mock = createMockModel({ id: model.id, provider: model.provider });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			sideStreamFn: (requestedModel, context, options) => {
				contexts.push(structuredClone(context.messages));
				mock.push({ content: ["Native reasoning accepted."] });
				return mock.stream(requestedModel, context, options);
			},
		});
		const streaming = {
			...priorUnsignedThinkingTurn(model),
			content: [
				{ type: "thinking" as const, thinking: "Live native reasoning." },
				{ type: "text" as const, text: "Partial answer." },
			],
		};
		agent.emitExternalEvent({ type: "message_start", message: streaming });
		const result = await session.runEphemeralTurn({ promptText: "Check progress." });
		expect(result.replyText).toBe("Native reasoning accepted.");
		expect(contexts).toHaveLength(1);
		expect(contexts[0]).toContainEqual(history);
		expect(contexts[0]).toContainEqual(streaming);
	});
});

/** Interrupted private reasoning stays local; official Anthropic receives a safe continuity marker. */
describe("AgentSession interrupted-thinking privacy on user interrupt", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-interrupted-thinking-disguise-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
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

	const RAW_REASONING = "Let me reconsider the plan and check the edge cases before responding to the user.";

	/**
	 * Drive a real `session.prompt()` turn whose stream ends in a genuine
	 * user-interrupt abort (`stopReason: "aborted"`, `errorMessage: USER_INTERRUPT_LABEL`,
	 * matching what `AgentSession#abort({ reason: USER_INTERRUPT_LABEL })` stamps
	 * on a real Esc-abort) with a trailing unsigned `thinking` block — the
	 * narrowest realistic trigger for `#demoteInterruptedThinkingOnUserInterrupt`,
	 * reached through the same `message_end` event path a live abort takes.
	 */
	async function runInterruptedThinkingTurn(model: Model): Promise<CustomMessage<InterruptedThinkingDetails>> {
		// Response metadata must identify the target provider for interruption policy selection.
		const mock = createMockModel({ id: model.id, provider: model.provider });
		mock.push({
			content: [{ type: "thinking", thinking: RAW_REASONING }],
			stopReason: "aborted",
			errorMessage: USER_INTERRUPT_LABEL,
		});

		const agent = new Agent({
			getApiKey: m => `${m.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (streamModel, context, options) => mock.stream(streamModel, context, options),
		});

		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Do something that takes a while to think about");
		await session.waitForIdle();

		const abortedTurn = session.messages.at(-2);
		if (abortedTurn?.role !== "assistant" || abortedTurn.stopReason !== "aborted") {
			throw new Error("Expected the penultimate message to be the aborted assistant turn");
		}
		expect(abortedTurn.content).toEqual([{ type: "thinking", thinking: RAW_REASONING }]);

		const continuity = session.messages.at(-1);
		if (continuity?.role !== "custom" || continuity.customType !== "interrupted-thinking") {
			throw new Error("Expected a hidden interrupted-thinking continuity message to follow the aborted turn");
		}
		return continuity as CustomMessage<InterruptedThinkingDetails>;
	}

	it.each(["claude-fable-5", "claude-opus-4-5", "claude-opus-5-5", "claude-sonnet-5-5"])(
		"does not replay interrupted private reasoning as plaintext for official Anthropic %s",
		async modelId => {
			const model = getBundledModel("anthropic", modelId);
			if (!model) throw new Error(`Expected bundled ${modelId}`);
			const continuity = await runInterruptedThinkingTurn(model);
			expect(continuity.content).not.toContain(RAW_REASONING);
		},
	);
});
