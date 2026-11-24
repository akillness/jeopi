import type { AgentMessage } from "./types";

/**
 * Safety ceiling when the caller did not specify a fixed step cap (dynamic
 * step budget). Mirrors jeo-code's `DYNAMIC_HARD_CAP`: generous enough for
 * multi-file refactors while bounding runaway loops even when they keep
 * inventing novel targets.
 */
export const DYNAMIC_HARD_CAP = 600;

/** Default number of consecutive failing non-trivial tool batches before stopping. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

/** Default number of non-user outer-loop continuation cycles per run before stopping. */
export const DEFAULT_MAX_OUTER_CYCLES = 24;

export interface StepBudgetConfig {
	/** Initial step limit before any extension is needed. */
	baseSteps: number;
	/** Number of extra steps granted per progress-scored extension. */
	extensionSteps: number;
	/** Maximum number of extensions allowed (`Infinity` in dynamic mode). */
	maxExtensions: number;
	/** Absolute step ceiling regardless of extensions or steering. */
	hardCap: number;
	/** Sliding window size (in tool calls) evaluated for extension decisions. */
	windowSize: number;
	/** Minimum fraction of successful tool calls in the window (0..1). */
	minProgressRatio: number;
	/** Minimum number of distinct tool-call signatures in the window. */
	minDistinct: number;
}

export interface ExtensionDecision {
	extend: boolean;
	reason: string;
	newLimit: number;
	extensionsUsed: number;
	progress: { ok: number; total: number; distinct: number; novel: number };
}

export type WorkflowGuardStopClass =
	| "step_budget_stalled"
	| "step_hard_cap"
	| "consecutive_failure"
	| "outer_cycle_cap"
	| "stall_timeout"
	| "token_budget_exceeded"
	| "cost_budget_exceeded";

