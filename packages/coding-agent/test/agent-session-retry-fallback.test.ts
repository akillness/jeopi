import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "jeopi-agent-core";
import { type AssistantMessage, Effort, type Model, type ProviderSessionState } from "jeopi-ai";
import { createMockModel } from "jeopi-ai/providers/mock";
import { buildModel } from "jeopi-catalog/build";
import { writeModelCache } from "jeopi-catalog/model-cache";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { parseModelPattern } from "jeopi-cli/config/model-resolver";
import { Settings } from "jeopi-cli/config/settings";
import type { ExtensionRunner } from "jeopi-cli/extensibility/extensions";
import { AgentSession, type AgentSessionEvent } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { TempDir } from "jeopi-utils";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

function trackRetryEvents(session: AgentSession): {
	retryStartEvents: AutoRetryStartEvent[];
	retryEndEvents: AutoRetryEndEvent[];
} {
	const retryStartEvents: AutoRetryStartEvent[] = [];
	const retryEndEvents: AutoRetryEndEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") {
			retryStartEvents.push(event);
		}
		if (event.type === "auto_retry_end") {
			retryEndEvents.push(event);
		}
	});
	return { retryStartEvents, retryEndEvents };
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage {
	const lastMessage = session.messages.at(-1);
	if (lastMessage?.role !== "assistant") {
		throw new Error("Expected final assistant message");
	}
	return lastMessage;
}

