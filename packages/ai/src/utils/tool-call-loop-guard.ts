import { INTENT_FIELD } from "jeopi-wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
	/** Window size for alternating-pattern (A,B,A,B,…) cycle detection; defaults to 6. */
	readonly cycleWindowSize?: number;
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

/** Details needed to steer the model away from a repeated tool call. */
export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call";
	readonly toolName: string;
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

/** Details needed to steer the model away from an alternating tool-call cycle (A,B,A,B,…). */
export interface CyclicalToolCallDetection {
	readonly kind: "cyclical_tool_calls";
	/** Distinct tool names seen in the detection window, in first-seen order. */
	readonly toolNames: readonly string[];
	readonly windowSize: number;
}

export type ToolCallLoopDetection = RepeatedToolCallDetection | CyclicalToolCallDetection;

function canonicalizeToolCallValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeToolCallValue(item));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		output[key] = canonicalizeToolCallValue(input[key]);
	}
	return output;
}

function summarizeText(text: string, limit: number): string {
	let summary = text.replace(/\s+/g, " ").trim();
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return summarizeText(textParts.join("\n"), RESULT_SUMMARY_LIMIT);
}

/** Detects consecutive identical assistant tool calls across model turns. */
export class ToolCallLoopGuard {
	#threshold: number;
	#exemptTools: ReadonlySet<string>;
	#lastHash: string | undefined;
	#count = 0;
	#cycleWindowSize: number;
	#recentCalls: Array<{ hash: string; toolName: string }> = [];
	#lastCycleSignature: string | undefined;

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#exemptTools = new Set(options.exemptTools);
		this.#cycleWindowSize = Math.max(3, Math.trunc(options.cycleWindowSize ?? 6));
	}

	/** Records one completed turn and returns the threshold/cycle hit, if any. */
	recordTurn(turn: ToolCallLoopTurn): ToolCallLoopDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length !== 1 || this.#exemptTools.has(toolCalls[0]!.name)) {
			this.#lastHash = undefined;
			this.#count = 0;
			this.#recentCalls = [];
			this.#lastCycleSignature = undefined;
			return null;
		}

		const toolCall = toolCalls[0]!;
		const canonicalArgs = JSON.stringify(canonicalizeToolCallValue(toolCall.arguments));
		const hash = `${toolCall.name}:${canonicalArgs}`;
		if (hash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = hash;
			this.#count = 1;
		}

		if (this.#count === this.#threshold) {
			return {
				kind: "repeated_tool_call",
				toolName: toolCall.name,
				count: this.#count,
				resultSummary: summarizeToolResult(turn.toolResults, toolCall.id),
				argumentsSummary: summarizeText(canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
			};
		}

		// Alternating A,B,A,B,… pattern: exact-repeat detection above never fires
		// (the hash changes every turn), but the model is still spinning between
		// exactly two distinct calls without making progress.
		this.#recentCalls.push({ hash, toolName: toolCall.name });
		if (this.#recentCalls.length > this.#cycleWindowSize) this.#recentCalls.shift();
		if (this.#recentCalls.length < this.#cycleWindowSize) return null;

		const distinctHashes = new Set(this.#recentCalls.map(call => call.hash));
		if (distinctHashes.size !== 2) {
			this.#lastCycleSignature = undefined;
			return null;
		}
		const signature = [...distinctHashes].sort().join("|");
		if (signature === this.#lastCycleSignature) return null;
		this.#lastCycleSignature = signature;

		const toolNames: string[] = [];
		for (const call of this.#recentCalls) {
			if (!toolNames.includes(call.toolName)) toolNames.push(call.toolName);
		}
		return { kind: "cyclical_tool_calls", toolNames, windowSize: this.#cycleWindowSize };
	}
}
