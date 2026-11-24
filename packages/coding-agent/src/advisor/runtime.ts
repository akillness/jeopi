import type { AgentMessage } from "jeopi-agent-core";
import { estimateTokens } from "jeopi-agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent } from "jeopi-ai";
import { logger } from "jeopi-utils";
import { obfuscateToolArguments, type SecretObfuscator } from "../secrets/obfuscator";
import { formatSessionHistoryMarkdown, PRIMARY_CONTEXT_CUSTOM_TYPES } from "../session/session-history-format";

/**
 * Minimal slice of `Agent` the runtime drives — satisfied by pi-agent-core
 * `Agent`. `state.error` mirrors `Agent.state.error`: provider/stream failures
 * the loop catches internally never reject `prompt()`, so the runtime reads
 * this field after every prompt to detect a failed turn.
 */
export interface AdvisorAgent {
	prompt(input: string): Promise<void>;
	abort(reason?: unknown): void;
	reset(): void;
	/**
	 * Drop messages appended past `count`. Called after a failed `prompt()` so a
	 * retry doesn't replay the failed user batch + synthetic assistant-error
	 * turn `Agent.#runLoop` records on its internal state.
	 */
	rollbackTo?(count: number): void;
	readonly state: { messages: AgentMessage[]; error?: string; model?: { id: string } };
}

export interface AdvisorRuntimeHost {
	/** Live primary transcript (use `agent.state.messages`). */
	snapshotMessages(): AgentMessage[];
	/** Surface one advice note to the primary (enqueues into the session YieldQueue). */
	enqueueAdvice(note: string, severity?: "nit" | "concern" | "blocker"): void;
	/** Redact primary transcript bytes before they reach the advisor model. */
	obfuscator?: SecretObfuscator;
	/**
	 * Pre-prompt context maintenance for the advisor's own append-only context.
	 * Promotes the advisor model to a larger sibling when its context nears the
	 * window (mirroring the primary's promote-first policy) and resolves `true`
	 * when the advisor should re-prime — reset and replay the current
	 * primary-bounded transcript — because promotion did not free enough room.
	 * Optional: hosts that omit it get no maintenance (context only shrinks when
	 * the primary's next compaction triggers {@link AdvisorRuntime.reset}).
	 */
	maintainContext?(incomingTokens: number): Promise<boolean>;
	/**
	 * Called immediately before each `agent.prompt(batch)` cycle. Lets the host
	 * clear per-update advisor state — currently the one-advise-per-update gate
	 * in {@link AdvisorEmissionGuard}, which the host owns because it is the
	 * one that routes `advise()` results back to the primary.
	 */
	beginAdvisorUpdate?(): void;
	/** Called when an advisor review attempt starts (for transcript replay dedupe). */
	onTurnBegin?(): void;
	/** Called when an advisor review attempt succeeds (commits transcript replay window). */
	onTurnCommit?(): void;
	/** Called when an advisor review attempt fails or is quarantined (preserves replay window). */
	onTurnAbandon?(): void;
	/** Surface a non-recovering advisor failure to the host UI without adding model-visible context. */
	notifyFailure?(error: unknown): void;
	/** Surface a one-time notice that thinking was stripped from advisor renders after a provider refusal. */
	notifyThinkingStripped?(): void;
}

interface PendingDelta {
	text: string;
	turns: number;
}

/** Construction-time tuning for {@link AdvisorRuntime}. */
export interface AdvisorRuntimeOptions {
	/** Render the primary's thinking blocks into advisor deltas (default true). */
	includeThinking?: boolean;
}

const ADVISOR_QUARANTINE_PREFIX = "Advisor response quarantined";
const MAX_QUARANTINE_RETRIES = 2;
const MAX_DROPPED_BATCH_CYCLES = 3;

/** Signals that an advisor response was discarded before it could become model-visible context. */
export class AdvisorOutputQuarantinedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdvisorOutputQuarantinedError";
	}
}

interface AdvisorOutputHazard {
	label: string;
	pattern: RegExp;
}

