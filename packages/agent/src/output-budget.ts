import type { AssistantMessage, Context, Message, Model, Tool } from "jeopi-ai";
import { calculateContextTokens, estimateTokens } from "./compaction/compaction";
import { countTokens } from "./tokenizer";

/** Smallest output cap {@link fitOutputTokensToContextWindow} will request. */
export const MIN_FITTED_OUTPUT_TOKENS = 1024;

/** Tokenizer-error safety margin (10%) applied only to locally counted text. */
const PROMPT_ESTIMATE_MARGIN_DIVISOR = 10;

/** Chat-template framing charged per locally counted message. */
export const MESSAGE_FRAMING_TOKENS = 16;

/** Absolute headway subtracted unconditionally from remaining room. */
export const OUTPUT_FIT_HEADWAY_TOKENS = 64;

export interface OutputBudgetTokenizer {
	countTokens(fragments: string[]): number;
	countMessage(message: Message, options?: { excludeEncryptedReasoning?: boolean }): number;
}

const DEFAULT_TOKENIZER: OutputBudgetTokenizer = {
	countTokens: fragments => countTokens(fragments),
	countMessage: (message, options) => estimateTokens(message, options),
};

interface RequestUsageAnchor {
	index: number;
	tokens: number;
}

function isRequestUsageAnchor(message: Message): message is AssistantMessage {
	if (message.role !== "assistant") return false;
	if (message.stopReason === "aborted" || message.stopReason === "error") return false;
	return message.usage !== undefined && calculateContextTokens(message.usage) > 0;
}

function findRequestUsageAnchor(messages: readonly Message[]): RequestUsageAnchor | undefined {
	let rewriteAt = Number.NEGATIVE_INFINITY;
	let anchorIndex = -1;
	let anchorTokens = 0;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role === "toolResult" && message.prunedAt !== undefined) {
			rewriteAt = Math.max(rewriteAt, message.prunedAt);
		} else if (isRequestUsageAnchor(message) && message.timestamp > rewriteAt) {
			anchorIndex = index;
			anchorTokens = calculateContextTokens(message.usage);
		}
	}
	return anchorIndex >= 0 ? { index: anchorIndex, tokens: anchorTokens } : undefined;
}

function omitsDefaultOutputCap(compat: Model["compat"] | undefined): boolean {
	return (
		compat !== undefined && "isOpenRouterHost" in compat && compat.isOpenRouterHost && !compat.alwaysSendMaxTokens
	);
}

/** Claude 4.5+ on native Anthropic APIs self-truncates at the context window instead of rejecting with 400. */
function stopsOutputAtContextWindow(model: Model): boolean {
	return model.api === "anthropic-messages" && /claude-(?:sonnet|opus|haiku)-4(?:-[5-9]|$)/i.test(model.id);
}

function withMargin(localTokens: number): number {
	return localTokens + Math.ceil(localTokens / PROMPT_ESTIMATE_MARGIN_DIVISOR);
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

function toolFragments(tools: readonly Tool[]): string[] {
	const fragments: string[] = [];
	for (const tool of tools) {
		fragments.push(tool.name, tool.description, safeJsonStringify(tool.parameters));
	}
	return fragments;
}

function countFramingTokens(context: Context, tokenizer: OutputBudgetTokenizer): number {
	let tokens = 0;
	if (context.systemPrompt) {
		tokens += tokenizer.countTokens(
			Array.isArray(context.systemPrompt) ? [...context.systemPrompt] : [context.systemPrompt],
		);
	}
	if (context.tools && context.tools.length > 0) {
		tokens += tokenizer.countTokens(toolFragments(context.tools));
	}
	return tokens;
}

function countPromptTokens(context: Context, tokenizer: OutputBudgetTokenizer): number {
	const { messages } = context;
	const anchor = findRequestUsageAnchor(messages);
	if (!anchor) {
		let messageTokens = 0;
		for (const message of messages) {
			messageTokens += tokenizer.countMessage(message);
		}
		return (
			withMargin(countFramingTokens(context, tokenizer) + messageTokens) + messages.length * MESSAGE_FRAMING_TOKENS
		);
	}
	let tail = 0;
	for (let index = anchor.index + 1; index < messages.length; index++) {
		tail += tokenizer.countMessage(messages[index]!);
	}
	return anchor.tokens + withMargin(tail) + (messages.length - anchor.index - 1) * MESSAGE_FRAMING_TOKENS;
}

/**
 * Fit the requested output cap so `prompt + maxTokens` stays within `model.contextWindow`,
 * preventing Chat Completions / vLLM / DeepSeek / OpenAI 400 rejections when prompts approach
 * `contextWindow - model.maxTokens`.
 */
export function fitOutputTokensToContextWindow(
	model: Model,
	context: Context,
	maxTokens: number | undefined,
	tokenizer: OutputBudgetTokenizer = DEFAULT_TOKENIZER,
): number | undefined {
	if (maxTokens === undefined && omitsDefaultOutputCap(model.compat)) return undefined;
	const requested = maxTokens ?? model.maxTokens;
	const contextWindow = model.contextWindow;
	if (!requested || !contextWindow || contextWindow <= 0) return maxTokens;
	if (stopsOutputAtContextWindow(model)) return maxTokens;

	const room = contextWindow - countPromptTokens(context, tokenizer) - OUTPUT_FIT_HEADWAY_TOKENS;
	if (room >= requested) return maxTokens;
	return Math.max(MIN_FITTED_OUTPUT_TOKENS, room);
}

/**
 * Local prompt-token floor when `context` leaves `model` no room for
 * {@link MIN_FITTED_OUTPUT_TOKENS}, else `undefined`.
 */
export function countContextOverrun(
	context: Context,
	model: Model,
	tokenizer: OutputBudgetTokenizer = DEFAULT_TOKENIZER,
): number | undefined {
	const contextWindow = model.contextWindow;
	if (!contextWindow || contextWindow <= 0) return undefined;
	const budget = contextWindow - OUTPUT_FIT_HEADWAY_TOKENS - MIN_FITTED_OUTPUT_TOKENS;
	let tokens = countFramingTokens(context, tokenizer);
	for (const message of context.messages) {
		if (tokens > budget) break;
		tokens += tokenizer.countMessage(message, { excludeEncryptedReasoning: true });
	}
	return tokens > budget ? tokens : undefined;
}