export interface WorkflowGuardTokenMetrics {
	input: number;
	output: number;
	nonCachedInput: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface WorkflowGuardStop {
	stopClass: WorkflowGuardStopClass;
	reason: string;
	step: number;
	limit: number;
	consecutiveFailures: number;
	outerCycles: number;
	tokensSpent?: WorkflowGuardTokenMetrics;
	costUsd?: number;
	repeatCalls?: number;
}

export interface WorkflowGuardSoftWarning {
	kind: "cost" | "output_tokens";
	ratio: number;
	spent: number;
	limit: number;
	message: string;
}

export interface WorkflowLoopGuardConfig {
	/** Explicit fixed step cap (overrides dynamic baseSteps/hardCap). `0` or omitted uses dynamic mode. */
	maxSteps?: number;
	/** Fine-grained overrides for the progress-scored StepBudget. */
	stepBudget?: Partial<StepBudgetConfig>;
	/** Consecutive non-trivial failing tool batches before hard stop (default 5, `0` disables). */
	maxConsecutiveFailures?: number;
	/** Maximum non-user outer-loop continuation cycles per run (default 24, `0` disables). */
	maxOuterCycles?: number;
	/** No-progress wall-clock stall timeout in milliseconds (`0` disables; reset on tool execution or user steer). */
	stallTimeoutMs?: number;
	/** Optional per-run USD cost cap (`0` or omitted disables). */
	maxCostUsd?: number;
	/** Optional per-run output token cap (`0` or omitted disables). */
	maxOutputTokens?: number;
	/**
	 * Optional dynamic resolver for the per-run output token cap (e.g. tracking
	 * the active model's configured `contextWindow` across mid-run model switches).
	 * Returning a positive finite number enforces that cap; returning `0` or a
	 * negative finite number disables the cap; non-finite values fall back to
	 * static `maxOutputTokens`.
	 */
	getMaxOutputTokens?: () => number;
	/** Fraction (0..1) of cost/token cap at which a one-shot wrap-up warning fires (default 0.8; `0` disables). */
	softBudgetWarningRatio?: number;
	/** Optional callback supplying external/cumulative output tokens (e.g. including subagents). */
	getExternalOutputTokens?: () => number;
	/** Optional environment lookup override (defaults to `Bun.env`). */
	env?: Record<string, string | undefined>;
}

/**
 * Tools whose reads/queries do not mutate workspace state. Used for jeo-code's
 * non-trivial failure accounting: a read succeeding alongside a failing write/edit/bash
 * call in the same batch must not mask the failure or reset `consecutiveFailures`.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"find",
	"grep",
	"glob",
	"search",
	"ls",
	"lsp",
	"ast_grep",
	"todo_read",
	"web_search",
	"fetch",
	"jeox",
	"status",
	"search_tool_bm25",
]);

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Rolling progress-scored budget config for dynamic runs (no explicit fixed `maxSteps`).
 * Starts at `baseSteps = 24` and extends in increments of `12` up to `DYNAMIC_HARD_CAP = 600`
 * as long as the recent tool window demonstrates real progress and novel targets.
 */
export function dynamicStepBudgetConfig(
	env: Record<string, string | undefined> = Bun.env,
	overrides?: Partial<StepBudgetConfig>,
): StepBudgetConfig {
	const base = parsePositiveInt(env.JEOPI_STEP_BASE, 24);
	const extSize = parsePositiveInt(env.JEOPI_STEP_EXTENSION_SIZE, 12);
	const hardCap = Math.max(base, parsePositiveInt(env.JEOPI_STEP_HARD_CAP, DYNAMIC_HARD_CAP));
	const windowSize = parsePositiveInt(env.JEOPI_STEP_WINDOW, 8);
	return {
		baseSteps: overrides?.baseSteps ?? base,
		extensionSteps: overrides?.extensionSteps ?? extSize,
		maxExtensions: overrides?.maxExtensions ?? Number.POSITIVE_INFINITY,
		hardCap: overrides?.hardCap ?? hardCap,
		windowSize: overrides?.windowSize ?? windowSize,
		minProgressRatio: overrides?.minProgressRatio ?? 0.5,
		minDistinct: overrides?.minDistinct ?? 2,
	};
}

/**
 * Resolve a StepBudgetConfig from an optional explicit `maxSteps` cap and env vars.
 * - `maxSteps <= 0` or `undefined`: dynamic rolling mode (`base 24`, extends `+12`, `hardCap 600`).
 * - `maxSteps > 0`: fixed-base mode (`base = maxSteps`, optional env/override extensions up to `hardCap`).
 */
export function resolveStepBudgetConfig(
	maxSteps?: number,
	env: Record<string, string | undefined> = Bun.env,
	overrides?: Partial<StepBudgetConfig>,
): StepBudgetConfig {
	if (maxSteps === undefined || !Number.isFinite(maxSteps) || maxSteps <= 0) {
		return dynamicStepBudgetConfig(env, overrides);
	}
	const base = Math.max(1, Math.floor(maxSteps));
	const maxExt = parseNonNegativeInt(env.JEOPI_STEP_EXTENSIONS, 0);
	const extSize = parsePositiveInt(env.JEOPI_STEP_EXTENSION_SIZE, 12);
	const computedHardCap = Math.max(base, base + maxExt * extSize);
	const hardCap = Math.max(base, parsePositiveInt(env.JEOPI_STEP_HARD_CAP, computedHardCap));
	const windowSize = parsePositiveInt(env.JEOPI_STEP_WINDOW, 8);
	return {
		baseSteps: overrides?.baseSteps ?? base,
		extensionSteps: overrides?.extensionSteps ?? extSize,
		maxExtensions: overrides?.maxExtensions ?? maxExt,
		hardCap: overrides?.hardCap ?? hardCap,
		windowSize: overrides?.windowSize ?? windowSize,
		minProgressRatio: overrides?.minProgressRatio ?? 0.5,
		minDistinct: overrides?.minDistinct ?? 2,
	};
}

/**
 * Fixed-size 64-bit FNV-1a hash encoded in base-36 (~13 chars).
 * Keeps tool-call history tracking memory-bounded O(steps) regardless of payload size.
 */
export function hashSignature(value: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x050c5d1f;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
	}
	return `${h1.toString(36)}_${h2.toString(36)}`;
}