const ADVISOR_OUTPUT_ONLY_HAZARDS: readonly AdvisorOutputHazard[] = [
	{ label: "account-deletion claim", pattern: /\buser\b.{0,80}\b(?:deleted|erased)\b.{0,80}\baccount\b/i },
	{
		label: "instruction override",
		pattern: /\bignore\s+(?:all\s+)?(?:prior|previous|earlier)\s+(?:user\s+)?instructions\b/i,
	},
	{
		label: "destructive shell command",
		pattern:
			/\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|(?:-[a-z]*r[a-z]*|--recursive)\s+(?:-[a-z]*f[a-z]*|--force)|(?:-[a-z]*f[a-z]*|--force)\s+(?:-[a-z]*r[a-z]*|--recursive))(?:\s|$)/i,
	},
	{ label: "denial instruction", pattern: /\bdeny\s+(?:this|it|the\s+request)\s+if\s+(?:asked|questioned)\b/i },
];

/**
 * Replaces an advisor assistant turn that requested unavailable tools or generated
 * output-only destructive directives with a sanitized error before dispatch.
 */
export function quarantineAdvisorUnsafeOutput(
	message: AssistantMessage,
	availableToolNames: ReadonlySet<string>,
	sourceText: string | (() => string) = "",
): string | undefined {
	const reasons: string[] = [];
	const unavailableToolNames = new Set<string>();
	const generatedParts: string[] = [];
	for (const block of message.content) {
		if (block.type === "toolCall" && !availableToolNames.has(block.name)) unavailableToolNames.add(block.name);
		if (block.type === "toolCall" && block.name === "advise" && typeof block.arguments.note === "string") {
			generatedParts.push(block.arguments.note);
		}
		if (block.type === "text") generatedParts.push(block.text);
	}
	if (unavailableToolNames.size > 0) {
		const names = [...unavailableToolNames].sort();
		const toolLabel = names.length === 1 ? "tool" : "tools";
		reasons.push(`requested unavailable ${toolLabel} ${names.join(", ")}`);
	}

	const generatedText = generatedParts.join("\n");
	if (generatedText) {
		let resolvedSource: string | undefined;
		const getSource = (): string => {
			if (resolvedSource === undefined) {
				resolvedSource = typeof sourceText === "function" ? sourceText() : sourceText;
			}
			return resolvedSource;
		};
		const labels: string[] = [];
		for (const hazard of ADVISOR_OUTPUT_ONLY_HAZARDS) {
			if (hazard.pattern.test(generatedText) && !hazard.pattern.test(getSource())) {
				labels.push(hazard.label);
			}
		}
		if (
			labels.includes("destructive shell command") ||
			(labels.includes("instruction override") && labels.length >= 2) ||
			labels.length >= 3
		) {
			reasons.push(`generated output-only destructive directives: ${labels.join(", ")}`);
		}
	}

	if (reasons.length === 0) return undefined;

	const messageText = `${ADVISOR_QUARANTINE_PREFIX}: ${reasons.join("; ")}`;
	message.content = [{ type: "text", text: messageText }];
	message.stopReason = "error";
	message.stopDetails = undefined;
	message.providerPayload = undefined;
	message.errorMessage = messageText;
	return messageText;
}

/**
 * Builds the provenance text used to decide whether hazardous advisor output was
 * generated by the advisor or came from model-visible primary/tool context.
 */
