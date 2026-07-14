import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "jeopi-agent-core";
import type { AssistantMessage, Message, Model } from "jeopi-ai";
import { renderDemotedThinking } from "jeopi-ai/dialect";
import { createMockModel } from "jeopi-ai/providers/mock";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { AgentSession } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { type CustomMessage, type InterruptedThinkingDetails, USER_INTERRUPT_LABEL } from "jeopi-cli/session/messages";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { prompt, TempDir } from "jeopi-utils";
import interruptedThinkingTemplate from "../src/prompts/system/interrupted-thinking.md" with { type: "text" };

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

	/**
	 * Regression for the one-shot-latch bug: the OLD code set
	 * `#reasoningExtractionDegraded = true` permanently on the first
	 * `reasoning_extraction` refusal and never reset it, so every subsequent
	 * refusal in the same session — even one from a wholly independent LATER
	 * turn, with its own fresh unsigned thinking — fell through to the
	 * generic Rung-4 backoff ladder unstripped. That ladder only removes the
	 * failing tail message; it does NOT re-run the history-wide unsigned-
	 * thinking strip, so any OLDER unsigned thinking still sitting in active
	 * context (e.g. a still-unsigned turn that completed successfully after
	 * its own earlier degrade) rides along on the resend and can re-trigger
	 * the classifier indefinitely. The fix replaces the boolean with a
	 * bounded streak gated on `#stripUnsignedThinkingForRefusalDegrade`
	 * actually finding something to remove, and resets the streak to 0 on
	 * any turn that succeeds — so a second, independent refusal gets its own
	 * full history-wide strip, not just a tail-drop.
	 */
	it("strips unsigned thinking on a second, independent reasoning_extraction refusal from a later turn", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled test model to exist");

		const requestedModels: string[] = [];
		const contextSnapshots: Message[][] = [];
		const mock = createMockModel();
		let callIndex = 0;
		const reasoningExtractionDetails = {
			type: "refusal",
			category: "reasoning_extraction",
			explanation: "This request was blocked as it seems to violate Anthropic's Terms of Service.",
		};

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider !== primaryModel.provider || model.id !== primaryModel.id) {
					throw new Error(
						`reasoning_extraction degrade should retry the same model, not fall back to ${model.provider}/${model.id}`,
					);
				}
				// Snapshot defensively: `context` is rebuilt fresh per call from
				// `agent.state.messages`, but later retry handling calls
				// `agent.replaceMessages()`, which creates NEW message objects for
				// anything it strips — never mutates in place. A structuredClone
				// here removes any doubt that a later call's replaceMessages could
				// retroactively change what an earlier call's snapshot shows.
				contextSnapshots.push(structuredClone(context.messages));
				callIndex += 1;
				if (callIndex === 1) {
					// Turn 1's own refusal: carries its own fresh unsigned thinking.
					mock.push({
						content: [{ type: "thinking", thinking: "Turn 1 pre-refusal reasoning." }, "Blocked."],
						stopReason: "error",
						stopDetails: reasoningExtractionDetails,
						errorMessage: `Refusal (reasoning_extraction): ${reasoningExtractionDetails.explanation}`,
					});
				} else if (callIndex === 2) {
					// Turn 1's resend succeeds, but the answer itself carries fresh
					// unsigned thinking that survives in active context (a
					// point-in-time strip does not prevent NEW unsigned thinking from
					// accumulating) — this is the residual that turn 2's own refusal
					// will replay, the realistic multi-turn trigger the bug describes.
					mock.push({
						content: [{ type: "thinking", thinking: "Turn 1 own reasoning, now completed." }, "Turn 1 answer."],
					});
				} else if (callIndex === 3) {
					// Turn 2's own refusal: independent fresh unsigned thinking, on
					// top of turn 1's still-unstripped residual already in context.
					mock.push({
						content: [{ type: "thinking", thinking: "Turn 2 pre-refusal reasoning." }, "Blocked again."],
						stopReason: "error",
						stopDetails: reasoningExtractionDetails,
						errorMessage: `Refusal (reasoning_extraction): ${reasoningExtractionDetails.explanation}`,
					});
				} else {
					mock.push({ content: ["Turn 2 answer."] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Trigger the first reasoning_extraction refusal");
		await session.waitForIdle();

		const turn1Final = session.messages.at(-1);
		if (turn1Final?.role !== "assistant") throw new Error("Expected turn 1 to end on an assistant message");
		expect(turn1Final.stopReason).toBe("stop");

		await session.prompt("Trigger a second, independent reasoning_extraction refusal");
		await session.waitForIdle();

		const turn2Final = session.messages.at(-1);
		if (turn2Final?.role !== "assistant") throw new Error("Expected turn 2 to end on an assistant message");
		expect(turn2Final.stopReason).toBe("stop");

		// Exactly 4 calls: turn 1 = [refuse, succeed], turn 2 = [refuse, succeed].
		expect(callIndex).toBe(4);
		expect(contextSnapshots).toHaveLength(4);

		const hasUnsignedThinking = (messages: Message[]): boolean =>
			messages.some(
				m =>
					m.role === "assistant" &&
					m.content.some(b => b.type === "redactedThinking" || (b.type === "thinking" && !b.thinkingSignature)),
			);

		// Sanity check on the trigger itself: turn 2's initial call (call 3) DOES
		// see turn 1's still-unstripped residual unsigned thinking in context —
		// proving this is a realistic replay-triggered refusal, not a contrived one.
		expect(hasUnsignedThinking(contextSnapshots[2]!)).toBe(true);

		// Turn 1's resend (call 2): call 1's own fresh unsigned thinking was
		// stripped before resend.
		expect(hasUnsignedThinking(contextSnapshots[1]!)).toBe(false);

		// THE REGRESSION ASSERTION: turn 2's resend (call 4) must ALSO have no
		// unsigned thinking anywhere — neither turn 1's residual nor turn 2's own
		// call-3 refusal content. Under the old one-shot latch, `#reasoningExtractionDegraded`
		// was already true from turn 1, so turn 2's refusal skipped the fast
		// strip-and-resend path entirely and fell through to the generic Rung-4
		// ladder, which only drops the failing tail message — turn 1's residual
		// unsigned thinking (from call 2's answer) would still be present here.
		expect(hasUnsignedThinking(contextSnapshots[3]!)).toBe(false);

		// Resent on the same model throughout; the reasoning_extraction degrade
		// never falls back to a different model.
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
	});

	/**
	 * Regression for the streak cap: `REASONING_EXTRACTION_DEGRADE_STREAK_CAP`
	 * (3) bounds how many CONSECUTIVE fast-degrades can happen with no
	 * intervening success, so a pathological classifier state that refuses
	 * every turn's fresh thinking in a row still reaches the wall-clock-bounded
	 * Rung-4 ladder instead of resending at zero delay indefinitely. Proven via
	 * the `auto_retry_start` event's `delayMs`, which the fast path always
	 * emits as exactly `0` and the generic ladder always emits as `> 0` — a
	 * first-class, already-emitted observable, not internal state.
	 *
	 * One real (but minimized) timer wait is unavoidable here: once the cap is
	 * hit, `#handleRetryableError` calls a real `scheduler.wait(delayMs, …)`
	 * before the 5th call fires, and `session.waitForIdle()` must observe that
	 * 5th call for the turn to settle. `PI_REFUSAL_BACKOFF_BASE_MS=5` shrinks
	 * that otherwise-2000ms wait to ~5ms so the real-timer surface is
	 * negligible; a hard `timeout` bounds the test so a regression here fails
	 * fast instead of hanging CI.
	 */
	it(
		"bounds the fast-degrade path to REASONING_EXTRACTION_DEGRADE_STREAK_CAP consecutive uses, then falls through to the backoff ladder",
		async () => {
			const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!primaryModel) throw new Error("Expected bundled test model to exist");

			const requestedModels: string[] = [];
			const contextSnapshots: Message[][] = [];
			const retryDelays: number[] = [];
			const mock = createMockModel();
			let callIndex = 0;
			const reasoningExtractionDetails = {
				type: "refusal",
				category: "reasoning_extraction",
				explanation: "This request was blocked as it seems to violate Anthropic's Terms of Service.",
			};

			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					if (model.provider !== primaryModel.provider || model.id !== primaryModel.id) {
						throw new Error(
							`reasoning_extraction degrade should retry the same model, not fall back to ${model.provider}/${model.id}`,
						);
					}
					contextSnapshots.push(structuredClone(context.messages));
					callIndex += 1;
					if (callIndex <= 4) {
						// Every call through the 4th independently refuses with its OWN
						// fresh unsigned thinking, so `#stripUnsignedThinkingForRefusalDegrade`
						// would find something to strip on every single occurrence if the
						// streak cap did not intervene.
						mock.push({
							content: [{ type: "thinking", thinking: `Fresh reasoning for call ${callIndex}.` }, "Blocked."],
							stopReason: "error",
							stopDetails: reasoningExtractionDetails,
							errorMessage: `Refusal (reasoning_extraction): ${reasoningExtractionDetails.explanation}`,
						});
					} else {
						mock.push({ content: ["Recovered."] });
					}
					return mock.stream(model, context, options);
				},
			});

			// No fallback chain configured: once the streak cap forces a fall-through,
			// there is nothing to switch to, so the generic path must take the
			// real Rung-4 refusal-backoff branch (not a zero-delay model switch),
			// which is the branch under test.
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.maxRetries": 1,
			});
			settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});
			const unsubscribe = session.subscribe(event => {
				if (event.type === "auto_retry_start") retryDelays.push(event.delayMs);
			});

			const originalBackoffBaseMs = process.env.PI_REFUSAL_BACKOFF_BASE_MS;
			process.env.PI_REFUSAL_BACKOFF_BASE_MS = "5";
			try {
				await session.prompt("Trigger a run of consecutive reasoning_extraction refusals");
				await session.waitForIdle();
			} finally {
				if (originalBackoffBaseMs === undefined) delete process.env.PI_REFUSAL_BACKOFF_BASE_MS;
				else process.env.PI_REFUSAL_BACKOFF_BASE_MS = originalBackoffBaseMs;
				unsubscribe();
			}

			const finalMessage = session.messages.at(-1);
			if (finalMessage?.role !== "assistant") throw new Error("Expected the turn to end on an assistant message");
			expect(finalMessage.stopReason).toBe("stop");

			// 4 refusals + 1 recovery.
			expect(callIndex).toBe(5);
			expect(contextSnapshots).toHaveLength(5);

			// THE CAP ASSERTION: exactly 3 fast-degrades (delayMs === 0), then the
			// 4th `auto_retry_start` (for the resend that becomes call 5) carries a
			// real positive delay — proving the code fell through to the generic
			// Rung-4 ladder instead of fast-degrading a 4th consecutive time.
			expect(retryDelays).toHaveLength(4);
			expect(retryDelays.slice(0, 3)).toEqual([0, 0, 0]);
			expect(retryDelays[3]).toBeGreaterThan(0);

			const hasUnsignedThinking = (messages: Message[]): boolean =>
				messages.some(
					m =>
						m.role === "assistant" &&
						m.content.some(b => b.type === "redactedThinking" || (b.type === "thinking" && !b.thinkingSignature)),
				);

			// Calls 2, 3, 4 (the resends for refusals 1, 2, 3) were all stripped —
			// the fast path ran for exactly `REASONING_EXTRACTION_DEGRADE_STREAK_CAP`
			// consecutive occurrences.
			expect(hasUnsignedThinking(contextSnapshots[1]!)).toBe(false);
			expect(hasUnsignedThinking(contextSnapshots[2]!)).toBe(false);
			expect(hasUnsignedThinking(contextSnapshots[3]!)).toBe(false);

			// Never fell back to a different model.
			expect(requestedModels.every(m => m === `${primaryModel.provider}/${primaryModel.id}`)).toBe(true);
			expect(requestedModels).toHaveLength(5);
		},
		{ timeout: 5000 },
	);
});

