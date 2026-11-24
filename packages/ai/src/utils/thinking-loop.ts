/**
 * Thinking-loop guard.
 *
 * Gemini models (notably `gemini-3.5-flash` via OpenRouter) occasionally fall
 * into a degenerate reasoning loop: they re-emit the same paragraph intent over
 * and over with cosmetic wording drift ("Confirming Safety", "Verifying
 * Completion", …), burning the entire output budget without ever calling a tool
 * or answering. The runaway is *not* byte-identical, so a cheap verbatim
 * tail-repeat check alone misses it.
 *
 * This guard watches streamed deltas and, on a match, terminates the stream with
 * a synthetic `error` {@link AssistantMessage} whose terminal content is empty.
 * Deltas emitted before enough evidence accumulates may already be observable to
 * a live streaming consumer; the empty terminal prevents the failed attempt from
 * being committed or replayed. Tagged with `AIError.Flag.ThinkingLoop`, the
 * result lets `AgentSession` discard the runaway and re-sample.
 *
 * Four failure shapes are detected:
 * 1. **Exact suffix cycles** — an O(n) Z-array detector over the rolling tail
 *    catching byte-identical cycles up to 1024 chars (including long runaways).
 * 2. **Near-duplicate segments** — paragraphs that normalize to the same
 *    word-trigram fingerprint (Jaccard window) or 3 consecutive identical
 *    segments across flushes.
 * 3. **Progress-lexicon stall** — paragraphs that keep reshuffling the same
 *    motivational filler into fresh word order without introducing new
 *    vocabulary or concrete code/path anchors.
 * 4. **Gemini summary-header runaway** — handled separately by
 *    {@link GeminiHeaderRunDetector}.
 *
 * Disable detection with `PI_NO_THINKING_LOOP_GUARD=1`.
 */
import { logger } from "jeopi-utils";
import * as AIError from "../error";
import type { Api, AssistantMessage, Model, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "./event-stream";

/** Stable lead phrase of the guard's error message; exported for tests. The
 *  message also carries "stream stall" so the session + transport retry
 *  classifiers treat it as a transient (retryable) stop without bespoke rules. */
export const THINKING_LOOP_ERROR_MARKER = "Thinking loop detected";

/** Rolling tail retained for exact suffix-cycle detection. */
const EXACT_TAIL_WINDOW = 4096;
/** Longest exact cycle length considered. */
const EXACT_MAX_UNIT = 1024;
/** New characters between scans. Large deltas are scanned immediately. */
const EXACT_CHECK_STRIDE = 128;
/** Short cycles need four repeats covering at least this many characters. */
const EXACT_SHORT_MAX_UNIT = 60;
const EXACT_SHORT_MIN_REPEATED_CHARS = 180;
/** Long cycles need at least three repeats covering at least this many chars. */
const EXACT_LONG_MIN_REPEATED_CHARS = 1024;
/** Short newline-spanning cycles (e.g. identical repeated lines) trip earlier
 *  only after a long sustained run so brief summarizer status lines are spared. */
const EXACT_SHORT_NEWLINE_MIN_COUNT = 12;
const EXACT_SHORT_NEWLINE_MIN_CHARS = 512;
/** Repeated characters before a punctuation-only run counts as a loop. */
const EXACT_PUNCTUATION_MIN_REPEATED_CHARS = EXACT_LONG_MIN_REPEATED_CHARS;

/** Char cap for an unterminated segment; forces a flush so a wall-of-text loop
 *  (no blank lines / headings) still segments. */
const SEGMENT_CHAR_CAP = 700;
/** Normalized-length floor below which a segment is ignored (too short to be a
 *  meaningful paragraph; bare headings must not trip detection). */
const SEGMENT_MIN_NORM_CHARS = 60;
/** How many recent substantial segments are kept for similarity comparison. */
const SEGMENT_WINDOW = 16;
/** Word-trigram Jaccard at/above which two segments count as near-duplicates. */
const SEGMENT_SIMILARITY = 0.8;
/** Substantial segments required before similarity/stall detection may fire (warm-up). */
const SEGMENT_MIN_COUNT = 8;
/** Near-duplicate cluster size (current + matches) that trips the loop. */
const SEGMENT_MIN_CLUSTER = 4;
/** Consecutive identical substantial segments that trip immediately (even across flushes). */
const CONSECUTIVE_EXACT_LIMIT = 3;

const JSON_STRING_TAIL = /^[^"\n]*"(?=\s*[,}\]:])/;
const JSON_STRING_LEAD = /^\s*"(?:\\.|[^"\\\n])*"?(?=\s*[,}\]:]|$)/;
const JSON_STRING = /(?<=[{[,:]\s*)"(?:\\.|[^"\\\n])*"?/g;
const JSON_SCALAR = /""|-?\d[\d.eE+-]*|true|false|null/;
const JSON_SCALAR_ARRAY = new RegExp(
	`\\[\\s*(?:(?:${JSON_SCALAR.source})(?:\\s*,\\s*(?:${JSON_SCALAR.source}))*)?\\s*\\]`,
);
const JSON_FIELD = new RegExp(
	`(?:^|[{,])\\s*""\\s*:\\s*(?:${JSON_SCALAR.source}|${JSON_SCALAR_ARRAY.source})|^\\s*""(?=\\s*[,}\\]])`,
	"gm",
);
const JSON_MIN_FIELDS = 2;
const JSON_MIN_FIELD_SHARE = 0.5;
const TABLE_ROW_MIN_PIPES = 2;
const TABLE_MIN_LINES = 2;
const TABLE_ROW_MIN_SHARE = 0.6;