export function buildAdvisorQuarantineSourceText(currentInput: string, messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	if (currentInput) parts.push(currentInput);
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

const REFUSAL_MESSAGE_PREFIX = /^(?:Error:\s*)?Refusal(?:\s*\(|:|$)/;

export function isRefusalError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return REFUSAL_MESSAGE_PREFIX.test(message.trim());
}

interface CatchupWaiter {
	threshold: number;
	resolve: () => void;
	finish: () => void;
	timer?: NodeJS.Timeout;
}

export class AdvisorRuntime {
	#lastCount = 0;
	#seenContext = new Map<string, string>();
	#pending: PendingDelta[] = [];
	#busy = false;
	#backlog = 0;
	#failing = false;
	#halted = false;
	#droppedBatches = 0;
	#consecutiveFailures = 0;
	#consecutivePermanentFailures = 0;
	#consecutiveQuarantines = 0;
	#failureNotified = false;
	#permanentlyDisabled = false;
	#latestMessages?: AgentMessage[];
	#waiters: CatchupWaiter[] = [];
	#sleepAbort?: AbortController;
	#epoch = 0;
	disposed = false;
	#includeThinking: boolean;

	constructor(
		private readonly agent: AdvisorAgent,
		private readonly host: AdvisorRuntimeHost,
		private readonly retryDelayMs = 1000,
		options: AdvisorRuntimeOptions = {},
	) {
		this.#includeThinking = options.includeThinking ?? true;
	}

	get backlog(): number {
		return this.#backlog;
	}

	get isPermanentlyDisabled(): boolean {
		return this.#permanentlyDisabled;
	}

	get isHalted(): boolean {
		return this.#halted;
	}

	onTurnEnd(messages?: AgentMessage[]): void {
		if (this.disposed || this.#permanentlyDisabled || this.#halted) return;
		const all = messages ?? this.host.snapshotMessages();
		this.#latestMessages = all;
		const render = this.#renderDelta(all);
		if (render) {
			this.#pending.push({ text: render, turns: 1 });
			this.#backlog++;
			this.#notifyWaiters();
			void this.#drain();
		}
	}

	waitForCatchup(maxMs: number, threshold: number, signal?: AbortSignal): Promise<void> {
		if (
			this.disposed ||
			this.#permanentlyDisabled ||
			this.#halted ||
			this.#failing ||
			signal?.aborted ||
			!Number.isFinite(maxMs) ||
			maxMs <= 0 ||
			!Number.isFinite(threshold) ||
			threshold <= 0 ||
			this.#backlog < threshold
		) {
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		let waiter!: CatchupWaiter;
		const finish = (): void => {
			const idx = this.#waiters.indexOf(waiter);
			if (idx >= 0) this.#waiters.splice(idx, 1);
			clearTimeout(waiter.timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		waiter = { threshold, resolve, finish, timer: setTimeout(finish, maxMs) };
		this.#waiters.push(waiter);
		signal?.addEventListener("abort", finish, { once: true });
		if (signal?.aborted) {
			finish();
		}
		return promise;
	}

	dispose(): void {
		this.disposed = true;
		this.#epoch++;
		this.#pending = [];
		this.#backlog = 0;
		this.#failing = false;
		this.#consecutiveFailures = 0;
		this.#consecutiveQuarantines = 0;
		this.#failureNotified = false;
		this.#sleepAbort?.abort();
		this.#wakeAllWaiters();
		try {
			this.agent.abort("advisor disposed");
		} catch {}
	}

	#resetAdvisorContext(
		clearBacklog: boolean,
		wakeWaiters: boolean,
		options?: { rewindCursor?: boolean; resetFailureNotified?: boolean },
	): void {
		if (options?.rewindCursor !== false) {
			this.#lastCount = 0;
		}
		this.#pending = [];
		this.#failing = false;
		this.#consecutiveFailures = 0;
		if (options?.resetFailureNotified !== false) {
			this.#failureNotified = false;
		}
		this.#seenContext.clear();
		this.#sleepAbort?.abort();
		if (clearBacklog) {
			this.#backlog = 0;
		}
		if (wakeWaiters) {
			this.#wakeAllWaiters();
		}
		try {
			this.agent.reset();
		} catch {}
		try {
			this.agent.abort("advisor reset");
		} catch {}
	}

	/**
	 * Re-prime the advisor after a history rewrite (compaction, session
	 * switch/resume, branch). Clears the advisor's own (non-persisted) context
	 * and rewinds the cursor to 0 so the NEXT turn replays the full current —
	 * post-compaction — transcript, giving the advisor fresh context instead of
	 * leaving it blind to everything before the rewrite.
	 */
	reset(): void {
		this.#epoch++;
		this.#consecutivePermanentFailures = 0;
		this.#consecutiveQuarantines = 0;
		this.#droppedBatches = 0;
		this.#permanentlyDisabled = false;
		this.#halted = false;
		this.#resetAdvisorContext(true, true);
	}

	/**
	 * Seed the cursor to the current transcript length when the advisor is enabled
	 * mid-session. Prevents the next turn from replaying the entire history to the
	 * advisor (which would be expensive and likely stale).
	 */
	seedTo(count: number): void {
		this.#lastCount = count;
		this.#pending = [];
		this.#backlog = 0;
		this.#failing = false;
		this.#halted = false;
		this.#droppedBatches = 0;
		this.#consecutiveFailures = 0;
		this.#consecutivePermanentFailures = 0;
		this.#consecutiveQuarantines = 0;
		this.#failureNotified = false;
		this.#permanentlyDisabled = false;
		this.#seenContext.clear();
		this.#sleepAbort?.abort();
		this.#wakeAllWaiters();
	}

	#renderDelta(messages?: AgentMessage[]): string | null {
		const all = messages ?? this.#latestMessages ?? this.host.snapshotMessages();
		if (all.length < this.#lastCount) {
			this.#lastCount = all.length;
			this.#seenContext.clear();
			return null;
		}
		const delta = all
			.slice(this.#lastCount)
			.filter(m => !(m.role === "custom" && (m as { customType?: string }).customType === "advisor"))
			.map(m => this.#dedupContextMessage(m));
		this.#lastCount = all.length;
		if (delta.length === 0) return null;
		const obfuscator = this.host.obfuscator;
		const formattedDelta = obfuscator?.hasSecrets() ? obfuscateAdvisorDelta(obfuscator, delta) : delta;
		const md = formatSessionHistoryMarkdown(formattedDelta, {
			includeThinking: this.#includeThinking,
			demoteThinkingForModelId: this.agent.state.model?.id,
			includeToolIntent: true,
			watchedRoles: true,
			expandPrimaryContext: true,
			expandEditDiffs: true,
		});
		if (!md.trim()) return null;
		return `### Session update\n\n${md}`;
	}

	/**
	 * Collapse a re-injected primary-context prompt (plan/goal mode rules, the
	 * approved plan) to a short marker when its body is byte-identical to the
	 * copy already shown to the advisor since the last re-prime. The primary
	 * re-injects these verbatim every turn; without this the advisor re-reads the
	 * full rules (~1k tokens) each turn. Returns a CLONE when collapsing — the
	 * input shares the live primary transcript and must never be mutated.
	 */
	#dedupContextMessage(msg: AgentMessage): AgentMessage {
		if (msg.role !== "custom") return msg;
		const type = (msg as { customType?: string }).customType;
		if (!type || !PRIMARY_CONTEXT_CUSTOM_TYPES.has(type)) return msg;
		const content = (msg as { content?: unknown }).content;
		if (typeof content !== "string") return msg;
		if (this.#seenContext.get(type) === content) {
			return { ...(msg as object), content: "(unchanged — still in effect)" } as AgentMessage;
		}
		this.#seenContext.set(type, content);
		return msg;
	}

	#notifyWaiters(): void {
		for (let i = this.#waiters.length - 1; i >= 0; i--) {
			const w = this.#waiters[i];
			if (this.#backlog < w.threshold) {
				w.finish();
			}
		}
	}

	#wakeAllWaiters(): void {
		for (const w of [...this.#waiters]) {
			w.finish();
		}
	}

	/**
	 * Drop the user batch + synthetic assistant-error turn `Agent.#runLoop`
	 * appended for a failed prompt so a retry replays a clean baseline and the
	 * dropped-after-3 path never leaks orphan failures into the next successful
	 * run. Prefers the agent's own `rollbackTo` (which also re-syncs its
	 * append-only context); falls back to truncating `state.messages` for tests
	 * that hand-roll a minimal facade.
	 */
	#rollbackFailedTurn(snapshot: number): void {
		const messages = this.agent.state.messages;
		if (messages.length <= snapshot) return;
		try {
			if (this.agent.rollbackTo) {
				this.agent.rollbackTo(snapshot);
				return;
			}
			messages.length = snapshot;
		} catch (err) {
			logger.debug("advisor rollback failed", { err: String(err) });
		}
	}

	async #drain(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			while (!this.disposed && this.#pending.length) {
				const popped = this.#pending.splice(0);
				const epoch = this.#epoch;
				// Each delta already opens with a `### Session update` heading, so
				// join with a blank line rather than a `---` rule.
				const candidateBatch = popped.map(b => b.text).join("\n\n");
				const turnsCovered = popped.reduce((sum, b) => sum + b.turns, 0);
				const incomingTokens = estimateTokens({
					role: "user",
					content: candidateBatch,
					timestamp: Date.now(),
				});

				let shouldReprime = false;
				if (this.host.maintainContext) {
					try {
						shouldReprime = await this.host.maintainContext(incomingTokens);
					} catch (err) {
						logger.debug("advisor context maintenance failed", { err: String(err) });
					}
				}
				// A reset/dispose during context maintenance invalidates this batch.
				if (this.#epoch !== epoch) continue;

				let batch: string | null;
				let finalTurns: number;
				if (shouldReprime) {
					// Promotion could not fit the advisor's context — re-prime.
					const newTurns = this.#pending.reduce((sum, b) => sum + b.turns, 0);
					this.#resetAdvisorContext(false, false);
					batch = this.#renderDelta(this.#latestMessages);
					finalTurns = turnsCovered + newTurns;
				} else {
					batch = candidateBatch;
					finalTurns = turnsCovered;
				}

				if (this.disposed || batch === null) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
					continue;
				}

				let success = false;
				// Capture the advisor's message count BEFORE the prompt so a failure can
				// roll back the user batch + synthetic assistant-error turn `Agent.#runLoop`
				// appends to internal state. Without this, a retry would replay the
				// failed batch on top of the stale turns and the dropped-after-3 path
				// would leak orphan failures into the next successful run's context.
				const messageSnapshot = this.agent.state.messages.length;
				const seenSnapshot = new Map(this.#seenContext);
				try {
					// Reset the host's per-update advisor state (emission guard) before
					// each model cycle so the new batch starts with a fresh budget.
					this.host.beginAdvisorUpdate?.();
					this.host.onTurnBegin?.();
					await this.agent.prompt(batch);
					// `Agent.#runLoop` catches provider/stream failures internally and
					// resolves `prompt()` cleanly with the assistant turn ending in
					// `stopReason: "error"` and the message recorded on `state.error`.
					const promptError = this.agent.state.error;
					if (promptError) throw new Error(promptError);
					const emptyResponseError = getAdvisorEmptyResponseError(
						this.agent.state.messages.slice(messageSnapshot),
					);
					if (emptyResponseError) throw emptyResponseError;
					success = true;
					this.host.onTurnCommit?.();
					this.#failing = false;
					this.#consecutiveFailures = 0;
					this.#consecutivePermanentFailures = 0;
					this.#consecutiveQuarantines = 0;
					this.#droppedBatches = 0;
					this.#failureNotified = false;
				} catch (err) {
					this.host.onTurnAbandon?.();
					// reset()/dispose() aborts the in-flight prompt; the rejection is the
					// reset itself, not a transient advisor failure. Drop the stale batch
					// instead of mutating post-reset state or requeuing into the new epoch.
					if (this.#epoch !== epoch) continue;
					if (err instanceof AdvisorOutputQuarantinedError) {
						this.#consecutiveQuarantines++;
						if (this.#consecutiveQuarantines > MAX_QUARANTINE_RETRIES) {
							logger.warn("advisor response repeatedly quarantined; dropping batch", { err: String(err) });
							this.#consecutiveQuarantines = 0;
							this.#droppedBatches++;
							this.#resetAdvisorContext(true, true, { rewindCursor: false, resetFailureNotified: false });
							this.#notifyFailureOnce(err);
							if (this.#droppedBatches >= MAX_DROPPED_BATCH_CYCLES) {
								this.#halted = true;
								logger.warn("advisor halted for session after repeated quarantined batches", {
									droppedBatches: this.#droppedBatches,
								});
								break;
							}
							continue;
						}
						this.#resetAdvisorContext(true, true, { resetFailureNotified: false });
						continue;
					}
					this.#rollbackFailedTurn(messageSnapshot);
					logger.debug("advisor turn failed", { err: String(err) });
					// Classifier refusals are payload-shape-bound: degrade once by
					// stripping thinking blocks and re-priming.
					if (this.#includeThinking && isRefusalError(err)) {
						this.#includeThinking = false;
						const queuedTurns = this.#pending.reduce((sum, b) => sum + b.turns, 0);
						this.#resetAdvisorContext(false, false);
						const stripped = this.#renderDelta(this.#latestMessages);
						try {
							this.host.notifyThinkingStripped?.();
						} catch (notifyErr) {
							logger.warn("advisor thinking-strip notification failed", { err: String(notifyErr) });
						}
						if (stripped !== null) {
							this.#pending.unshift({ text: stripped, turns: finalTurns + queuedTurns });
						} else {
							this.#backlog = Math.max(0, this.#backlog - (finalTurns + queuedTurns));
							this.#notifyWaiters();
						}
						continue;
					}
					this.#consecutiveFailures++;
					this.#failing = true;
					this.#wakeAllWaiters();
					if (isPermanentAdvisorError(err)) {
						this.#consecutivePermanentFailures++;
						this.#consecutiveFailures = 0;
						this.#seenContext.clear();
						this.#notifyFailureOnce(err);
						if (this.#consecutivePermanentFailures >= 2) {
							this.#permanentlyDisabled = true;
							this.#pending = [];
							this.#backlog = 0;
							this.#wakeAllWaiters();
							logger.warn("advisor disabled for session after repeated permanent error", { err: String(err) });
							break;
						}
						// First permanent error (e.g., transient Cloud Code Assist 404 routing blip):
						// drop this batch without retrying so the next turn can verify recovery.
						logger.warn("advisor permanent error; dropping batch without retry", { err: String(err) });
						success = true;
					} else {
						this.#consecutivePermanentFailures = 0;
					}
					if (!success && this.#consecutiveFailures >= 3) {
						logger.warn("advisor failure repeated; dropping backlog", { err: String(err) });
						this.#notifyFailureOnce(err);
						this.#consecutiveFailures = 0;
						this.#droppedBatches++;
						this.#seenContext.clear();
						if (this.#droppedBatches >= MAX_DROPPED_BATCH_CYCLES) {
							this.#halted = true;
							this.#pending = [];
							this.#backlog = 0;
							this.#wakeAllWaiters();
							logger.warn("advisor halted for session after repeated dropped batches", {
								droppedBatches: this.#droppedBatches,
							});
							break;
						}
						success = true;
					} else if (!success) {
						// Restore seenContext to pre-batch snapshot so re-primed retries stay accurate.
						this.#seenContext = seenSnapshot;
						this.#pending.unshift({ text: batch, turns: finalTurns });
						const delayMs = this.#retryBackoffMs(this.#consecutiveFailures);
						await this.#sleep(delayMs);
					}
				}

				if (success && this.#epoch === epoch) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
				}
			}
		} finally {
			this.#busy = false;
		}
	}

	#notifyFailureOnce(err: unknown): void {
		if (this.#failureNotified) return;
		this.#failureNotified = true;
		try {
			this.host.notifyFailure?.(err);
		} catch (notifyErr) {
			logger.warn("advisor failure notification failed", { err: String(notifyErr) });
		}
	}

	#retryBackoffMs(attempt: number): number {
		const base = Math.max(0, this.retryDelayMs);
		if (base === 0) return 0;
		const scaled = Math.min(base * 16, base * 2 ** Math.max(0, attempt - 1));
		return scaled;
	}

	#sleep(ms: number): Promise<void> {
		if (ms <= 0 || this.disposed) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const controller = new AbortController();
		this.#sleepAbort = controller;
		const finish = (): void => {
			if (this.#sleepAbort === controller) this.#sleepAbort = undefined;
			clearTimeout(timer);
			controller.signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		controller.signal.addEventListener("abort", finish, { once: true });
		return promise;
	}
}

type TextualContent = string | readonly (TextContent | ImageContent)[];

export function isPermanentAdvisorError(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	if (/Cloud Code Assist API error\s*\(404\)/i.test(text)) return true;
	if (
		/\b(?:not_found_error|model_not_found|invalid_model|unknown model|no endpoints found|model not found|invalid_request_error)\b|is not supported when/i.test(
			text,
		)
	) {
		return true;
	}
	if (
		/\b(?:404|401|403)\b[^\n]{0,160}(?:not found|does not exist|unauthorized|invalid[_ ]api[_ ]key|authentication_error|permission_error|forbidden)/i.test(
			text,
		)
	) {
		return true;
	}
	if (
		/(?:not found|does not exist|unauthorized|invalid[_ ]api[_ ]key|authentication_error|permission_error)[^\n]{0,160}\b(?:404|401|403)\b/i.test(
			text,
		)
	) {
		return true;
	}
	return false;
}

function getAdvisorEmptyResponseError(messages: readonly AgentMessage[]): Error | undefined {
	let sawAssistant = false;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		sawAssistant = true;
		if (message.stopReason !== "stop") return undefined;
		if (hasAdvisorResponseContent(message)) return undefined;
	}
	if (sawAssistant) return new Error("Advisor turn returned an empty stop response without advice");
	if (messages.length > 0) return new Error("Advisor turn ended without an assistant response");
	return undefined;
}

