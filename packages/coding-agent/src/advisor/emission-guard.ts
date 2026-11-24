/**
 * Per-advisor emission gate.
 *
 * Prevents an advisor from flooding the primary session with:
 * - content-free acknowledgement / status filler ("Stop.", "Done.", "LGTM", ...)
 * - duplicate notes across turns (normalized for casing/punctuation), while
 *   still allowing rank escalation (`nit` -> `concern` -> `blocker`)
 * - burst spam beyond the per-update note budget (with `blocker` exempt from
 *   the cap)
 */

export type AdvisorEmissionSeverity = "nit" | "concern" | "blocker";

export type AdvisorSuppressionReason = "empty" | "noise" | "duplicate" | "budget";

export type AdvisorEmissionDecision =
	| { allowed: true; escalated: boolean }
	| { allowed: false; reason: AdvisorSuppressionReason };

export interface AdvisorEmissionGuardOptions {
	/** Maximum dedupe keys retained before oldest-first eviction. Default: 256. */
	capacity?: number;
	/** Maximum non-blocker notes admitted per advisor update cycle. Default: 1. */
	budgetPerUpdate?: number;
	/** Suppress content-free filler notes ("Stop.", "Done.", "LGTM", ...). Default: true. */
	suppressFiller?: boolean;
}

const DEFAULT_CAPACITY = 256;
const DEFAULT_BUDGET_PER_UPDATE = 1;
export const MAX_ADVISOR_NOTES_PER_UPDATE = 10;

const SEVERITY_RANK: Record<AdvisorEmissionSeverity, number> = {
	nit: 1,
	concern: 2,
	blocker: 3,
};

/** Normalize a note to its canonical dedupe / noise-match key. */
export function normalizeAdvisorNote(note: string): string {
	return note
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

const SUPPRESSED_NOTES = new Set<string>([
	"stop",
	"done",
	"ok",
	"okay",
	"ack",
	"acknowledged",
	"noted",
	"lgtm",
	"looks good",
	"looks good to me",
	"all good",
	"on track",
	"no issues",
	"no issue",
	"no issues found",
	"no concerns",
	"no concern",
	"nothing to add",
	"nothing to report",
	"nothing further",
	"continue",
	"carry on",
	"proceed",
	"keep going",
	"no issue continue",
	"no issues continue",
	"no action needed",
	"no changes needed",
	"no advice",
	"no advice needed",
	"no further input",
	"no further input needed",
	"no further advice",
	"no further advice needed",
	"no further watcher input needed",
	"no further advisor input needed",
	"standing by",
	"watching",
	"monitoring",
]);

export function isAdvisorNoiseNote(normalizedKey: string): boolean {
	return SUPPRESSED_NOTES.has(normalizedKey);
}

export class AdvisorEmissionGuard {
	readonly #capacity: number;
	readonly #suppressFiller: boolean;
	#budgetPerUpdate: number;
	/** Canonical key -> highest admitted severity rank (insertion-ordered LRU). */
	readonly #seen = new Map<string, number>();
	/** Non-blocker new notes admitted in the current update cycle. */
	#emittedInUpdate = 0;

	constructor(options?: AdvisorEmissionGuardOptions) {
		const rawCapacity = options?.capacity;
		this.#capacity =
			typeof rawCapacity === "number" && Number.isFinite(rawCapacity)
				? Math.max(1, Math.floor(rawCapacity))
				: DEFAULT_CAPACITY;
		this.#suppressFiller = options?.suppressFiller ?? true;
		this.#budgetPerUpdate = this.#normalizeBudget(options?.budgetPerUpdate ?? DEFAULT_BUDGET_PER_UPDATE);
	}

	#normalizeBudget(value: number): number {
		if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
		if (!Number.isFinite(value)) return DEFAULT_BUDGET_PER_UPDATE;
		return Math.max(1, Math.min(MAX_ADVISOR_NOTES_PER_UPDATE, Math.floor(value)));
	}

	get budgetPerUpdate(): number {
		return this.#budgetPerUpdate;
	}

	setBudgetPerUpdate(budget: number): void {
		this.#budgetPerUpdate = this.#normalizeBudget(budget);
	}

	get admittedCount(): number {
		return this.#emittedInUpdate;
	}

	/** Reset the per-update budget counter at the start of each advisor update cycle. */
	beginUpdate(): void {
		this.#emittedInUpdate = 0;
	}

	/** Clear all dedupe history and per-update state (e.g. after compaction or session switch). */
	reset(): void {
		this.#seen.clear();
		this.#emittedInUpdate = 0;
	}

	/**
	 * Evaluate and record a note admission decision.
	 *
	 * - Empty and content-free filler notes are rejected without consuming budget.
	 * - Previously admitted notes are rejected unless the new `severity` strictly
	 *   escalates the recorded rank (`nit` -> `concern` -> `blocker`).
	 * - `blocker` notes bypass the per-update budget cap; non-blocker notes are
	 *   capped at `budgetPerUpdate` per update cycle.
	 */
	admit(note: string, severity: AdvisorEmissionSeverity = "nit"): AdvisorEmissionDecision {
		const key = normalizeAdvisorNote(note);
		if (!key) return { allowed: false, reason: "empty" };
		if (this.#suppressFiller && isAdvisorNoiseNote(key)) {
			return { allowed: false, reason: "noise" };
		}

		const rank = SEVERITY_RANK[severity] ?? SEVERITY_RANK.nit;
		const prevRank = this.#seen.get(key);
		if (prevRank !== undefined && rank <= prevRank) {
			return { allowed: false, reason: "duplicate" };
		}

		const escalated = prevRank !== undefined && rank > prevRank;
		if (!escalated && severity !== "blocker" && this.#emittedInUpdate >= this.#budgetPerUpdate) {
			return { allowed: false, reason: "budget" };
		}

		if (prevRank !== undefined) {
			this.#seen.delete(key);
		}
		this.#seen.set(key, rank);
		while (this.#seen.size > this.#capacity) {
			const oldest = this.#seen.keys().next().value;
			if (oldest === undefined) break;
			this.#seen.delete(oldest);
		}

		if (!escalated && severity !== "blocker") {
			this.#emittedInUpdate++;
		}
		return { allowed: true, escalated };
	}

	/** Backwards-compatible boolean admission check. */
	accept(note: string, severity: AdvisorEmissionSeverity = "nit"): boolean {
		return this.admit(note, severity).allowed;
	}
}
