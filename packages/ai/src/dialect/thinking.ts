import { partialSuffixOverlapAny } from "./coercion";
import { FencedThinkingScanner } from "./fenced-thinking";
import type { InbandScanEvent, InbandScanner } from "./types";

type Tag = {
	readonly open: string;
	readonly close: string;
	readonly fenced?: boolean;
	readonly closeFallback?: string;
};

/**
 * Every dialect's in-band thinking section in its canonical `renderThinking`
 * form (see the sibling `./*.ts` scanners). {@link ThinkingInbandScanner} heals
 * reasoning a model leaked into its visible text channel back into thinking
 * events, whichever dialect idiom the leak used.
 *
 * Plain (attribute-free) delimiters only — matching what `renderThinking`
 * emits and what models leak in practice. Attributed or namespaced XML thinking
 * tags (`<thinking signature="…">`, `antml:thinking`) are recovered by the owned
 * anthropic-dialect parser, not this text-channel healing fallback.
 *
 * `<think>`/`<thinking>`/`<scratchpad>` are additionally matched with one-typo
 * tolerance ({@link isThinkingTagName}) — weaker models occasionally hallucinate
 * a near-miss spelling (`<thinke>`, `<thinkin>`) consistently for both the open
 * and close tag on long turns; without this the whole malformed pair leaks
 * verbatim into the visible channel instead of collapsing into a thinking block.
 */
const TAGS: readonly Tag[] = [
	{ open: "```thinking\n", close: "```", fenced: true }, // gemini fenced thinking
	{ open: "<|channel>thought\n", close: "<channel|>" }, // gemma reasoning channel
	{ open: "<|start|>assistant<|channel|>analysis<|message|>", close: "<|end|>" }, // harmony analysis (rendered)
	{ open: "<|channel|>analysis<|message|>", close: "<|end|>" }, // harmony analysis (bare leak)
];
const OPENS = TAGS.map(tag => tag.open);
/** Longest bare `<name>` this scanner ever recognizes; bounds partial-tag holding. */
const MAX_BARE_TAG_NAME_LENGTH = 20;
const BARE_TAG_OPEN_PATTERN = /<([A-Za-z][A-Za-z0-9]{0,19})>/g;
const BARE_TAG_PARTIAL_PATTERN = /<(?:[A-Za-z][A-Za-z0-9]{0,19})?$/;

/**
 * True for the canonical thinking tag names, plus names within one character
 * edit of `think`/`thinking`/`scratchpad` that also share that name's prefix —
 * the shape of a real hallucinated typo (`thinke`, `thinkin`, `scratchpaid`),
 * not an unrelated short word (`thing`, `thin`, `chink` all fail the prefix
 * guard despite being edit-distance 1 from `think`).
 */
export function isThinkingTagName(name: string): boolean {
	const lower = name.toLowerCase();
	if (lower === "thinking" || lower === "think" || lower === "scratchpad") return true;
	if (lower.startsWith("think") && levenshteinAtMost(lower, "think", 1)) return true;
	if (lower.startsWith("thinking") && levenshteinAtMost(lower, "thinking", 1)) return true;
	if (lower.startsWith("scratchpad") && levenshteinAtMost(lower, "scratchpad", 1)) return true;
	return false;
}

/** Bounded Levenshtein distance check; avoids the full DP once `max` is exceeded. */
function levenshteinAtMost(a: string, b: string, max: number): boolean {
	if (Math.abs(a.length - b.length) > max) return false;
	const prev = new Array<number>(b.length + 1);
	const curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		let rowMin = curr[0]!;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
			rowMin = Math.min(rowMin, curr[j]!);
		}
		if (rowMin > max) return false;
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
	}
	return prev[b.length]! <= max;
}

/**
 * Earliest bare `<name>` tag (no attributes) whose name passes
 * {@link isThinkingTagName}, paired with its matching `</name>` close. Runs
 * alongside the literal {@link TAGS} idioms so `<think>`/`<thinking>`/
 * `<scratchpad>` and their one-typo variants share a single fuzzy path.
 * `closeFallback` additionally accepts a clean `</thinking>` close even when
 * the open itself was a typo'd variant — evidence shows a model's open and
 * close spellings can diverge independently within the same turn.
 */