function stableSerialize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "undefined";
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => stableSerialize(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map(k => `${JSON.stringify(k)}:${stableSerialize(record[k])}`).join(",")}}`;
}

/**
 * Extract a coarse target key for a tool invocation so micro-edits to the same file
 * or repeated variants of the same command cannot farm infinite step extensions.
 */
export function toolTarget(tool: string, rawArgs: unknown): string {
	if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return tool;
	const args = rawArgs as Record<string, unknown>;
	const firstStr = (keys: readonly string[]): string | undefined => {
		for (const key of keys) {
			const value = args[key];
			if (typeof value === "string" && value.trim().length > 0) return value.trim();
		}
		return undefined;
	};
	switch (tool) {
		case "read":
		case "write":
		case "edit":
		case "hashline_edit":
		case "patch": {
			const filePath = firstStr(["path", "filePath", "file_path", "target"]);
			if (filePath) return `${tool}:${filePath}`;
			break;
		}
		case "bash":
		case "shell": {
			const cmd = firstStr(["command", "cmd"]);
			if (cmd) return `${tool}:${cmd.replace(/\s+/g, " ").slice(0, 64)}`;
			break;
		}
		case "glob": {
			const firstPath = Array.isArray(args.paths)
				? args.paths.find((p): p is string => typeof p === "string" && p.trim().length > 0)?.trim()
				: undefined;
			const target = firstPath ?? firstStr(["pattern", "glob", "globPattern", "path", "dirPath"]);
			if (target) return `${tool}:${target.slice(0, 64)}`;
			break;
		}
		case "ast_grep": {
			const pat = firstStr(["pat", "pattern", "query"]);
			const firstPath =
				(Array.isArray(args.paths)
					? args.paths.find((p): p is string => typeof p === "string" && p.trim().length > 0)?.trim()
					: undefined) ?? firstStr(["path", "dirPath"]);
			if (pat && firstPath) return `${tool}:${pat.slice(0, 40)}@${firstPath.slice(0, 23)}`;
			if (pat) return `${tool}:${pat.slice(0, 64)}`;
			if (firstPath) return `${tool}:${firstPath.slice(0, 64)}`;
			break;
		}
		case "find":
		case "grep":
		case "search":
		case "search_tool_bm25": {
			const query = firstStr(["pattern", "query", "glob", "globPattern", "path", "dirPath"]);
			if (query) return `${tool}:${query.slice(0, 64)}`;
			break;
		}
		case "jeox": {
			const action = firstStr(["action"]);
			const subject = firstStr(["name", "query", "target"]);
			if (action && subject) return `${tool}:${action}:${subject.slice(0, 64)}`;
			if (subject) return `${tool}:${subject.slice(0, 64)}`;
			if (action) return `${tool}:${action}`;
			break;
		}
		case "fetch":
		case "web_search": {
			const target = firstStr(["url", "query"]);
			if (target) return `${tool}:${target.slice(0, 64)}`;
			break;
		}
		case "eval": {
			const lang = firstStr(["language", "lang"]) ?? "unknown";
			const code = firstStr(["code", "script", "source"]) ?? "";
			const title = firstStr(["title"]);
			if (isMutatingEvalArgs(args, code)) {
				const tag = title ? title.slice(0, 48) : hashSignature(code.replace(/\s+/g, " ").trim());
				return `eval:exec:${lang}:${tag}`;
			}
			const cmdMatches = extractEvalReadCommands(code);
			if (cmdMatches.length > 0) {
				return `eval:read:${lang}:cmds:${cmdMatches.join(",")}`;
			}
			const paths = extractEvalPaths(code);
			const apis = extractEvalReadApis(code);
			if (paths.length > 0 || apis.length > 0) {
				return `eval:read:${lang}:paths=${paths.join(",")}:apis=${apis.join(",")}`;
			}
			return `eval:read:${lang}:${hashSignature(code.replace(/\d+/g, "#").replace(/\s+/g, " ").trim())}`;
		}
		case "task": {
			const label = firstStr(["agent", "role", "description", "task"]);
			if (label) return `${tool}:${label.slice(0, 64)}`;
			break;
		}
		default: {
			const generic = firstStr(["path", "filePath", "file_path", "url", "command", "query", "action", "name", "id"]);
			if (generic) return `${tool}:${generic.slice(0, 64)}`;
			break;
		}
	}
	return tool;
}

const MUTATING_EVAL_RE =
	/\b(?:write_text|write_bytes|os\.remove|os\.unlink|os\.rename|os\.replace|shutil\.\w+|os\.mkdir|os\.makedirs|Bun\.write|fs\.write\w*|fs\.rm\w*|fs\.unlink\w*|git\s+(?:commit|checkout|reset|apply|merge|rebase)|sed\s+-i|perl\s+-pi|write)\b|\.write\s*\(|open\s*\([^)]*,\s*["'][wa+]|tool\.(?:edit|write|ast_edit)/;

const MUTATING_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "hashline_edit", "patch", "ast_edit"]);

const MUTATING_BASH_RE =
	/\b(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|tee|sed\s+-i|perl\s+-pi|git\s+(?:add|commit|checkout|reset|apply|merge|rebase|cherry-pick|stash|rm|mv)|npm\s+install|bun\s+(?:add|remove|install))\b|(?:^|[^>&])>{1,2}(?!&)/;

function isMutatingEvalArgs(args: Record<string, unknown>, code: string): boolean {
	if (args.reset === true) return true;
	return MUTATING_EVAL_RE.test(code);
}

function isMutatingToolCall(tool: string, rawArgs: unknown): boolean {
	if (MUTATING_TOOLS.has(tool)) return true;
	const args =
		rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
	if (tool === "eval") {
		const code =
			typeof args.code === "string"
				? args.code
				: typeof args.script === "string"
					? args.script
					: typeof args.source === "string"
						? args.source
						: "";
		return isMutatingEvalArgs(args, code);
	}
	if (tool === "bash" || tool === "shell") {
		const cmd = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
		return MUTATING_BASH_RE.test(cmd);
	}
	return false;
}

function extractEvalReadCommands(code: string): string[] {
	const found = new Set<string>();
	const matches = code.matchAll(
		/\b(?:git(?:\s+|["'],\s*["'])(?:status|diff|log|show|branch)|bun(?:\s+|["'],\s*["'])(?:test|check|typecheck|lint)|pytest|cargo(?:\s+|["'],\s*["'])(?:test|check))\b/g,
	);
	for (const match of matches) {
		found.add(match[0].replace(/(?:\s+|["'],\s*["'])/g, " "));
	}
	return [...found].sort();
}

function extractEvalPaths(code: string): string[] {
	const found = new Set<string>();
	const matches = code.matchAll(
		/(?:^|[\s"'`(,=])((?:\.\.?\/|\/|~\/|(?:src|packages|test|tests|crates)\/)[^\s"'`),;]+)/g,
	);
	for (const match of matches) {
		const cleaned = match[1].replace(/:\d+(?:-\d+)?$/, "");
		if (cleaned.length > 0) found.add(cleaned);
	}
	return [...found].sort().slice(0, 8);
}

