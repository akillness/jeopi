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
	| "stall_timeout";

export interface WorkflowGuardStop {
	stopClass: WorkflowGuardStopClass;
	reason: string;
	step: number;
	limit: number;
	consecutiveFailures: number;
	outerCycles: number;
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
	"search",
	"ls",
	"lsp",
	"ast_grep",
	"todo_read",
	"web_search",
	"fetch",
	"jeox",
	"status",
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
		case "find":
		case "grep":
		case "search":
		case "ast_grep": {
			const query = firstStr(["pattern", "query", "glob", "globPattern", "path", "dirPath"]);
			if (query) return `${tool}:${query.slice(0, 64)}`;
			break;
		}
		case "fetch":
		case "web_search": {
			const target = firstStr(["url", "query"]);
			if (target) return `${tool}:${target.slice(0, 64)}`;
			break;
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

interface StepOutcome {
	sig: string;
	ok: boolean;
}

/**
 * Progress-scored rolling step budget ported from jeo-code.
 * Extends past `baseSteps` only while recent tool calls show real success ratio,
 * signature diversity, and at least one novel coarse target since the last extension.
 */
export class StepBudget {
	#cfg: StepBudgetConfig;
	#currentLimit: number;
	#extensionsUsed = 0;
	#window: StepOutcome[] = [];
	#seenTargets = new Set<string>();
	#novelSinceExtension = 0;

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

	record(signature: string, ok: boolean, targetKey?: string): void {
		const sigHash = hashSignature(signature);
		const targetHash = hashSignature(targetKey ?? signature);
		if (!this.#seenTargets.has(targetHash)) {
			this.#seenTargets.add(targetHash);
			this.#novelSinceExtension++;
		}
		this.#window.push({ sig: sigHash, ok });
		if (this.#window.length > this.#cfg.windowSize) {
			this.#window.shift();
		}
	}

	progress(): { ok: number; total: number; distinct: number; novel: number } {
		const total = this.#window.length;
		let ok = 0;
		const distinct = new Set<string>();
		for (const outcome of this.#window) {
			if (outcome.ok) ok++;
			distinct.add(outcome.sig);
		}
		return { ok, total, distinct: distinct.size, novel: this.#novelSinceExtension };
	}

	/**
	 * Genuine user steering changes direction mid-run: reset the progress window
	 * and grant fresh headroom up to `hardCap`.
	 */
	noteSteer(extraSteps = this.#cfg.extensionSteps): void {
		this.#window = [];
		this.#novelSinceExtension = 0;
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
				reason: "no novel tool targets since last extension",
				newLimit: this.#currentLimit,
				extensionsUsed: this.#extensionsUsed,
				progress: prog,
			};
		}

		this.#extensionsUsed++;
		this.#novelSinceExtension = 0;
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

	/**
	 * Gate before each LLM turn. Increments the step counter and checks whether
	 * the rolling StepBudget permits another model call.
	 */
	beforeModelCall(): WorkflowGuardStop | undefined {
		this.#step++;
		if (this.#step <= this.#budget.limit()) {
			return undefined;
		}
		const decision = this.#budget.tryExtend();
		if (decision.extend) {
			return undefined;
		}
		const isHardCap = this.#budget.limit() >= this.#budget.hardCap();
		return {
			stopClass: isHardCap ? "step_hard_cap" : "step_budget_stalled",
			reason: `Stopped after ${this.#step - 1} steps (limit ${this.#budget.limit()}): ${decision.reason}.`,
			step: this.#step - 1,
			limit: this.#budget.limit(),
			consecutiveFailures: this.#consecutiveFailures,
			outerCycles: this.#outerCycles,
		};
	}

	/**
	 * Record an executed tool batch into the progress window and non-trivial
	 * consecutive-failure breaker.
	 */
	recordToolBatch(
		calls: ReadonlyArray<{ name: string; arguments: unknown }>,
		results: ReadonlyArray<{ toolName: string; isError: boolean }>,
	): WorkflowGuardStop | undefined {
		const count = Math.min(calls.length, results.length);
		if (count === 0) return undefined;

		for (let i = 0; i < count; i++) {
			const call = calls[i];
			const result = results[i];
			const signature = `${call.name}:${stableSerialize(call.arguments)}`;
			this.#budget.record(signature, !result.isError, toolTarget(call.name, call.arguments));
		}

		if (this.#maxConsecutiveFailures <= 0) return undefined;

		const batchResults = results.slice(0, count);
		const nonTrivial = batchResults.filter(result => !READ_ONLY_TOOLS.has(result.toolName));
		const judged = nonTrivial.length > 0 ? nonTrivial : batchResults;
		if (judged.every(result => result.isError)) {
			this.#consecutiveFailures++;
			if (this.#consecutiveFailures >= this.#maxConsecutiveFailures) {
				const lastTools = [...new Set(judged.map(result => result.toolName))].join(", ");
				return {
					stopClass: "consecutive_failure",
					reason: `Stopped after ${this.#consecutiveFailures} consecutive failing tool turns (${lastTools}).`,
					step: this.#step,
					limit: this.#budget.limit(),
					consecutiveFailures: this.#consecutiveFailures,
					outerCycles: this.#outerCycles,
				};
			}
		} else {
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
			return {
				stopClass: "outer_cycle_cap",
				reason: `Stopped after ${this.#maxOuterCycles} automatic outer-loop continuation cycles without user input.`,
				step: this.#step,
				limit: this.#budget.limit(),
				consecutiveFailures: this.#consecutiveFailures,
				outerCycles: this.#outerCycles,
			};
		}
		return undefined;
	}

	/**
	 * Build a stop record for the no-progress wall-clock stall watchdog.
	 */
	createStallTimeoutStop(): WorkflowGuardStop {
		const seconds = Math.max(1, Math.round(this.#stallTimeoutMs / 1000));
		return {
			stopClass: "stall_timeout",
			reason: `Stopped after ${seconds}s without tool execution progress.`,
			step: this.#step,
			limit: this.#budget.limit(),
			consecutiveFailures: this.#consecutiveFailures,
			outerCycles: this.#outerCycles,
		};
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