/** Recent segments whose pooled unigram vocabulary is the novelty baseline for
 *  progress-lexicon stall detection. */
const LEX_NOVELTY_WINDOW = 8;
/** Novelty floor at/below which a segment counts as recycling earlier wording. */
const LEX_STALL_NOVELTY_FLOOR = 0.2;
/** Consecutive low-information segments that trip a progress-lexicon stall. */
const LEX_STALL_MIN_RUN = 8;

const CONCRETE_ANCHOR =
	/`[^`]+`|\b\w{2,}\.[a-zA-Z]\w{0,4}\b|[\w-]+(?:\/[\w-]+){2,}|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g;

/** A whole line shaped like code rather than prose: a fence marker, an indented
 *  line that is not a nested list item, or a line ending in a block, statement,
 *  or markup delimiter. */
const CODE_LINE = /^(?:[ \t]*```.*|(?: {2,}|\t)(?![ \t]*(?:[-*+]|\d+[.)])[ \t]).*|.*[{}[\](;,>][ \t]*)$/gm;

const OPENAI_COMPAT_GUARDED_APIS: Partial<Record<Api, true>> = {
	"openai-completions": true,
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
};

/**
 * How much of the loop guard runs on a stream: `off` none, `exact` only
 * exact suffix cycles, `semantic` exact cycles plus the near-duplicate and
 * progress-lexicon paragraph heuristics.
 */
export type LoopGuardLevel = "off" | "exact" | "semantic";

/**
 * True when `model` is a Gemini model whose native thinking stream surfaces the
 * "thought summary" titles this module's header guard counts.
 */
export function isGeminiThinkingModel(model: Model<Api>): boolean {
	if (OPENAI_COMPAT_GUARDED_APIS[model.api]) {
		const compat = model.compat as { enableGeminiThinkingLoopGuard?: boolean } | undefined;
		return compat?.enableGeminiThinkingLoopGuard === true;
	}
	return /gemini/i.test(`${model.provider}/${model.id}`);
}

/**
 * True when `model` should be guarded with full semantic thinking/response
 * loop heuristics (Gemini & DeepSeek).
 */
export function isLoopGuardedModel(model: Model<Api>, options?: StreamOptions): boolean {
	if (options?.loopGuard?.enabled === false) return false;
	const isDeepseek = /deepseek/i.test(`${model.provider}/${model.id}`);
	return isGeminiThinkingModel(model) || isDeepseek;
}

/** @deprecated Use isLoopGuardedModel instead. */
export function isGeminiThinkingLoopModel(model: Model<Api>): boolean {
	return isLoopGuardedModel(model);
}

/**
 * Loop-guard level for a model stream. `PI_NO_THINKING_LOOP_GUARD=1` and
 * `loopGuard.enabled: false` turn it off; Gemini/DeepSeek/Grok get `semantic`,
 * Claude is `off`, and other models get `exact`.
 */
export function loopGuardLevel(model: Model<Api>, options?: StreamOptions): LoopGuardLevel {
	if (process.env.PI_NO_THINKING_LOOP_GUARD === "1" || options?.loopGuard?.enabled === false) return "off";
	const id = `${model.provider}/${model.id}`;
	if (isLoopGuardedModel(model, options) || /grok/i.test(id)) return "semantic";
	if (/claude/i.test(id)) return "off";
	return "exact";
}