function extractEvalReadApis(code: string): string[] {
	const found = new Set<string>();
	const matches = code.matchAll(
		/\b(?:os\.walk|glob\.glob|os\.listdir|read_text|tool\.read|tool\.grep)\b|\bread\s*\(/g,
	);
	for (const match of matches) {
		found.add(match[0].replace(/\s+/g, ""));
	}
	return [...found].sort();
}

function extractResultText(content: ReadonlyArray<{ type: string; text?: string }> | undefined): string {
	if (!content || content.length === 0) return "";
	let out = "";
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			out += part.text;
		}
	}
	return out;
}

function normalizeEvalResultForHash(text: string): string {
	return text
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
		.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<ts>")
		.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|us|µs|ns)\b/g, "<dur>")
		.replace(/\s+/g, " ")
		.trim();
}

function isSkippedResult(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): boolean {
	const text = extractResultText(result.content).trimStart();
	return text.startsWith("Skipped due to") || text.startsWith("Not executed:");
}

interface StepOutcome {
	sig: string;
	ok: boolean;
	novel: boolean;
}

/**
 * Progress-scored rolling step budget ported from jeo-code.
 * Extends past `baseSteps` only while recent tool calls show real success ratio,
 * signature diversity, and at least one novel coarse target in the recent sliding window.
 */
export class StepBudget {
	#cfg: StepBudgetConfig;
	#currentLimit: number;
	#extensionsUsed = 0;
	#window: StepOutcome[] = [];
	#seenTargets = new Set<string>();

	constructor(cfg: StepBudgetConfig) {
		this.#cfg = cfg;
		this.#currentLimit = cfg.baseSteps;
	}

	limit(): number {
		return this.#currentLimit;
	}

	hardCap(): number {
		return this.#cfg.hardCap;
	}

	extensionsUsed(): number {
		return this.#extensionsUsed;
	}

	config(): StepBudgetConfig {
		return this.#cfg;
	}

	record(signature: string, ok: boolean, targetKey?: string, options?: { novel?: boolean }): void {
		const sigHash = hashSignature(signature);
		const targetHash = hashSignature(targetKey ?? signature);
		const isNovel = (options?.novel ?? true) && !this.#seenTargets.has(targetHash);
		this.#seenTargets.add(targetHash);
		this.#window.push({ sig: sigHash, ok, novel: isNovel });
		if (this.#window.length > this.#cfg.windowSize) {
			this.#window.shift();
		}
	}

	progress(): { ok: number; total: number; distinct: number; novel: number } {
		const total = this.#window.length;
		let ok = 0;
		let novel = 0;
		const distinct = new Set<string>();
		for (const outcome of this.#window) {
			if (outcome.ok) ok++;
			if (outcome.novel) novel++;
			distinct.add(outcome.sig);
		}
		return { ok, total, distinct: distinct.size, novel };
	}