function hasAdvisorResponseContent(message: AssistantMessage): boolean {
	return message.content.some(block => {
		switch (block.type) {
			case "text":
				return block.text.trim().length > 0;
			case "thinking":
				return block.thinking.trim().length > 0;
			case "redactedThinking":
				return block.data.length > 0;
			case "toolCall":
				return block.name.trim().length > 0;
			case "fallback":
				return false;
			default:
				return false;
		}
	});
}

function obfuscateTextualContent(obfuscator: SecretObfuscator, content: TextualContent): TextualContent {
	if (typeof content === "string") return obfuscator.obfuscate(content);
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.obfuscate(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

function obfuscateAssistantMessage(obfuscator: SecretObfuscator, message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content = message.content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = obfuscator.obfuscate(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "toolCall") {
			const args = obfuscateToolArguments(obfuscator, block.arguments);
			if (args === block.arguments) return block;
			changed = true;
			return { ...block, arguments: args };
		}
		return block;
	});
	return changed ? { ...message, content } : message;
}

function obfuscateDetails(
	obfuscator: SecretObfuscator,
	details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!details) return details;
	// Walk strings at every depth: `customOneLiner` renders nested fields
	// (e.g. `async-result` reads `details.jobs[].label`/`jobId`), so a shallow
	// pass leaks any secret a background job's label happens to contain.
	return obfuscateToolArguments(obfuscator, details);
}

