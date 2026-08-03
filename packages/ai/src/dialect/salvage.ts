/**
 * Recovery for tool calls a native-tool-calling model emitted as plain text.
 *
 * Symptom: the provider returns a normal `end_turn` whose visible text carries
 * a fully-formed Anthropic-style `<invoke name="…">…</invoke>` block instead of
 * native `tool_use` content. The turn then holds zero runnable tool calls, so
 * the agent loop stops with the markup rendered verbatim to the user and the
 * announced work never runs.
 *
 * This module re-materializes such a turn into real `toolCall` blocks using the
 * same in-band scanner the owned-dialect path uses, so the loop dispatches them
 * unchanged. It is deliberately conservative: a turn is salvaged ONLY when the
 * markup is unambiguously a call the model meant to make (see
 * {@link salvageLeakedToolCalls}), never when it is quoted documentation.
 */
import type { AssistantMessage, ToolCall } from "../types";
import { computeFenceRanges, isInsideFence } from "../utils/fences";
import { parseInbandToolMessage } from "./owned-stream";
import type { InbandTool } from "./types";

/** Matches an opening invoke tag, with or without a dialect prefix (`x:invoke`). */
const INVOKE_OPEN_RE = /<\s*(?:[A-Za-z_][\w.-]*:)?invoke\b/g;

export interface SalvagedToolCalls {
	/** The rewritten turn: markup removed from text, real `toolCall` blocks appended. */
	readonly message: AssistantMessage;
	/** The calls recovered from the leaked markup, in emission order. */
	readonly calls: readonly ToolCall[];
}

/**
 * Recover tool calls a model wrote as visible text instead of native tool_use.
 *
 * Returns `undefined` unless EVERY guard holds — each one exists to keep a turn
 * that merely *talks about* tool syntax from being executed:
 *
 * - The turn ended normally (`stop`). `length` may have truncated the markup
 *   mid-argument, and `error`/`aborted` turns are already handled upstream.
 * - The turn carries no native `toolCall` block. A model that called tools
 *   natively AND quoted markup is documenting, not leaking.
 * - At least one `<invoke` appears outside a fenced code block, and none appear
 *   inside one. Fenced markup is quoted by construction; mixing the two is
 *   ambiguous, so the whole turn is left alone.
 * - The scanner recovers at least one call, and every recovered call names a
 *   tool that is actually available this turn (matching `name` or
 *   `customWireName`, mirroring the loop's own dispatch lookup).
 *
 * The caller decides what to do with the result; this function has no side
 * effects and never mutates `message`.
 */
export function salvageLeakedToolCalls(
	message: AssistantMessage,
	tools: readonly InbandTool[] | undefined,
): SalvagedToolCalls | undefined {
	if (message.stopReason !== "stop") return undefined;
	if (!tools || tools.length === 0) return undefined;
	if (message.content.some(block => block.type === "toolCall")) return undefined;

	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
	}
	if (text.length === 0) return undefined;

	const fences = computeFenceRanges(text);
	let bare = 0;
	INVOKE_OPEN_RE.lastIndex = 0;
	for (const match of text.matchAll(INVOKE_OPEN_RE)) {
		if (isInsideFence(fences, match.index ?? 0)) return undefined;
		bare++;
	}
	if (bare === 0) return undefined;

	const parsed = parseInbandToolMessage(message, "anthropic", tools);
	const calls = parsed.content.filter((block): block is ToolCall => block.type === "toolCall");
	if (calls.length === 0) return undefined;

	const available = new Set<string>();
	for (const tool of tools) {
		available.add(tool.name);
		if (tool.customWireName !== undefined) available.add(tool.customWireName);
	}
	if (!calls.every(call => available.has(call.name))) return undefined;

	// `stopReason` is restated rather than inherited: the projector happens to
	// derive `toolUse` today, but this function's contract is "the loop must see
	// a runnable tool turn, not a finished answer" — that must not silently
	// depend on an internal of the owned-stream projector.
	return { message: { ...parsed, stopReason: "toolUse" }, calls };
}