	/**
	 * Genuine user steering changes direction mid-run: reset the progress window
	 * and grant fresh headroom up to `hardCap`.
	 */
	noteSteer(extraSteps = this.#cfg.extensionSteps): void {
		this.#window = [];
		const headroom = Math.max(1, extraSteps);
		this.#currentLimit = Math.min(this.#currentLimit + headroom, this.#cfg.hardCap);
	}

	tryExtend(): ExtensionDecision {
		const prog = this.progress();
		if (this.#extensionsUsed >= this.#cfg.maxExtensions) {
			return {
				extend: false,
				reason: `extension budget exhausted (${this.#extensionsUsed}/${this.#cfg.maxExtensions})`,
				newLimit: this.#currentLimit,
				extensionsUsed: this.#extensionsUsed,
				progress: prog,
			};
		}
		if (this.#currentLimit >= this.#cfg.hardCap) {
			return {
				extend: false,
				reason: `hard step cap reached (${this.#cfg.hardCap})`,
				newLimit: this.#currentLimit,
				extensionsUsed: this.#extensionsUsed,
				progress: prog,
			};
		}
		if (prog.total < 2) {
			return {
				extend: false,
				reason: "not enough recent tool activity to justify extending the step budget",
				newLimit: this.#currentLimit,
				extensionsUsed: this.#extensionsUsed,
				progress: prog,
			};
		}
		const ratio = prog.ok / prog.total;
		if (ratio < this.#cfg.minProgressRatio) {
			return {
				extend: false,
				reason: `low recent success rate (${prog.ok}/${prog.total} < ${Math.round(this.#cfg.minProgressRatio * 100)}%)`,
				newLimit: this.#currentLimit,
				extensionsUsed: this.#extensionsUsed,
				progress: prog,
			};
		}
		if (prog.distinct < this.#cfg.minDistinct) {
			return {
				extend: false,
				reason: `repetitive recent tool calls (${prog.distinct} distinct in last ${prog.total})`,
				newLimit: this.#currentLimit,
				extensionsUsed: this.#extensionsUsed,
				progress: prog,
			};
		}
		if (prog.novel < 1) {
			return {
				extend: false,
				reason: "no novel tool targets in recent window",
				newLimit: this.#currentLimit,
				extensionsUsed: this.#extensionsUsed,
				progress: prog,
			};
		}

		this.#extensionsUsed++;
		for (const outcome of this.#window) {
			outcome.novel = false;
		}
		this.#currentLimit = Math.min(this.#currentLimit + this.#cfg.extensionSteps, this.#cfg.hardCap);
		return {
			extend: true,
			reason: `progressing (${prog.ok}/${prog.total} ok, ${prog.distinct} distinct, ${prog.novel} novel) -> limit ${this.#currentLimit}`,
			newLimit: this.#currentLimit,
			extensionsUsed: this.#extensionsUsed,
			progress: prog,
		};
	}
}

/**
 * True only for genuinely user-authored messages (not synthetic agent reminders,
 * auto-continue developer prompts, advisor cards, or hidden system notices).
 */
export function isGenuineUserMessage(message: AgentMessage): boolean {
	if (message.role === "user") {
		const record = message as { synthetic?: boolean; attribution?: string };
		return record.synthetic !== true && record.attribution !== "agent";
	}
	if (message.role === "custom") {
		const record = message as { attribution?: string; display?: boolean };
		return record.attribution === "user" && record.display !== false;
	}
	return false;
}

/**
 * Structural workflow loop guard modeled after jeo-code's engine loop invariants:
 * - Progress-scored rolling StepBudget (base 24 -> extends +12 -> hard cap 600)
 * - Consecutive non-trivial tool failure circuit breaker (default 5)
 * - Non-user outer-loop continuation cap (default 24)
 * - Optional no-progress wall-clock stall timeout
 */