/**
 * Stateful detector fed the streamed thinking deltas. `push` returns a
 * human-readable reason the first time a loop shape is recognized; the caller
 * is responsible for stopping after the first hit.
 */
export class ThinkingLoopDetector {
	/** Rolling char tail for exact suffix-cycle detection. */
	#tail = "";
	/** Total characters received since the exact detector last scanned. */
	#exactScannedAt = 0;
	/** Pending thinking text not yet split into completed segments. */
	#pending = "";
	/** Fingerprints of the most recent substantial segments (≤ SEGMENT_WINDOW). */
	#window: Set<string>[] = [];
	/** Count of substantial segments seen so far (warm-up gate). */
	#count = 0;
	/** Unigram word sets of the most recent segments (≤ LEX_NOVELTY_WINDOW). */
	#wordWindow: Set<string>[] = [];
	/** Consecutive low-information (low-novelty, anchor-free) segments seen. */
	#lexStallRun = 0;
	/** Concrete anchors seen per recent segment (≤ LEX_NOVELTY_WINDOW). */
	#anchorWindow: Set<string>[] = [];
	/** Most recent normalized substantial segment and its consecutive run length. */
	#lastNorm = "";
	#consecutiveExact = 0;

	constructor(private readonly semanticHeuristics = true) {}