function obfuscateAdvisorMessage(obfuscator: SecretObfuscator, message: AgentMessage): AgentMessage {
	switch (message.role) {
		case "user":
		case "developer": {
			const content = obfuscateTextualContent(obfuscator, message.content as TextualContent);
			return content === message.content ? message : ({ ...(message as object), content } as AgentMessage);
		}
		case "toolResult": {
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content);
			const details = obfuscateDetails(obfuscator, msg.details);
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "assistant":
			return obfuscateAssistantMessage(obfuscator, message as AssistantMessage) as AgentMessage;
		case "custom":
		case "hookMessage": {
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content);
			const details = obfuscateDetails(obfuscator, msg.details);
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "bashExecution": {
			const msg = message as AgentMessage & { command: string; output: string };
			const command = obfuscator.obfuscate(msg.command);
			const output = obfuscator.obfuscate(msg.output);
			return command === msg.command && output === msg.output
				? message
				: ({ ...(message as object), command, output } as AgentMessage);
		}
		case "pythonExecution": {
			const msg = message as AgentMessage & { code: string; output: string };
			const code = obfuscator.obfuscate(msg.code);
			const output = obfuscator.obfuscate(msg.output);
			return code === msg.code && output === msg.output
				? message
				: ({ ...(message as object), code, output } as AgentMessage);
		}
		case "branchSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "compactionSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "fileMention": {
			const msg = message as AgentMessage & {
				files: Array<{ path: string; content: string; image?: unknown }>;
			};
			let changed = false;
			const files = msg.files.map(file => {
				const path = obfuscator.obfuscate(file.path);
				const content = obfuscator.obfuscate(file.content);
				if (path === file.path && content === file.content) return file;
				changed = true;
				return { ...file, path, content };
			});
			return changed ? ({ ...(message as object), files } as AgentMessage) : message;
		}
		default:
			return message;
	}
}

function obfuscateAdvisorDelta(obfuscator: SecretObfuscator, messages: AgentMessage[]): AgentMessage[] {
	let changed = false;
	const result = messages.map(message => {
		const next = obfuscateAdvisorMessage(obfuscator, message);
		if (next !== message) changed = true;
		return next;
	});
	return changed ? result : messages;
}