function findBareThinkingOpen(buffer: string): (Tag & { index: number }) | undefined {
	for (const match of buffer.matchAll(BARE_TAG_OPEN_PATTERN)) {
		const name = match[1]!;
		if (!isThinkingTagName(name)) continue;
		const close = `</${name}>`;
		return {
			open: match[0],
			close,
			closeFallback: close === "</thinking>" ? undefined : "</thinking>",
			index: match.index,
		};
	}
	return undefined;
}

/**
 * Detect a bare thinking-tag open that can never close validly: `<` followed
 * by a name-shaped run (passing {@link isThinkingTagName}) that is itself
 * immediately followed by something other than `>` — whitespace, a newline,
 * or any other character. A model that drops the closing `>` (or garbles
 * `<thinking>` into `<thinke` before moving straight into its actual
 * reasoning) leaves exactly this shape: `<thinke\n<reasoning text>`. Unlike
 * {@link bareTagPartialHold}, which holds a run that could *still* grow into
 * a valid `<name>`, this fires only once the buffer proves the run is over
 * and no `>` arrived — so it never races with, or preempts, the
 * well-formed/one-typo match above (that one requires `>` immediately after
 * the name; this one requires the opposite).
 *
 * `closeFallback` is always `</thinking>`: the malformed open carries no
 * reliable spelling to expect back, so any well-formed thinking close ends
 * the block. This is the exact failure mode reported in practice: a broken
 * open (`<thinke`, no `>`) paired with a clean `</thinking>` close — without
 * this, neither tag is ever recognized and both leak verbatim into the
 * visible channel around the reasoning text they were meant to wrap.
 */
function findUnterminatedBareThinkingOpen(buffer: string): (Tag & { index: number }) | undefined {
	for (let i = 0; i < buffer.length; i++) {
		if (buffer[i] !== "<") continue;
		const nameStart = i + 1;
		if (!/[A-Za-z]/.test(buffer[nameStart] ?? "")) continue;
		let end = nameStart + 1;
		while (end < buffer.length && end - nameStart < MAX_BARE_TAG_NAME_LENGTH && /[A-Za-z0-9]/.test(buffer[end]!)) {
			end++;
		}
		// Still growable (name run hit the end of the buffer with no terminator
		// yet), or a valid `>`-closed tag — not this function's job either way.
		if (end >= buffer.length || buffer[end] === ">") continue;
		const name = buffer.slice(nameStart, end);
		if (!isThinkingTagName(name)) continue;
		return { open: buffer.slice(i, end), close: `</${name}>`, closeFallback: "</thinking>", index: i };
	}
	return undefined;
}

/**
 * Holds back a buffer tail shaped like an unterminated bare tag (`<`,
 * optionally followed by letters/digits, no `>` yet) so a diverging spelling
 * isn't flushed as visible text one character before its typo would have
 * matched {@link isThinkingTagName} — e.g. `<thinke` must survive until the
 * closing `>` arrives and resolves it. Bounded by
 * {@link MAX_BARE_TAG_NAME_LENGTH} so an angle bracket in ordinary prose
 * can't stall the stream indefinitely; once that bound is exceeded without a
 * `>`, {@link findUnterminatedBareThinkingOpen} has already had — and taken —
 * its chance to recognize a conclusively-broken thinking-tag attempt on the
 * same buffer, so anything still unresolved here is either not
 * thinking-tag-shaped or a `<` in ordinary prose, and is safe to release as
 * visible text.
 */
function bareTagPartialHold(buffer: string): number {
	const openIndex = buffer.lastIndexOf("<");
	if (openIndex === -1) return 0;
	const tail = buffer.slice(openIndex);
	if (tail.length > MAX_BARE_TAG_NAME_LENGTH + 1) return 0;
	return BARE_TAG_PARTIAL_PATTERN.test(tail) ? tail.length : 0;
}