function createFallbackAgent(primaryModel: Model, requestedModels: string[]): Agent {
	const mock = createMockModel();
	let primaryAttempts = 0;
	return new Agent({
		getApiKey: model => `${model.provider}-test-key`,
		initialState: {
			model: primaryModel,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		streamFn: (model, context, options) => {
			requestedModels.push(`${model.provider}/${model.id}`);
			if (model.provider === primaryModel.provider && model.id === primaryModel.id && primaryAttempts === 0) {
				primaryAttempts += 1;
				mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
			} else {
				mock.push({ content: [`ok:${model.provider}/${model.id}`] });
			}
			return mock.stream(model, context, options);
		},
	});
}

describe("AgentSession retry fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sharedRegistry: ModelRegistry;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	// The model registry is an immutable fixture whose construction builds a
	// canonical index over ~2.7k bundled models (~100ms). Build it (and the
	// auth DB) once for the whole file instead of per-test; reset only the
	// mutable retry-fallback cooldown state between tests.
	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-fallback-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		authStorage.setRuntimeApiKey("google", "google-test-key");
		authStorage.setRuntimeApiKey("google-vertex", "google-vertex-test-key");
		authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");
		sharedRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		// Reset to the shared registry (a few tests reassign it to a scoped
		// instance) and clear cooldown suppressions left by fallback-path tests
		// (default 5-minute suppression) so state never leaks between tests.
		modelRegistry = sharedRegistry;
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	it("advances through a role-keyed fallback chain across retries", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !firstFallback || !secondFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const retryStartEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (model.provider === firstFallback.provider && model.id === firstFallback.id) {
					mock.push({ throw: "service unavailable: 503 overloaded" });
				} else if (model.provider === secondFallback.provider && model.id === secondFallback.id) {
					mock.push({ content: ["Recovered on second fallback"] });
				} else {
					throw new Error(`Unexpected model requested during retry fallback test: ${model.provider}/${model.id}`);
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [
					`${firstFallback.provider}/${firstFallback.id}`,
					`${secondFallback.provider}/${secondFallback.id}`,
				],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				retryStartEvents.push(event);
			}
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Recover from rate limits");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${firstFallback.provider}/${firstFallback.id}`,
			`${secondFallback.provider}/${secondFallback.id}`,
		]);
		expect(session.model?.provider).toBe(secondFallback.provider);
		expect(session.model?.id).toBe(secondFallback.id);
		expect(retryStartEvents.map(event => event.delayMs)).toEqual([0, 0]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${firstFallback.provider}/${firstFallback.id}`,
				role: "default",
			},
			{
				type: "retry_fallback_applied",
				from: `${firstFallback.provider}/${firstFallback.id}`,
				to: `${secondFallback.provider}/${secondFallback.id}`,
				role: "default",
			},
		]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 2 });
		expect(fallbackSucceededEvents).toEqual([
			{
				type: "retry_fallback_succeeded",
				model: `${secondFallback.provider}/${secondFallback.id}`,
				role: "default",
			},
		]);
	});

	it("falls back on structured classifier refusals and pins the fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const refusalDetails = {
			type: "refusal",
			category: "cyber",
			explanation: "Classifier declined this turn.",
		};
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					primaryAttempts += 1;
					mock.push({
						content: ["Classifier declined this turn."],
						stopReason: "error",
						stopDetails: refusalDetails,
						errorMessage: "Refusal (cyber): Classifier declined this turn.",
					});
				} else if (model.provider === fallbackModel.provider && model.id === fallbackModel.id) {
					mock.push({ content: [`ok:${primaryAttempts}`] });
				} else {
					throw new Error(
						`Unexpected model requested during refusal fallback test: ${model.provider}/${model.id}`,
					);
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("Recover from classifier refusal");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
		expect(fallbackSucceededEvents).toEqual([
			{
				type: "retry_fallback_succeeded",
				model: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		now += 10 * 60 * 1000;
		await session.prompt("Next turn stays pinned on fallback");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("drops surfaced classifier refusal messages before later prompts", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					content: ["Classifier declined this turn."],
					stopReason: "error",
					stopDetails: {
						type: "refusal",
						category: "bio",
						explanation: "Classifier declined this turn.",
					},
					errorMessage: "Refusal (bio): Classifier declined this turn.",
				},
				context => {
					const replayedAssistantText = context.messages
						.filter((message): message is AssistantMessage => message.role === "assistant")
						.flatMap(message => message.content)
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
					return {
						content: [replayedAssistantText.includes("Classifier declined this turn.") ? "polluted" : "clean"],
					};
				},
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => mock.stream(model, context, options),
		});

		// With retries enabled a classifier refusal now auto-resends (rung-4
		// backoff) instead of surfacing. Disable retries to exercise the
		// surfaced-refusal prune path (#3591): displayed as an error, but
		// dropped from active and saved context before the next prompt.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		const sessionStopCalls: number[] = [];
		const sessionStopLastAssistantMessages: Array<AssistantMessage | undefined> = [];
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn((event: { last_assistant_message?: AssistantMessage }) => {
				sessionStopCalls.push(mock.calls.length);
				sessionStopLastAssistantMessages.push(event.last_assistant_message);
				return Promise.resolve(undefined);
			}),
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("Trigger classifier refusal");
		await session.waitForIdle();
		await session.prompt("Next prompt should not replay the refusal");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const replayedAssistantText = mock.calls[1]?.context.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.flatMap(message => message.content)
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(replayedAssistantText).not.toContain("Classifier declined this turn.");
		expect(getLastAssistantMessage(session).content).toEqual([{ type: "text", text: "clean" }]);
		// session_stop hooks must fire after each settled turn — including the
		// refusal turn (regression: prior to PR #3594's review fix, the refusal
		// branch short-circuited before `#emitSessionStopEvent`).
		expect(sessionStopCalls).toEqual([1, 2]);
		expect(sessionStopLastAssistantMessages[0]?.stopReason).toBe("error");
		expect(sessionStopLastAssistantMessages[0]?.stopDetails).toEqual({
			type: "refusal",
			category: "bio",
			explanation: "Classifier declined this turn.",
		});
	});

	it("keeps resending with capped backoff after the refusal fallback ladder is exhausted", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !firstFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		process.env.PI_REFUSAL_BACKOFF_BASE_MS = "5";
		try {
			const requestedModels: string[] = [];
			const mock = createMockModel();
			let fallbackAttempts = 0;
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
						mock.push({ throw: "overloaded_error: provider returned error 503" });
					} else if (model.provider === firstFallback.provider && model.id === firstFallback.id) {
						fallbackAttempts += 1;
						if (fallbackAttempts <= 2) {
							mock.push({
								stopReason: "error",
								stopDetails: {
									type: "refusal",
									category: "cyber",
									explanation: "Classifier declined this fallback turn.",
								},
								errorMessage: "Refusal (cyber): Classifier declined this fallback turn.",
							});
						} else {
							mock.push({ content: [`recovered:${fallbackAttempts}`] });
						}
					} else {
						throw new Error(
							`Unexpected model requested during refusal backoff test: ${model.provider}/${model.id}`,
						);
					}
					return mock.stream(model, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxRetries": 1,
				"retry.fallbackChains": {
					default: [`${firstFallback.provider}/${firstFallback.id}`],
				},
			});
			settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});
			const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

			await session.prompt("Recover after the refusal ladder is exhausted");
			await session.waitForIdle();

			// 503 → ladder switch (delay 0), then two rung-4 refusal resends with
			// capped exponential backoff (5ms base → 5, 10) before recovery. The
			// refusal resends run past retry.maxRetries (1): the streak is bounded
			// by its wall-clock budget and abortRetry(), not the attempt budget.
			expect(requestedModels).toEqual([
				`${primaryModel.provider}/${primaryModel.id}`,
				`${firstFallback.provider}/${firstFallback.id}`,
				`${firstFallback.provider}/${firstFallback.id}`,
				`${firstFallback.provider}/${firstFallback.id}`,
			]);
			expect(retryStartEvents.map(event => event.delayMs)).toEqual([0, 5, 10]);
			expect(retryEndEvents).toEqual([{ type: "auto_retry_end", success: true, attempt: 1 }]);
			expect(getLastAssistantMessage(session).content).toEqual([{ type: "text", text: "recovered:3" }]);
		} finally {
			delete process.env.PI_REFUSAL_BACKOFF_BASE_MS;
		}
	});

	it("cancels a refusal backoff resend wait via abortRetry", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		// Large base so the test deterministically aborts mid-wait (capped at 30s).
		process.env.PI_REFUSAL_BACKOFF_BASE_MS = "30000";
		try {
			const mock = createMockModel();
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					mock.push({
						stopReason: "error",
						stopDetails: { type: "refusal", category: "bio", explanation: "Classifier declined this turn." },
						errorMessage: "Refusal (bio): Classifier declined this turn.",
					});
					return mock.stream(model, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.modelFallback": false,
			});
			settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});
			const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
			const retryStarted = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_retry_start") {
					retryStarted.resolve();
				}
			});

			const promptPromise = session.prompt("Refusal backoff should be cancellable");
			await retryStarted.promise;
			// The abort can race the wait installing its controller; retry until
			// the cancel lands (equivalent of the user pressing Esc).
			while (retryEndEvents.length === 0) {
				session.abortRetry();
				await scheduler.wait(5);
			}
			await promptPromise;
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(1);
			expect(retryStartEvents.map(event => event.delayMs)).toEqual([30_000]);
			expect(retryEndEvents).toEqual([
				{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
			]);
		} finally {
			delete process.env.PI_REFUSAL_BACKOFF_BASE_MS;
		}
	});

	it("uses Google retry hints in quota errors before quota backoff", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const errorMessage =
			"Google API error (429): Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000. Please retry in 0.05s.";
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ throw: errorMessage }, { content: ["Recovered after Google quota retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Google token quota");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 50,
			errorMessage,
		});
		expect(waitSpy).toHaveBeenCalledWith(50, { signal: expect.any(AbortSignal) });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Google quota retry" });
	});

	it("keeps retry on the primary model when retry model fallback is disabled", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		const mock = createMockModel({
			responses: [{ throw: "rate limit exceeded retry-after-ms=200" }, { content: ["Recovered on primary retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
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
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Retry rate limit without switching models");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 200,
			errorMessage: "rate limit exceeded retry-after-ms=200",
		});
		expect(waitSpy).toHaveBeenCalledWith(200, { signal: expect.any(AbortSignal) });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(fallbackSucceededEvents).toHaveLength(0);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered on primary retry" });
	});

	it("auto-retries preserved OpenAI first-event timeout errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const timeoutMessage = "OpenAI responses stream timed out while waiting for the first event";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: timeoutMessage }, { content: ["Recovered after OpenAI timeout"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry preserved OpenAI timeout");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: timeoutMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after OpenAI timeout" });
	});

	it("auto-retries stream stall errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const stallMessage = "Provider stream stalled while waiting for the next event";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: stallMessage }, { content: ["Recovered after stream stall"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry stream stall");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: stallMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after stream stall" });
	});

	it("auto-retries OpenAI processing-request transient errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const processingError =
			"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 4a4c6b73-a07c-4de0-aaaf-82560f9f626a in your message.";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: processingError }, { content: ["Recovered after OpenAI processing error"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry OpenAI processing-request error");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: processingError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "Recovered after OpenAI processing error",
		});
	});

	it("restarts Responses provider state before retrying stale item-id replay errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const staleReplayError = "Item with id 'rs_stale' not found.";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const mock = createMockModel({
			responses: [{ throw: staleReplayError }, { content: ["Recovered after Responses state reset"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});
		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", {
			close: closeSpy,
		} satisfies ProviderSessionState);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry stale OpenAI replay");
		await session.waitForIdle();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("openai-responses:openai")).toBe(false);
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			delayMs: 0,
			errorMessage: staleReplayError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "Recovered after Responses state reset",
		});
	});

	it("restarts Responses provider state before retrying Zero Data Retention errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		// Mirrors the live wire error from OpenAI ZDR orgs after the in-provider
		// retry has already exhausted itself; the higher-level retry must still
		// classify the failure as a stale-replay event so the session reset and
		// zero-delay backoff fire instead of a model fallback.
		const zdrReplayError = "400 Previous response cannot be used for this organization due to Zero Data Retention.";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const mock = createMockModel({
			responses: [{ throw: zdrReplayError }, { content: ["Recovered after ZDR reset"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});
		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", {
			close: closeSpy,
		} satisfies ProviderSessionState);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry ZDR replay");
		await session.waitForIdle();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("openai-responses:openai")).toBe(false);
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			delayMs: 0,
			errorMessage: zdrReplayError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after ZDR reset" });
	});

	it("auto-retries Anthropic stream-envelope failures before message_start", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const envelopeError = "Anthropic stream envelope error: received content_block_start before message_start";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: envelopeError }, { content: ["Recovered after Anthropic envelope retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Anthropic envelope failure before message_start");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: envelopeError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Anthropic envelope retry" });
	});

	it("consults the fallback chain on a non-retryable hard error instead of failing the turn", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider) {
					// Classifies as neither transient, usage-limit, nor auth:
					// the generic retry classifier rejects it outright.
					mock.push({ throw: "unrecoverable model quirk" });
				} else {
					mock.push({ content: ["Recovered on fallback"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
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

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Survive a hard error");
		await session.waitForIdle();

		// Exactly one attempt on the failing model: a hard error switches models
		// immediately, it never backoff-retries the same model.
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});

	it("surfaces a non-retryable error without same-model retries when no fallback candidate has a credential", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation((model, sessionId) =>
			model.provider === fallbackModel.provider ? Promise.resolve(undefined) : originalGetApiKey(model, sessionId),
		);

		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				mock.push({ throw: "unrecoverable model quirk" });
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
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

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Fail hard with no fallback credential");
		await session.waitForIdle();

		// The switch could not happen and the error is non-retryable: surface it
		// after a single attempt instead of backoff-retrying the failing model.
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(getLastAssistantMessage(session).stopReason).toBe("error");
	});

	it("falls back on mid-stream Anthropic envelope failures without same-model retries", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		// Mid-stream envelope corruption is not auto-retried on the same model
		// (partial content may have been delivered), but a configured fallback
		// chain is still consulted: a different model is a fresh chance.

		const envelopeError = "Anthropic stream envelope error: received content_block_delta before terminal stop signal";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];

		const mock = createMockModel({ handler: () => ({ throw: envelopeError }) });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
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
		const { retryStartEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Do not retry Anthropic envelope failure before terminal stop signal");
		await session.waitForIdle();

		// One attempt per model: chain advances, never a same-model backoff retry.
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
		// The fallback fails with the same hard error and the chain is exhausted:
		// the failure surfaces instead of looping.
		expect(fallbackSucceededEvents).toHaveLength(0);
		expect(retryStartEvents).toHaveLength(1);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("error");
		expect(lastAssistant.errorMessage).toBe(envelopeError);
	});

	it("does not auto-retry generic Request was aborted. errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel({ handler: () => ({ throw: "Request was aborted." }) });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Do not retry generic abort text");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(0);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("error");
		expect(lastAssistant.errorMessage).toBe("Request was aborted.");
	});

	it("matches plain fallback roles for compat-routed primary models", async () => {
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		const routedPrimary = buildModel({
			id: "z-ai/glm-4.7",
			name: "GLM 4.7",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
			compat: { openRouterRouting: { only: ["cerebras"] } },
		});

		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: routedPrimary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				const route =
					requestedModel.provider === "openrouter" &&
					requestedModel.compat &&
					"openRouterRouting" in requestedModel.compat
						? requestedModel.compat.openRouterRouting?.only?.[0]
						: undefined;
				const requested = `${requestedModel.provider}/${requestedModel.id}${route ? `@${route}` : ""}`;
				requestedModels.push(requested);
				if (requestedModel.provider === "openrouter" && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else {
					mock.push({ content: [`ok:${requested}`] });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", "openrouter/z-ai/glm-4.7");

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Compat-routed primary should still match plain role");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			"openrouter/z-ai/glm-4.7@cerebras",
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
	});

	it("keeps exact @-suffixed model IDs in fallback selectors", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o-mini");
		const fallbackModel = getBundledModel("google-vertex", "claude-opus-4-8@default");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled OpenAI and Vertex Anthropic test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				if (requestedModel.provider === primaryModel.provider && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else {
					mock.push({ content: [`ok:${requestedModel.provider}/${requestedModel.id}`] });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
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

		await session.prompt("Fallback should keep exact @ model id");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
	});
	it("suppresses cooled selectors and lazily reverts to the role primary after cooldown expiry", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("First prompt triggers fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		await session.prompt("Immediate second prompt should stay on fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		now += 240;
		await session.prompt("Third prompt should lazily revert to primary");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
	});

	it("restores routed fallback primaries after cooldown expiry", async () => {
		const openRouterModel = getBundledModel("openrouter", "z-ai/glm-4.7");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!openRouterModel || !fallbackModel) {
			throw new Error("Expected bundled OpenRouter and OpenAI test models to exist");
		}
		const routedPrimary = parseModelPattern("openrouter/z-ai/glm-4.7@cerebras", [openRouterModel]).model;
		if (!routedPrimary) {
			throw new Error("Expected routed OpenRouter primary to resolve");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: routedPrimary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				const route =
					requestedModel.provider === "openrouter"
						? (
								requestedModel.compat as {
									openRouterRouting?: { only?: string[] };
								}
							).openRouterRouting?.only?.[0]
						: undefined;
				const requested = `${requestedModel.provider}/${requestedModel.id}${route ? `@${route}` : ""}`;
				requestedModels.push(requested);
				if (requested === "openrouter/z-ai/glm-4.7@cerebras" && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else {
					mock.push({ content: [`ok:${requested}`] });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", "openrouter/z-ai/glm-4.7@cerebras");

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("First prompt triggers routed primary fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			"openrouter/z-ai/glm-4.7@cerebras",
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);

		now += 240;
		await session.prompt("Second prompt should restore routed primary");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			"openrouter/z-ai/glm-4.7@cerebras",
			`${fallbackModel.provider}/${fallbackModel.id}`,
			"openrouter/z-ai/glm-4.7@cerebras",
		]);
		expect(session.model?.provider).toBe("openrouter");
		expect(session.model?.id).toBe("z-ai/glm-4.7");
		expect(
			(session.model?.compat as { openRouterRouting?: { only?: string[] } } | undefined)?.openRouterRouting?.only,
		).toEqual(["cerebras"]);
	});
	it("preserves thinking on bare fallback selectors and does not overwrite user thinking on restore", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}:high`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.High,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("First prompt triggers bare-selector fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(session.thinkingLevel).toBeUndefined();

		session.setThinkingLevel(Effort.Low);
		now += 240;
		await session.prompt("Second prompt should restore model but preserve user thinking change");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(session.thinkingLevel).toBeUndefined();
	});

	it("accepts cached Ollama Cloud fallback selectors during startup validation", () => {
		const primaryModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		const cachedModel: Model<"ollama-chat"> = buildModel({
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		});
		writeModelCache("ollama-cloud", Date.now(), [cachedModel], true, "", path.join(tempDir.path(), "models.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.json"));

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": { default: ["ollama-cloud/deepseek-v4-pro"] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Not exercised");
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		expect(session.configWarnings).not.toContain(
			"Fallback chain for role 'default' references unknown model: ollama-cloud/deepseek-v4-pro",
		);
	});

	it("normalizes suppression by base selector and clears it on model refresh", async () => {
		const future = Date.now() + 60_000;
		modelRegistry.suppressSelector("openai/gpt-4o:high", future);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o")).toBe(true);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o:low")).toBe(true);

		modelRegistry.suppressSelector("openai/gpt-4o:max", future);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o:xhigh")).toBe(true);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o:max")).toBe(true);

		await modelRegistry.refresh("offline");
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o")).toBe(false);
	});

	it("auto-retries Gemini MALFORMED_FUNCTION_CALL transient errors", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const malformedError = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "thinking", thinking: "Thinking before malformed function call..." },
						{ type: "text", text: "Text before malformed function call..." },
					],
					stopReason: "error",
					errorMessage: malformedError,
				},
				{ content: ["Recovered after Gemini malformed function call"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("recover from Gemini malformed error");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(session.agent.state.messages).toHaveLength(2);
		const assistantMsg = session.agent.state.messages[1];
		if (assistantMsg.role !== "assistant") {
			throw new Error(`Expected assistant message, got ${assistantMsg.role}`);
		}
		const contentBlock = assistantMsg.content[0];
		if (contentBlock.type !== "text") {
			throw new Error(`Expected text content block, got ${contentBlock.type}`);
		}
		expect(contentBlock.text).toBe("Recovered after Gemini malformed function call");
	});

	it("auto-retries provider finish_reason errors after partial text", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const errorMessage = "Provider returned error finish_reason";
		const mock = createMockModel({
			responses: [
				{ content: ["partial output before gateway error"], stopReason: "error", errorMessage },
				{ content: ["Recovered after provider finish_reason error"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("recover from provider finish_reason error");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].errorMessage).toBe(errorMessage);
		expect(retryEndEvents).toHaveLength(1);
		expect(session.agent.state.messages).toHaveLength(2);
		const assistantMsg = session.agent.state.messages[1];
		if (assistantMsg.role !== "assistant") {
			throw new Error(`Expected assistant message, got ${assistantMsg.role}`);
		}
		const contentBlock = assistantMsg.content[0];
		if (contentBlock.type !== "text") {
			throw new Error(`Expected text content block, got ${contentBlock.type}`);
		}
		expect(contentBlock.text).toBe("Recovered after provider finish_reason error");
	});
});