/**
 * On a user-interrupted (Esc) abort mid-thinking-stream, `AgentSession` copies
 * the trailing unsigned thinking run into a hidden `interrupted-thinking`
 * continuity message for the next turn. That message used to ship the raw
 * reasoning text verbatim inside a "use it silently to resume" wrapper —
 * exactly the shape Anthropic's `reasoning_extraction` classifier flags. Every
 * other thinking-replay site in this codebase disguises reasoning through
 * `renderDemotedThinking` before it reaches a model; `#demoteInterruptedThinkingOnUserInterrupt`
 * was the one remaining unguarded site. These tests defend the fix: the
 * continuity message must carry `renderDemotedThinking`'s dialect-appropriate
 * disguise, never the raw reasoning strung directly into the template.
 */
describe("AgentSession interrupted-thinking disguise on user interrupt", () => {
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
		// The mock's `stream()` method resolves the AssistantMessage's `model`/
		// `provider` fields from the MockModel instance itself (it ignores the
		// model argument `Agent` passes through the streamFn), so the mock must
		// be constructed with the target model's real id/provider for
		// `renderDemotedThinking(message.model, ...)` to resolve the correct dialect.
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

	it("disguises trailing unsigned thinking as markdown-italic prose for a Fable/Mythos target model", async () => {
		const model = getBundledModel("anthropic", "claude-fable-5");
		if (!model) throw new Error("Expected bundled claude-fable-5 to exist");

		const continuity = await runInterruptedThinkingTurn(model);
		expect(typeof continuity.content).toBe("string");
		const content = continuity.content as string;

		// Fable/Mythos disguise format: `_Hmm. <text>_` markdown-italic prose,
		// never a `<thinking>`-tagged or otherwise labeled raw replay.
		expect(content).toContain(`_Hmm. ${RAW_REASONING}_`);
		expect(content.toLowerCase()).not.toContain("thinking:");

		// Byte-exact: the wrapper the source code actually builds around the
		// disguised reasoning must be present verbatim (proves the fix wires
		// `renderDemotedThinking` into the same `{{reasoning}}` template slot,
		// not just that *a* disguise-shaped string appears somewhere).
		const expectedDisguised = renderDemotedThinking(model.id, RAW_REASONING).trimEnd();
		const expectedContent = prompt.render(interruptedThinkingTemplate, { reasoning: expectedDisguised });
		expect(content).toBe(expectedContent);
	});

	it("disguises trailing unsigned thinking through the dialect-appropriate fallback for a non-Fable/Mythos Anthropic model", async () => {
		const model = getBundledModel("anthropic", "claude-opus-4-5");
		if (!model) throw new Error("Expected bundled claude-opus-4-5 to exist");

		const continuity = await runInterruptedThinkingTurn(model);
		expect(typeof continuity.content).toBe("string");
		const content = continuity.content as string;

		// claude-opus-4-5 is Anthropic-family but not Fable/Mythos, so
		// `renderDemotedThinking` falls through to the anthropic dialect's own
		// `renderThinking`, which wraps in plain `<thinking>...</thinking>` —
		// not the Fable `_Hmm._` prose, and not a `thinking:`-labeled raw dump.
		expect(content).toContain(`<thinking>\n${RAW_REASONING}\n</thinking>`);
		expect(content).not.toContain("_Hmm.");
		expect(content.toLowerCase()).not.toContain("thinking:");

		// Byte-exact against the production composition, same as the Fable case.
		const expectedDisguised = renderDemotedThinking(model.id, RAW_REASONING).trimEnd();
		const expectedContent = prompt.render(interruptedThinkingTemplate, { reasoning: expectedDisguised });
		expect(content).toBe(expectedContent);
	});

	it("never ships the raw reasoning as an unwrapped replay — it is only ever present inside renderDemotedThinking's disguise markers", async () => {
		// `renderDemotedThinking` disguises via wrap-only markers (`_Hmm. ..._` for
		// Fable/Mythos, `<thinking>...</thinking>` for anthropic's own dialect,
		// `<think>...</think>` for harmony/gemma, or another dialect's own inline
		// thinking fence) — it does not rewrite/paraphrase/encode the reasoning
		// text itself. So the raw reasoning IS still present as a substring of
		// the constructed message for every dialect; the load-bearing property
		// is that it is *never* present un-wrapped. The old bug shipped
		// `demoted.reasoning` directly into `{{reasoning}}` with no wrapper at
		// all, which is exactly what "unwrapped" would look like here.
		for (const model of [
			getBundledModel("anthropic", "claude-fable-5"),
			getBundledModel("anthropic", "claude-opus-4-5"),
		]) {
			if (!model) throw new Error("Expected bundled test models to exist");
			const continuity = await runInterruptedThinkingTurn(model);
			const content = continuity.content as string;

			// The exact old-bug shape (raw reasoning with no disguise wrapper at
			// all around it) must be absent.
			const rawUnwrapped = prompt.render(interruptedThinkingTemplate, { reasoning: RAW_REASONING });
			expect(content).not.toBe(rawUnwrapped);

			// Every occurrence of the raw reasoning in the constructed message is
			// immediately preceded and followed by this model's disguise markers —
			// i.e. it always appears as part of `renderDemotedThinking`'s output,
			// never bare.
			const disguised = renderDemotedThinking(model.id, RAW_REASONING).trimEnd();
			expect(disguised).not.toBe(RAW_REASONING);
			expect(content.split(RAW_REASONING).length - 1).toBe(1);
			expect(content).toContain(disguised);

			await session?.dispose();
			session = undefined;
		}
	});
});