export class ThinkingInbandScanner implements InbandScanner {
	#buffer = "";
	#closeTag = "";
	/** Alternate close accepted alongside {@link #closeTag} — set when the open
	 *  tag's own spelling can't be trusted as a predictor of the close spelling
	 *  (see {@link findUnterminatedBareThinkingOpen}). Empty when there is no
	 *  fallback, in which case only `#closeTag` is checked. */
	#closeFallback = "";
	#thinking = "";
	/** Fence-aware close-matcher while inside a ` ```thinking ` block; undefined otherwise. */
	#fenced: FencedThinkingScanner | undefined;

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): InbandScanEvent[] {
		const events = this.#consume(true);
		if (this.#buffer.length === 0) return events;
		if (this.#closeTag) {
			this.#emitThinking(this.#buffer, events);
			events.push({ type: "thinkingEnd", thinking: this.#thinking });
		} else {
			events.push({ type: "text", text: this.#buffer });
		}
		this.#buffer = "";
		this.#closeTag = "";
		this.#closeFallback = "";
		return events;
	}

	#consume(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		for (;;) {
			if (this.#fenced) {
				// Run even with an empty buffer so a held partial close flushes on final.
				const result = this.#fenced.feed(this.#buffer, final);
				this.#buffer = result.closed ? result.rest : "";
				this.#emitThinking(result.thinking, events);
				if (result.closed || final) {
					events.push({ type: "thinkingEnd", thinking: this.#thinking });
					this.#thinking = "";
					this.#closeTag = "";
					this.#closeFallback = "";
					this.#fenced = undefined;
				}
				if (this.#fenced) break;
				continue;
			}
			if (this.#buffer.length === 0) break;
			if (this.#closeTag) {
				const candidates = this.#closeFallback ? [this.#closeTag, this.#closeFallback] : [this.#closeTag];
				const found = earliestIndexOf(this.#buffer, candidates);
				if (!found) {
					const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, candidates);
					this.#emitThinking(this.#buffer.slice(0, this.#buffer.length - hold), events);
					this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
					break;
				}
				this.#emitThinking(this.#buffer.slice(0, found.index), events);
				this.#buffer = this.#buffer.slice(found.index + found.tag.length);
				events.push({ type: "thinkingEnd", thinking: this.#thinking });
				this.#thinking = "";
				this.#closeTag = "";
				this.#closeFallback = "";
				continue;
			}

			const tag = findEarliestOpen(this.#buffer);
			if (!tag) {
				const hold = final
					? 0
					: Math.max(partialSuffixOverlapAny(this.#buffer, OPENS), bareTagPartialHold(this.#buffer));
				const emit = this.#buffer.slice(0, this.#buffer.length - hold);
				if (emit.length > 0) events.push({ type: "text", text: emit });
				this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
				break;
			}
			if (tag.index > 0) events.push({ type: "text", text: this.#buffer.slice(0, tag.index) });
			this.#buffer = this.#buffer.slice(tag.index + tag.open.length);
			this.#closeTag = tag.close;
			this.#closeFallback = tag.closeFallback ?? "";
			this.#thinking = "";
			if (tag.fenced) this.#fenced = new FencedThinkingScanner();
			events.push({ type: "thinkingStart" });
		}
		return events;
	}

	#emitThinking(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#thinking += delta;
		events.push({ type: "thinkingDelta", delta });
	}
}

/** Earliest match among several candidate substrings, or `undefined` if none occur. */
function earliestIndexOf(buffer: string, candidates: readonly string[]): { index: number; tag: string } | undefined {
	let best: { index: number; tag: string } | undefined;
	for (const tag of candidates) {
		const index = buffer.indexOf(tag);
		if (index !== -1 && (!best || index < best.index)) best = { index, tag };
	}
	return best;
}

function findEarliestOpen(buffer: string): (Tag & { index: number }) | undefined {
	let best: (Tag & { index: number }) | undefined;
	for (const tag of TAGS) {
		const index = buffer.indexOf(tag.open);
		if (index !== -1 && (!best || index < best.index)) best = { ...tag, index };
	}
	const bare = findBareThinkingOpen(buffer);
	if (bare && (!best || bare.index < best.index)) best = bare;
	const unterminated = findUnterminatedBareThinkingOpen(buffer);
	if (unterminated && (!best || unterminated.index < best.index)) best = unterminated;
	return best;
}