	push(delta: string): string | null {
		if (!delta) return null;

		// 1. Exact suffix cycles. Scan at a bounded cadence rather than doing
		// work for every token-sized delta.
		this.#tail += delta;
		if (this.#tail.length > EXACT_TAIL_WINDOW) this.#tail = this.#tail.slice(-EXACT_TAIL_WINDOW);
		this.#exactScannedAt += delta.length;
		if (this.#exactScannedAt >= EXACT_CHECK_STRIDE || delta.length >= EXACT_CHECK_STRIDE) {
			this.#exactScannedAt = 0;
			const exact = detectExactSuffixCycle(this.#tail);
			if (exact) {
				const [unit, times] = exact;
				return `repeated an exact ${unit.length}-character cycle ${times}× back-to-back`;
			}
		}

		if (!this.semanticHeuristics) return null;

		// 2. Near-duplicate paragraph loop. Append, then drain completed segments.
		this.#pending += delta;
		while (true) {
			const boundary = /\n\s*\n/.exec(this.#pending);
			let raw: string;
			if (boundary) {
				raw = this.#pending.slice(0, boundary.index);
				this.#pending = this.#pending.slice(boundary.index + boundary[0].length);
			} else if (this.#pending.length > SEGMENT_CHAR_CAP) {
				raw = this.#pending.slice(0, SEGMENT_CHAR_CAP);
				this.#pending = this.#pending.slice(SEGMENT_CHAR_CAP);
			} else {
				return null;
			}
			for (let rest = raw; rest.length > 0; ) {
				const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
				rest = rest.slice(chunk.length);
				const hit = this.#consumeSegment(chunk);
				if (hit) return hit;
			}
		}
	}

	/** Process the buffered trailing paragraph and run one final exact-cycle check. */
	flush(): string | null {
		const exact = detectExactSuffixCycle(this.#tail);
		if (exact) {
			const [unit, times] = exact;
			return `repeated an exact ${unit.length}-character cycle ${times}× back-to-back`;
		}
		if (!this.semanticHeuristics || !this.#pending) return null;
		let rest = this.#pending;
		this.#pending = "";
		while (rest.length > 0) {
			const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
			rest = rest.slice(chunk.length);
			const hit = this.#consumeSegment(chunk);
			if (hit) return hit;
		}
		return null;
	}

	#consumeSegment(raw: string): string | null {
		// Strip titles and code-shaped lines before prose analysis.
		const segment = raw
			.replace(CODE_LINE, "")
			.replace(/^[ \t]*#{1,6}[ \t].*$/gm, "")
			.replace(/^[ \t]*\*{2,3}.+?\*{2,3}[ \t]*$/gm, "");
		const normalized = normalizeSegment(segment);
		if (normalized.length < SEGMENT_MIN_NORM_CHARS) return null;

		// Check consecutive exact-identical segments even for structured tables,
		// because byte-identical repeated blocks are never legitimate progress.
		const exactKey = raw.trim();
		if (exactKey === this.#lastNorm) {
			this.#consecutiveExact++;
			if (this.#consecutiveExact >= CONSECUTIVE_EXACT_LIMIT) {
				return `${this.#consecutiveExact} consecutive identical segments`;
			}
		} else {
			this.#lastNorm = exactKey;
			this.#consecutiveExact = 1;
		}

		// Structured answer content is not reasoning; skip similarity & novelty checks.
		if (isStructuredSegment(segment)) return null;

		const fingerprint = trigramShingles(normalized);
		let cluster = 1;
		for (const prev of this.#window) {
			if (jaccard(fingerprint, prev) >= SEGMENT_SIMILARITY) cluster++;
		}

		const words = new Set<string>(normalized.split(" ").filter(Boolean));
		const priorVocab = new Set<string>();
		for (const set of this.#wordWindow) for (const w of set) priorVocab.add(w);
		let unseen = 0;
		for (const w of words) if (!priorVocab.has(w)) unseen++;
		const novelty = priorVocab.size === 0 ? 1 : unseen / words.size;

		const anchors = new Set<string>();
		for (const match of segment.matchAll(CONCRETE_ANCHOR)) anchors.add(match[0].replace(/`/g, "").toLowerCase());
		let newAnchor = false;
		for (const anchor of anchors) {
			if (this.#anchorWindow.every(seen => !seen.has(anchor))) {
				newAnchor = true;
				break;
			}
		}

		if (novelty <= LEX_STALL_NOVELTY_FLOOR && !newAnchor) {
			this.#lexStallRun++;
		} else {
			this.#lexStallRun = 0;
		}

		this.#window.push(fingerprint);
		if (this.#window.length > SEGMENT_WINDOW) this.#window.shift();
		this.#wordWindow.push(words);
		if (this.#wordWindow.length > LEX_NOVELTY_WINDOW) this.#wordWindow.shift();
		this.#anchorWindow.push(anchors);
		if (this.#anchorWindow.length > LEX_NOVELTY_WINDOW) this.#anchorWindow.shift();
		this.#count++;

		if (this.#count >= SEGMENT_MIN_COUNT) {
			if (cluster >= SEGMENT_MIN_CLUSTER) {
				return `${cluster} near-identical segments within the last ${SEGMENT_WINDOW}`;
			}
			if (this.#lexStallRun >= LEX_STALL_MIN_RUN) {
				return `${this.#lexStallRun} low-information segments recycling recent wording`;
			}
		}
		return null;
	}
}

/**
 * Consecutive Gemini thought-summary headers in one uninterrupted reasoning
 * stream that trips the tool-call reminder. Set well above legitimate hard
 * reasoning depth while still tripping fast on narration runaways.
 */
export const GEMINI_HEADER_RUNAWAY_THRESHOLD = 64;

/**
 * True when a single trimmed line is a Gemini reasoning-summary title: a markdown
 * ATX heading (`## …`) or a whole-line bold / bold-italic run (`**Title**`,
 * `***Title***`).
 */
export function isReasoningSummaryHeader(line: string): boolean {
	return /^#{1,6}[ \t]+\S/.test(line) || /^\*{2,3}.+\*{2,3}$/.test(line);
}

/**
 * Counts consecutive Gemini reasoning-summary headers across a streamed thinking
 * block.
 */
export class GeminiHeaderRunDetector {
	#pending = "";
	#count = 0;
	#fired = false;

	push(delta: string): boolean {
		if (this.#fired || !delta) return false;
		this.#pending += delta;
		let nl = this.#pending.indexOf("\n");
		while (nl !== -1) {
			const line = this.#pending.slice(0, nl).trim();
			this.#pending = this.#pending.slice(nl + 1);
			if (line !== "" && isReasoningSummaryHeader(line) && ++this.#count >= GEMINI_HEADER_RUNAWAY_THRESHOLD) {
				this.#fired = true;
				return true;
			}
			nl = this.#pending.indexOf("\n");
		}
		return false;
	}

	get count(): number {
		return this.#count;
	}

	reset(): void {
		this.#pending = "";
		this.#count = 0;
		this.#fired = false;
	}
}

/**
 * Wrap a provider stream with the loop guard. `controller` is the guard's own
 * abort handle: aborting it tears down the upstream once a loop trips.
 */
export function guardThinkingLoopStream(
	inner: AssistantMessageEventStream,
	model: Model<Api>,
	controller: AbortController,
	options?: StreamOptions,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const semanticHeuristics = loopGuardLevel(model, options) === "semantic";
	const thinkingDetector = new ThinkingLoopDetector(semanticHeuristics);
	const textDetector = new ThinkingLoopDetector(semanticHeuristics);
	const checkAssistantContent = options?.loopGuard?.checkAssistantContent !== false;

	void (async () => {
		let thinkingArmed = true;
		let textArmed = checkAssistantContent;
		let textStarted = false;
		let snapshot: AssistantMessage | undefined;
		let attemptStart: number | undefined;
		let firstDeltaAt: number | undefined;
		try {
			for await (const event of inner) {
				const next = "partial" in event ? event.partial : event.type === "done" ? event.message : undefined;
				if (next) {
					if (next.timestamp !== attemptStart) {
						attemptStart = next.timestamp;
						firstDeltaAt = undefined;
					}
					snapshot = next;
				}
				if (
					firstDeltaAt === undefined &&
					(event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
				) {
					firstDeltaAt = Date.now();
				}
				let detail: string | null = null;
				if (event.type === "thinking_delta") {
					// Re-arm after thinking_end / toolcall_start unless visible answer
					// text has already latched the detector off (xAI/Grok Responses).
					if (!textStarted) {
						thinkingArmed = true;
						detail = thinkingDetector.push(event.delta);
					}
				} else if (event.type === "thinking_end") {
					if (thinkingArmed) {
						detail = thinkingDetector.flush();
					}
				} else if (event.type === "text_start") {
					// Empty text item announcement — do not latch thinking detector yet.
				} else if (event.type === "text_delta") {
					if (event.delta.trim().length > 0) {
						thinkingArmed = false;
						textStarted = true;
					}
					if (textArmed) {
						detail = textDetector.push(event.delta);
					}
				} else if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
					textArmed = false;
				} else if (event.type === "done") {
					if (thinkingArmed) {
						detail = thinkingDetector.flush();
					}
					if (textArmed) {
						detail = detail || textDetector.flush();
					}
				}
				if (detail) {
					logger.warn("Thinking loop detected; aborting stream for retry.", {
						model: model.id,
						provider: model.provider,
						detail,
					});
					controller.abort(
						AIError.attach(new Error(THINKING_LOOP_ERROR_MARKER), AIError.create(AIError.Flag.ThinkingLoop)),
					);
					outer.push({
						type: "error",
						reason: "error",
						error: buildThinkingLoopError(model, detail, snapshot, firstDeltaAt),
					});
					return;
				}
				outer.push(event);
				if (outer.done) return;
			}
			if (!outer.done) {
				try {
					outer.end(await inner.result());
				} catch (err) {
					outer.fail(err);
				}
			}
		} catch (err) {
			if (!outer.done) outer.fail(err);
		}
	})();

	return outer;
}

/**
 * Apply the loop guard around a provider dispatch at the model's
 * {@link loopGuardLevel}; `off` dispatches unwrapped.
 */
export function withThinkingLoopGuard<
	O extends { signal?: AbortSignal; loopGuard?: { enabled?: boolean; checkAssistantContent?: boolean } },
>(
	model: Model<Api>,
	options: O | undefined,
	dispatch: (options: O | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (loopGuardLevel(model, options) === "off") return dispatch(options);
	const controller = new AbortController();
	const caller = options?.signal;
	const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
	const merged = { ...options, signal } as O;
	return guardThinkingLoopStream(dispatch(merged), model, controller, options);
}

/**
 * Backwards-compatible entry point used by `stream.ts` and tests.
 */
export function withGeminiThinkingLoopGuard<
	O extends { signal?: AbortSignal; loopGuard?: { enabled?: boolean; checkAssistantContent?: boolean } },
>(
	model: Model<Api>,
	options: O | undefined,
	dispatch: (options: O | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	return withThinkingLoopGuard(model, options, dispatch);
}

function buildThinkingLoopError(
	model: Model<Api>,
	detail: string,
	snapshot: AssistantMessage | undefined,
	firstDeltaAt: number | undefined,
): AssistantMessage {
	const now = Date.now();
	const duration = snapshot ? (snapshot.duration ?? now - snapshot.timestamp) : undefined;
	const ttft =
		snapshot?.ttft ??
		(snapshot && firstDeltaAt !== undefined ? Math.max(0, firstDeltaAt - snapshot.timestamp) : undefined);
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: snapshot?.usage
			? structuredClone(snapshot.usage)
			: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
		stopReason: "error",
		errorMessage: `${THINKING_LOOP_ERROR_MARKER}: the model repeated near-identical content (${detail}). Treating as a stream stall and retrying.`,
		errorId: AIError.create(AIError.Flag.ThinkingLoop),
		...(snapshot?.responseId && { responseId: snapshot.responseId }),
		...(duration !== undefined && { duration }),
		...(ttft !== undefined && { ttft }),
		timestamp: snapshot?.timestamp ?? now,
	};
}

/** Reused Z-array scratch; scans are synchronous, so one buffer suffices. */
const exactZ = new Uint16Array(EXACT_MAX_UNIT + 1);

/**
 * Detect an exact cycle at the text suffix in O(n) time via a Z-array over
 * the virtually reversed tail.
 */
function detectExactSuffixCycle(text: string): [unit: string, count: number] | null {
	const n = text.length;
	if (n < EXACT_SHORT_MIN_REPEATED_CHARS) return null;
	const last = n - 1;
	const maxUnit = Math.min(EXACT_MAX_UNIT, Math.floor(n / 3));
	const z = exactZ;
	let left = 0;
	let right = 0;
	for (let i = 1; i <= maxUnit; i++) {
		let zi = i <= right ? Math.min(right - i + 1, z[i - left]) : 0;
		while (i + zi < n && text.charCodeAt(last - zi) === text.charCodeAt(last - i - zi)) zi++;
		z[i] = zi;
		if (i + zi - 1 > right) {
			left = i;
			right = i + zi - 1;
		}
	}

	for (let len = 2; len <= maxUnit; len++) {
		const count = 1 + Math.floor(z[len] / len);
		const minCount = len <= EXACT_SHORT_MAX_UNIT ? 4 : 3;
		if (count < minCount) continue;
		const unit = text.slice(-len);
		if (/\p{L}|\p{Extended_Pictographic}/u.test(unit)) {
			if (len <= EXACT_SHORT_MAX_UNIT && !unit.includes("\n")) {
				if (len * count >= EXACT_SHORT_MIN_REPEATED_CHARS) return [unit, count];
				continue;
			}
			if (
				len * count >= EXACT_LONG_MIN_REPEATED_CHARS ||
				(len <= EXACT_SHORT_MAX_UNIT &&
					count >= EXACT_SHORT_NEWLINE_MIN_COUNT &&
					len * count >= EXACT_SHORT_NEWLINE_MIN_CHARS)
			) {
				return [unit, count];
			}
			continue;
		}
		if (/^[\p{N}\s]*$/u.test(unit)) continue;
		if (len * count >= EXACT_PUNCTUATION_MIN_REPEATED_CHARS) return [unit, count];
	}
	return null;
}

function isStructuredSegment(segment: string): boolean {
	const masked = segment.replace(JSON_STRING_TAIL, '""').replace(JSON_STRING_LEAD, '""').replace(JSON_STRING, '""');
	let fields = 0;
	let fieldChars = 0;
	for (const match of masked.matchAll(JSON_FIELD)) {
		fields++;
		fieldChars += match[0].length;
	}
	if (fields >= JSON_MIN_FIELDS && fieldChars >= masked.trim().length * JSON_MIN_FIELD_SHARE) return true;
	const lines = segment.split("\n").filter(line => line.trim() !== "");
	if (lines.length < TABLE_MIN_LINES) return false;
	const tableRows = lines.filter(
		line => /^\s*\|/.test(line) && (line.match(/\|/g)?.length ?? 0) >= TABLE_ROW_MIN_PIPES,
	).length;
	return tableRows >= lines.length * TABLE_ROW_MIN_SHARE;
}

function normalizeSegment(segment: string): string {
	return segment
		.toLowerCase()
		.replace(/`([^`]*)`/g, " $1 ")
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.filter(token => /[a-z]/.test(token))
		.join(" ")
		.trim();
}

function trigramShingles(normalized: string): Set<string> {
	const words = normalized.split(" ").filter(Boolean);
	if (words.length < 3) return new Set(words.length > 0 ? [words.join(" ")] : []);
	const shingles = new Set<string>();
	for (let i = 0; i + 3 <= words.length; i++) {
		shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
	}
	return shingles;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	const [small, large] = a.size < b.size ? [a, b] : [b, a];
	let intersection = 0;
	for (const x of small) {
		if (large.has(x)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