export class WorkflowLoopGuard {
	#budget: StepBudget;
	#step = 0;
	#consecutiveFailures = 0;
	#outerCycles = 0;
	#maxConsecutiveFailures: number;
	#maxOuterCycles: number;
	#stallTimeoutMs: number;
	#maxCostUsd: number;
	#maxOutputTokens: number;
	#getMaxOutputTokens?: () => number;
	#softBudgetWarningRatio: number;
	#getExternalOutputTokens?: () => number;
	#tokens: WorkflowGuardTokenMetrics = {
		input: 0,
		output: 0,
		nonCachedInput: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	};
	#costUsd = 0;
	#costSoftWarningEmitted = false;
	#tokenSoftWarningEmitted = false;
	#mutationEpoch = 0;
	#lastEvalOutcomeByLang = new Map<string, { epoch: number; resultHash: string }>();
	#seenSignatures = new Set<string>();
	#repeatCalls = 0;

	constructor(config?: WorkflowLoopGuardConfig) {
		const env = config?.env ?? Bun.env;
		this.#budget = new StepBudget(resolveStepBudgetConfig(config?.maxSteps, env, config?.stepBudget));
		this.#maxConsecutiveFailures =
			config?.maxConsecutiveFailures !== undefined
				? Math.max(0, Math.floor(config.maxConsecutiveFailures))
				: DEFAULT_MAX_CONSECUTIVE_FAILURES;
		this.#maxOuterCycles =
			config?.maxOuterCycles !== undefined
				? Math.max(0, Math.floor(config.maxOuterCycles))
				: DEFAULT_MAX_OUTER_CYCLES;
		this.#stallTimeoutMs =
			config?.stallTimeoutMs !== undefined && Number.isFinite(config.stallTimeoutMs) && config.stallTimeoutMs > 0
				? Math.floor(config.stallTimeoutMs)
				: 0;
		this.#maxCostUsd =
			config?.maxCostUsd !== undefined && Number.isFinite(config.maxCostUsd) && config.maxCostUsd > 0
				? config.maxCostUsd
				: 0;
		this.#maxOutputTokens =
			config?.maxOutputTokens !== undefined && Number.isFinite(config.maxOutputTokens) && config.maxOutputTokens > 0
				? Math.floor(config.maxOutputTokens)
				: 0;
		this.#getMaxOutputTokens = config?.getMaxOutputTokens;
		const softRatio = config?.softBudgetWarningRatio;
		this.#softBudgetWarningRatio =
			softRatio === 0
				? 0
				: softRatio !== undefined && Number.isFinite(softRatio) && softRatio > 0 && softRatio < 1
					? softRatio
					: 0.8;
		this.#getExternalOutputTokens = config?.getExternalOutputTokens;
	}

	get step(): number {
		return this.#step;
	}

	get limit(): number {
		return this.#budget.limit();
	}

	get consecutiveFailures(): number {
		return this.#consecutiveFailures;
	}

	get outerCycles(): number {
		return this.#outerCycles;
	}

	get stallTimeoutMs(): number {
		return this.#stallTimeoutMs;
	}

	get costUsd(): number {
		return this.#costUsd;
	}

	get tokensSpent(): WorkflowGuardTokenMetrics {
		return { ...this.#tokens };
	}

	get repeatCalls(): number {
		return this.#repeatCalls;
	}

	#makeStop(stopClass: WorkflowGuardStopClass, reason: string, stepOverride?: number): WorkflowGuardStop {
		return {
			stopClass,
			reason,
			step: stepOverride ?? this.#step,
			limit: this.#budget.limit(),
			consecutiveFailures: this.#consecutiveFailures,
			outerCycles: this.#outerCycles,
			tokensSpent: { ...this.#tokens },
			costUsd: this.#costUsd,
			repeatCalls: this.#repeatCalls,
		};
	}

	/**
	 * Gate before each LLM turn. Checks configured cost and output-token budgets
	 * pre-flight (including external token trackers) before incrementing the step
	 * counter and consulting the rolling StepBudget.
	 */
	beforeModelCall(): WorkflowGuardStop | undefined {
		const budgetStop = this.#checkBudgetStop(this.#step);
		if (budgetStop) {
			return budgetStop;
		}
		this.#step++;
		if (this.#step <= this.#budget.limit()) {
			return undefined;
		}
		const decision = this.#budget.tryExtend();
		if (decision.extend) {
			return undefined;
		}
		const isHardCap = this.#budget.limit() >= this.#budget.hardCap();
		return this.#makeStop(
			isHardCap ? "step_hard_cap" : "step_budget_stalled",
			`Stopped after ${this.#step - 1} steps (limit ${this.#budget.limit()}): ${decision.reason}.`,
			this.#step - 1,
		);
	}

	#effectiveMaxOutputTokens(): number {
		if (this.#getMaxOutputTokens) {
			const dynamicLimit = this.#getMaxOutputTokens();
			if (typeof dynamicLimit === "number" && Number.isFinite(dynamicLimit)) {
				return dynamicLimit > 0 ? Math.floor(dynamicLimit) : 0;
			}
		}
		return this.#maxOutputTokens;
	}

	#effectiveOutputTokens(): number {
		const externalOutput = this.#getExternalOutputTokens?.() ?? 0;
		return Math.max(this.#tokens.output, Number.isFinite(externalOutput) && externalOutput > 0 ? externalOutput : 0);
	}

	#checkBudgetStop(stepOverride?: number): WorkflowGuardStop | undefined {
		if (this.#maxCostUsd > 0 && this.#costUsd >= this.#maxCostUsd) {
			return this.#makeStop(
				"cost_budget_exceeded",
				`Stopped: per-run cost budget exceeded ($${this.#costUsd.toFixed(4)} >= $${this.#maxCostUsd.toFixed(4)}).`,
				stepOverride,
			);
		}
		const effectiveOutput = this.#effectiveOutputTokens();
		const maxOutputTokens = this.#effectiveMaxOutputTokens();
		if (maxOutputTokens > 0 && effectiveOutput >= maxOutputTokens) {
			return this.#makeStop(
				"token_budget_exceeded",
				`Stopped: per-run output token budget exceeded (${effectiveOutput.toLocaleString()} >= ${maxOutputTokens.toLocaleString()} tokens).`,
				stepOverride,
			);
		}
		return undefined;
	}

	/**
	 * Record an assistant turn's token and USD cost usage, returning a hard stop
	 * or one-shot soft warning when configured per-run budgets are approached/exceeded.
	 */
	recordAssistantUsage(usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	}): { stop?: WorkflowGuardStop; softWarning?: WorkflowGuardSoftWarning } {
		if (!usage) {
			const budgetStop = this.#checkBudgetStop();
			return budgetStop ? { stop: budgetStop } : {};
		}

		const addPositive = (val: number | undefined): number =>
			typeof val === "number" && Number.isFinite(val) && val > 0 ? val : 0;

		const input = addPositive(usage.input);
		const output = addPositive(usage.output);
		const cacheRead = addPositive(usage.cacheRead);
		const cacheWrite = addPositive(usage.cacheWrite);
		const total =
			typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0
				? usage.totalTokens
				: input + output + cacheRead + cacheWrite;
		const cost = addPositive(usage.cost?.total);

		this.#tokens.input += input;
		this.#tokens.output += output;
		this.#tokens.nonCachedInput += input + cacheWrite;
		this.#tokens.cacheRead += cacheRead;
		this.#tokens.cacheWrite += cacheWrite;
		this.#tokens.total += total;
		this.#costUsd += cost;

		const budgetStop = this.#checkBudgetStop();
		if (budgetStop) {
			return { stop: budgetStop };
		}
		const effectiveOutput = this.#effectiveOutputTokens();

		if (this.#softBudgetWarningRatio > 0 && this.#softBudgetWarningRatio < 1) {
			if (!this.#costSoftWarningEmitted && this.#maxCostUsd > 0) {
				const costRatio = this.#costUsd / this.#maxCostUsd;
				if (costRatio >= this.#softBudgetWarningRatio) {
					this.#costSoftWarningEmitted = true;
					return {
						softWarning: {
							kind: "cost",
							ratio: costRatio,
							spent: this.#costUsd,
							limit: this.#maxCostUsd,
							message: `Approaching per-run cost budget ($${this.#costUsd.toFixed(4)} / $${this.#maxCostUsd.toFixed(4)}, ${Math.round(costRatio * 100)}%). Wrap up your remaining work and summarize concisely.`,
						},
					};
				}
			}
			const maxOutputTokens = this.#effectiveMaxOutputTokens();
			if (!this.#tokenSoftWarningEmitted && maxOutputTokens > 0) {
				const tokenRatio = effectiveOutput / maxOutputTokens;
				if (tokenRatio >= this.#softBudgetWarningRatio) {
					this.#tokenSoftWarningEmitted = true;
					return {
						softWarning: {
							kind: "output_tokens",
							ratio: tokenRatio,
							spent: effectiveOutput,
							limit: maxOutputTokens,
							message: `Approaching per-run output token budget (${effectiveOutput.toLocaleString()} / ${maxOutputTokens.toLocaleString()} tokens, ${Math.round(tokenRatio * 100)}%). Wrap up your remaining work and summarize concisely.`,
						},
					};
				}
			}
		}
		return {};
	}

	/**
	 * Record an executed tool batch into the progress window and non-trivial
	 * consecutive-failure breaker.
	 */
	recordToolBatch(
		calls: ReadonlyArray<{ name: string; arguments: unknown }>,
		results: ReadonlyArray<{
			toolName: string;
			isError: boolean;
			content?: ReadonlyArray<{ type: string; text?: string }>;
		}>,
	): WorkflowGuardStop | undefined {
		const count = Math.min(calls.length, results.length);
		if (count === 0) return undefined;

		let batchMutated = false;

		for (let i = 0; i < count; i++) {
			const call = calls[i];
			const result = results[i];
			const skipped = isSkippedResult(result);
			const signature = `${call.name}:${stableSerialize(call.arguments)}`;
			const sigHash = hashSignature(signature);
			if (!skipped) {
				if (this.#seenSignatures.has(sigHash)) {
					this.#repeatCalls++;
				} else {
					this.#seenSignatures.add(sigHash);
				}
			}

			let targetKey = toolTarget(call.name, call.arguments);
			let novelOption: boolean | undefined;

			if (call.name === "eval" && !skipped) {
				const args =
					call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
						? (call.arguments as Record<string, unknown>)
						: {};
				const lang =
					typeof args.language === "string" && args.language.trim()
						? args.language.trim()
						: typeof args.lang === "string" && args.lang.trim()
							? args.lang.trim()
							: "unknown";
				const code =
					typeof args.code === "string"
						? args.code
						: typeof args.script === "string"
							? args.script
							: typeof args.source === "string"
								? args.source
								: "";
				const isReadOnlyEval = !isMutatingEvalArgs(args, code);
				if (this.#mutationEpoch > 0) {
					targetKey = `${targetKey}@e${this.#mutationEpoch}`;
				}
				if (result.content !== undefined) {
					const resultHash = hashSignature(normalizeEvalResultForHash(extractResultText(result.content)));
					const prev = this.#lastEvalOutcomeByLang.get(lang);
					if (isReadOnlyEval && prev && prev.epoch === this.#mutationEpoch && prev.resultHash === resultHash) {
						novelOption = false;
						this.#repeatCalls++;
					}
					this.#lastEvalOutcomeByLang.set(lang, { epoch: this.#mutationEpoch, resultHash });
				}
			}

			if (!skipped) {
				this.#budget.record(
					signature,
					!result.isError,
					targetKey,
					novelOption !== undefined ? { novel: novelOption } : undefined,
				);
				if (!result.isError && isMutatingToolCall(call.name, call.arguments)) {
					batchMutated = true;
				}
			}
		}

		if (batchMutated) {
			this.#mutationEpoch++;
		}

		if (this.#maxConsecutiveFailures <= 0) return undefined;

		const batchResults = results.slice(0, count);
		const nonTrivial = batchResults.filter(result => !READ_ONLY_TOOLS.has(result.toolName));
		const judged = nonTrivial.length > 0 ? nonTrivial : batchResults;
		const hasRealError = judged.some(result => result.isError && !isSkippedResult(result));
		const hasGenuineSuccess = judged.some(result => !result.isError && !isSkippedResult(result));
		if (hasRealError && !hasGenuineSuccess) {
			this.#consecutiveFailures++;
			if (this.#consecutiveFailures >= this.#maxConsecutiveFailures) {
				const lastTools = [
					...new Set(judged.filter(r => r.isError && !isSkippedResult(r)).map(r => r.toolName)),
				].join(", ");
				return this.#makeStop(
					"consecutive_failure",
					`Stopped after ${this.#consecutiveFailures} consecutive failing tool turns (${lastTools}).`,
				);
			}
		} else if (hasGenuineSuccess) {
			this.#consecutiveFailures = 0;
		}
		return undefined;
	}

	/**
	 * Gate a non-user outer-loop re-entry (synthetic follow-up / aside / reminder).
	 */
	recordOuterCycle(): WorkflowGuardStop | undefined {
		if (this.#maxOuterCycles <= 0) return undefined;
		this.#outerCycles++;
		if (this.#outerCycles > this.#maxOuterCycles) {
			return this.#makeStop(
				"outer_cycle_cap",
				`Stopped after ${this.#maxOuterCycles} automatic outer-loop continuation cycles without user input.`,
			);
		}
		return undefined;
	}

	/**
	 * Build a stop record for the no-progress wall-clock stall watchdog.
	 */
	createStallTimeoutStop(): WorkflowGuardStop {
		const seconds = Math.max(1, Math.round(this.#stallTimeoutMs / 1000));
		return this.#makeStop("stall_timeout", `Stopped after ${seconds}s without tool execution progress.`);
	}

	/**
	 * Genuine user input resets failure/outer-cycle counters and grants fresh
	 * step-budget headroom up to `hardCap`.
	 */
	noteUserSteer(): void {
		this.#budget.noteSteer();
		this.#consecutiveFailures = 0;
		this.#outerCycles = 0;
	}
}
