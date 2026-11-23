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
	/** Redirects allowed before escalating to stalled_tool_call (`0` disables redirect-count escalation; default `2`). */
	readonly maxRedirectsBeforeStop?: number;
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

export type ToolCallLoopDetection =
	| RepeatedToolCallDetection
	| CyclicalToolCallDetection
	| {
			readonly kind: "stalled_tool_call";
			readonly toolName: string;
			readonly reason?: "unchanged_output" | "error_streak" | "redirect_escalation" | "cycle_escalation";
	  };

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

const EVAL_MUTATION_RE =
	/\b(?:write_text|write_bytes|os\.remove|os\.unlink|os\.rename|os\.replace|shutil\.\w+|os\.mkdir|os\.makedirs|Bun\.write|fs\.write\w*|fs\.rm\w*|fs\.unlink\w*|git\s+(?:commit|checkout|reset|apply|merge|rebase)|sed\s+-i|perl\s+-pi)\b|\.write\s*\(|open\s*\([^)]*,\s*["'][wa+]/;
const EVAL_CMD_TOKEN_RE =
	/\b(?:git\s+(?:status|diff|log|show|branch|rev-parse)|bun\s+(?:run\s+)?(?:typecheck|test|check|lint)|pytest|tsc|cargo\s+(?:test|check|clippy)|jev(?:\s+status)?|node\s+.*?jev-harness\.mjs\s+.*status)\b/g;
const EVAL_PATH_LITERAL_RE =
	/["']((?:\.\/|\.\.\/|\/|~\/|src\/|packages\/|test\/|tests\/|crates\/|python\/)[^"'\n]{1,120})["']/g;
const EVAL_API_TOKEN_RE = /\b(?:os\.walk|glob\.glob|os\.listdir|subprocess\.(?:run|check_output|Popen)|read_text)\b/g;
const READ_PATH_RANGE_RE = /^(.*?)(?::(\d+)(?:-\d+)?)?$/;

function normalizeEvalCommandToken(token: string): string {
	const collapsed = token.replace(/\s+/g, " ").trim();
	if (collapsed.startsWith("bun run ")) return `bun ${collapsed.slice(8)}`;
	if (/^git\s+status\b/.test(collapsed)) return "git status";
	if (/jev-harness\.mjs.*status/.test(collapsed)) return "jev status";
	return collapsed;
}

function normalizeBashCommand(command: string): string {
	const stripped = command
		.replace(/\b2>&1\b/g, "")
		.replace(/\|\s*(?:head|tail|cat)\b[^|;&]*$/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (/^git\s+status\b/.test(stripped)) return "git status";
	if (/^node\s+.*?jev-harness\.mjs\s+.*status\b/.test(stripped)) return "jev status";
	if (/^bun\s+(?:run\s+)?(?:test|typecheck|check|lint)\b/.test(stripped)) {
		return stripped.replace(/^bun\s+run\s+/, "bun ");
	}
	return stripped;
}

function parseReadTarget(args: Record<string, unknown>): { basePath: string; startLine: number } | null {
	const rawPath =
		typeof args.path === "string" ? args.path.trim() : typeof args.filePath === "string" ? args.filePath.trim() : "";
	if (!rawPath) return null;
	const match = READ_PATH_RANGE_RE.exec(rawPath);
	const basePath = (match?.[1] || rawPath).trim();
	const rangeStart = match?.[2] ? Number.parseInt(match[2], 10) : undefined;
	const lineRange = typeof args.lineRange === "string" ? args.lineRange.trim() : "";
	const lineRangeMatch = lineRange ? /^(\d+)/.exec(lineRange) : null;
	const lineRangeStart = lineRangeMatch?.[1] ? Number.parseInt(lineRangeMatch[1], 10) : undefined;
	const offsetStart =
		typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.trunc(args.offset) : undefined;
	const startLine = Math.max(1, rangeStart ?? lineRangeStart ?? offsetStart ?? 1);
	return { basePath, startLine };
}

function buildEvalLookupKey(args: Record<string, unknown>, canonicalArgs: string): string {
	const lang = typeof args.language === "string" ? args.language.trim() : "";
	const code = typeof args.code === "string" ? args.code.trim() : "";
	if (!code || EVAL_MUTATION_RE.test(code)) {
		const stripped: Record<string, unknown> = { ...args };
		delete stripped.title;
		delete stripped.description;
		delete stripped.timeout;
		return `eval:${JSON.stringify(canonicalizeToolCallValue(stripped))}`;
	}

	const normalizedListCode = code.replace(/["']\s*,\s*["']/g, " ");
	const cmds = new Set<string>();
	for (const match of normalizedListCode.matchAll(EVAL_CMD_TOKEN_RE)) {
		cmds.add(normalizeEvalCommandToken(match[0]));
	}
	if (cmds.size > 0) {
		return `eval:ro:cmds:${lang}:${[...cmds].sort().join(",")}`;
	}

	const paths = new Set<string>();
	for (const match of code.matchAll(EVAL_PATH_LITERAL_RE)) {
		const cleaned = match[1]!.split(":")[0]!.trim();
		if (cleaned) paths.add(cleaned);
	}
	const apis = new Set<string>();
	for (const match of code.matchAll(EVAL_API_TOKEN_RE)) {
		apis.add(match[0].trim());
	}
	if (paths.size > 0 || apis.size > 0) {
		return `eval:ro:query:${lang}:paths=${[...paths].sort().join(",")}:apis=${[...apis].sort().join(",")}`;
	}

	const normalizedCode = code.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
	return normalizedCode ? `eval:ro:norm:${lang}:${normalizedCode}` : `eval:${canonicalArgs}`;
}

/** Detects consecutive identical or semantically repeated assistant tool calls across model turns. */
export class ToolCallLoopGuard {
	#threshold: number;
	#exemptTools: ReadonlySet<string>;
	#callStreaks = new Map<string, number>();
	#unchanged: { fingerprint: bigint; count: number } | undefined;
	#cycleWindowSize: number;
	#recentCalls: Array<{ hash: string; toolNames: string[] }> = [];
	#lastCycleSignature: string | undefined;
	#maxRedirectsBeforeStop: number;
	#redirectsIssued = 0;
	#cycleRepeatTurns = 0;

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#exemptTools = new Set(options.exemptTools);
		this.#cycleWindowSize = Math.max(3, Math.trunc(options.cycleWindowSize ?? 6));
		this.#maxRedirectsBeforeStop = Math.max(0, Math.trunc(options.maxRedirectsBeforeStop ?? 2));
	}
	reset(): void {
		this.#reset();
	}

	#reset(): void {
		this.#unchanged = undefined;
		this.#callStreaks.clear();
		this.#recentCalls = [];
		this.#lastCycleSignature = undefined;
		this.#redirectsIssued = 0;
		this.#cycleRepeatTurns = 0;
	}

	#collectRecentToolNames(): string[] {
		const toolNames: string[] = [];
		for (const call of this.#recentCalls) {
			for (const name of call.toolNames) {
				if (!toolNames.includes(name)) toolNames.push(name);
			}
		}
		return toolNames;
	}

	#isExemptToolCall(toolCall: ToolCall): boolean {
		if (!this.#exemptTools.has(toolCall.name)) return false;
		if (
			(toolCall.name === "subagent" || toolCall.name === "job") &&
			toolCall.arguments &&
			typeof toolCall.arguments === "object" &&
			(toolCall.arguments as Record<string, unknown>).action === "list"
		) {
			return false;
		}
		return true;
	}

	#computeLookupKey(toolCall: ToolCall, canonicalArgs: string, toolResults: readonly ToolResultMessage[]): string {
		const args =
			toolCall.arguments && typeof toolCall.arguments === "object" && !Array.isArray(toolCall.arguments)
				? (toolCall.arguments as Record<string, unknown>)
				: undefined;

		if (toolCall.name === "eval" && args) {
			return buildEvalLookupKey(args, canonicalArgs);
		}

		if (toolCall.name === "bash" && args && typeof args.command === "string") {
			const normalizedCmd = normalizeBashCommand(args.command);
			if (normalizedCmd) {
				return `bash:cmd:${normalizedCmd}`;
			}
		}

		if (toolCall.name === "read" && args) {
			const target = parseReadTarget(args);
			if (target) {
				// A changing selector is only progress if the read actually returns new content.
				const result = toolResults.find(candidate => candidate.toolCallId === toolCall.id);
				if (result && !result.isError && result.content.every(block => block.type === "text")) {
					const textParts = result.content.map(block => block.text);
					if (textParts.some(text => text.trim().length > 0)) {
						return `read:result:${target.basePath}:${Bun.hash(JSON.stringify(textParts))}`;
					}
				}
				return `read:page:${target.basePath}:${target.startLine}`;
			}
		}

		return `${toolCall.name}:${canonicalArgs}`;
	}

	/** Records one completed turn and returns the threshold/cycle hit, if any. */
	recordTurn(turn: ToolCallLoopTurn): ToolCallLoopDetection | null {
		const allToolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (allToolCalls.length === 0) {
			this.#reset();
			return null;
		}

		const trackedCalls = allToolCalls.filter(call => !this.#isExemptToolCall(call));
		if (trackedCalls.length === 0) {
			this.#unchanged = undefined;
			return null;
		}

		const turnEntries: Array<{
			lookupKey: string;
			toolCall: ToolCall;
			canonicalArgs: string;
		}> = [];
		const seenLookupKeys = new Set<string>();

		for (const toolCall of trackedCalls) {
			const canonicalArgs = JSON.stringify(canonicalizeToolCallValue(toolCall.arguments));
			const lookupKey = this.#computeLookupKey(toolCall, canonicalArgs, turn.toolResults);
			if (seenLookupKeys.has(lookupKey)) continue;
			seenLookupKeys.add(lookupKey);
			turnEntries.push({ lookupKey, toolCall, canonicalArgs });
		}

		const nextStreaks = new Map<string, number>();
		let hitEntry: { toolCall: ToolCall; canonicalArgs: string; count: number } | undefined;

		for (const entry of turnEntries) {
			const count = (this.#callStreaks.get(entry.lookupKey) ?? 0) + 1;
			nextStreaks.set(entry.lookupKey, count);
			if (count === this.#threshold && !hitEntry) {
				hitEntry = { toolCall: entry.toolCall, canonicalArgs: entry.canonicalArgs, count };
			}
		}

		this.#callStreaks = nextStreaks;

		// The redirect uses a broad semantic match. Pausing needs stronger evidence:
		// all calls in the batch produce the same text results, after a redirect was sent.
		const hasStreakPastThreshold = turnEntries.some(
			entry => (nextStreaks.get(entry.lookupKey) ?? 0) > this.#threshold,
		);

		const callResultPairs: Array<{ call: ToolCall; result: ToolResultMessage }> = [];
		let allCallsHaveMatchingTextResult = turnEntries.length > 0 && hasStreakPastThreshold;

		if (allCallsHaveMatchingTextResult) {
			for (const call of allToolCalls) {
				const result = turn.toolResults.find(candidate => candidate.toolCallId === call.id);
				if (!result || result.content.length === 0 || !result.content.every(part => part.type === "text")) {
					allCallsHaveMatchingTextResult = false;
					break;
				}
				callResultPairs.push({ call, result });
			}
		}

		if (allCallsHaveMatchingTextResult) {
			const serializedTuples: string[] = [];
			for (const { call, result } of callResultPairs) {
				const canonicalArgs = JSON.stringify(canonicalizeToolCallValue(call.arguments));
				const normalizedContent = result.isError
					? result.content.map(part =>
							part.type === "text" ? { type: part.type, text: normalizeVolatileErrorText(part.text) } : part,
						)
					: result.content;
				serializedTuples.push(JSON.stringify([call.name, canonicalArgs, result.isError, normalizedContent]));
			}
			serializedTuples.sort();
			const fingerprint = Bun.hash(JSON.stringify(serializedTuples));
			const count = this.#unchanged?.fingerprint === fingerprint ? this.#unchanged.count + 1 : 1;
			this.#unchanged = { fingerprint, count };

			let maxStreak = 0;
			for (const entry of turnEntries) {
				const streak = nextStreaks.get(entry.lookupKey) ?? 0;
				if (streak > maxStreak) maxStreak = streak;
			}
			const anyError = callResultPairs.some(pair => pair.result.isError);
			const pauseAfter = Math.max(2, this.#threshold);

			if (count >= pauseAfter || (anyError && maxStreak >= this.#threshold + pauseAfter)) {
				this.#reset();
				const distinctNames: string[] = [];
				for (const entry of turnEntries) {
					if (!distinctNames.includes(entry.toolCall.name)) {
						distinctNames.push(entry.toolCall.name);
					}
				}
				const batchToolLabel = allToolCalls.length === 1 ? turnEntries[0]!.toolCall.name : distinctNames.join(", ");
				const reason = anyError && count < pauseAfter ? "error_streak" : "unchanged_output";
				return { kind: "stalled_tool_call", toolName: batchToolLabel, reason };
			}
		} else {
			this.#unchanged = undefined;
		}

		if (hitEntry) {
			this.#redirectsIssued++;
			if (this.#maxRedirectsBeforeStop > 0 && this.#redirectsIssued > this.#maxRedirectsBeforeStop) {
				const toolName = hitEntry.toolCall.name;
				this.#reset();
				return { kind: "stalled_tool_call", toolName, reason: "redirect_escalation" };
			}
			return {
				kind: "repeated_tool_call",
				toolName: hitEntry.toolCall.name,
				count: hitEntry.count,
				resultSummary: summarizeToolResult(turn.toolResults, hitEntry.toolCall.id),
				argumentsSummary: summarizeText(hitEntry.canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
			};
		}

		// Alternating 2-step (A,B,A,B,…) or 3-step (A,B,C,A,B,C,…) pattern.
		const turnHash = turnEntries
			.map(entry => entry.lookupKey)
			.sort()
			.join("\u001f");
		const turnToolNames: string[] = [];
		for (const entry of turnEntries) {
			if (!turnToolNames.includes(entry.toolCall.name)) {
				turnToolNames.push(entry.toolCall.name);
			}
		}

		this.#recentCalls.push({ hash: turnHash, toolNames: turnToolNames });
		if (this.#recentCalls.length > this.#cycleWindowSize) this.#recentCalls.shift();
		if (this.#recentCalls.length < this.#cycleWindowSize) return null;

		const distinctHashes = new Set(this.#recentCalls.map(call => call.hash));
		let cyclePeriod: 2 | 3 | undefined;
		if (distinctHashes.size === 2) {
			cyclePeriod = 2;
		} else if (
			distinctHashes.size === 3 &&
			this.#recentCalls.length >= 6 &&
			this.#recentCalls.every((call, i) => call.hash === this.#recentCalls[i % 3]!.hash)
		) {
			cyclePeriod = 3;
		}

		if (!cyclePeriod) {
			this.#lastCycleSignature = undefined;
			this.#cycleRepeatTurns = 0;
			return null;
		}

		const signature = [...distinctHashes].sort().join("|");
		if (signature === this.#lastCycleSignature) {
			this.#cycleRepeatTurns++;
			if (this.#cycleRepeatTurns === 1) {
				return null;
			}
			if (this.#cycleRepeatTurns % cyclePeriod === 0) {
				const repeatedCycles = Math.floor(this.#cycleRepeatTurns / cyclePeriod);
				if (this.#maxRedirectsBeforeStop > 0 && repeatedCycles > this.#maxRedirectsBeforeStop) {
					const toolNames = this.#collectRecentToolNames();
					this.#reset();
					return {
						kind: "stalled_tool_call",
						toolName: toolNames.join(", "),
						reason: "cycle_escalation",
					};
				}
			}
			return null;
		}

		this.#lastCycleSignature = signature;
		this.#cycleRepeatTurns = 0;
		this.#redirectsIssued++;

		const toolNames = this.#collectRecentToolNames();
		if (this.#maxRedirectsBeforeStop > 0 && this.#redirectsIssued > this.#maxRedirectsBeforeStop) {
			this.#reset();
			return {
				kind: "stalled_tool_call",
				toolName: toolNames.join(", "),
				reason: "redirect_escalation",
			};
		}

		return { kind: "cyclical_tool_calls", toolNames, windowSize: this.#cycleWindowSize };
	}
}

function normalizeVolatileErrorText(text: string): string {
	return text
		.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<ts>")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
		.replace(/\b(request[_-]?id|trace[_-]?id|correlation[_-]?id|x-request-id)\s*[:=]\s*[^\s,;}"']+/gi, "$1=<id>")
		.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, "<dur>");
}
