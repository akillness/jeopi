/**
 * Deterministic evidence gate for goal completion — the code-level counterpart to
 * the prompt-side completion audit (`prompts/goals/goal-continuation.md`).
 *
 * `assertSubstantiveCompletionEvidence` (completion-evidence.ts) only checks that
 * the completion *claim text* is non-generic; it cannot see whether the work was
 * actually verified. This gate closes that "gate theater" failure mode with
 * runtime signals the session already observes: a goal turn that MUTATED project
 * files can self-report complete only when a verification signal (test / build /
 * typecheck / lint run) was observed AFTER the last mutation.
 *
 * Design mirrors gajae-code's `classifyDoneGate` + jeo-code's `applyEvidenceGate`:
 * - Pure classification over recorded signals — no re-scan of the transcript.
 * - Single-pushback latch: the first blocked `complete` bounces with a corrective
 *   message; a second `complete` with no new evidence passes (the escape hatch for
 *   docs/config-only changes where no verification command applies). Any new
 *   mutation recorded after a bounce re-arms the gate.
 */

/** Tool names whose successful execution counts as a project-file mutation. */
export const MUTATION_TOOL_NAMES: Record<string, true> = {
	edit: true,
	write: true,
	ast_edit: true,
};

/**
 * Commands (or their output head) that count as a verification signal: a test,
 * build, typecheck, or lint invocation. Matches command text and the first
 * `VERIFY_OUTPUT_SCAN_LIMIT` chars of output — enough to catch a runner's banner
 * without rescanning megabytes of logs.
 */
export const VERIFY_SIGNAL_RE = /\b(test|tests|tsc|tsgo|typecheck|lint|build|check|spec|pytest|vitest|jest|biome)\b/i;

/** Output prefix length scanned for verification signals. */
export const VERIFY_OUTPUT_SCAN_LIMIT = 2000;

/** True when a bash/eval command (or the head of its output) proves a verification ran. */
export function isVerificationSignal(command: string, output = ""): boolean {
	return VERIFY_SIGNAL_RE.test(command) || VERIFY_SIGNAL_RE.test(output.slice(0, VERIFY_OUTPUT_SCAN_LIMIT));
}

export type EvidenceGateState = "pass" | "unverified" | "stale-verification";

export interface EvidenceGateVerdict {
	state: EvidenceGateState;
	/** When true, `complete` should be bounced once with `message`. */
	block: boolean;
	/** Corrective message for the bounce; empty when `state === "pass"`. */
	message: string;
}

/**
 * Tracks mutation/verification evidence for the active goal. Sequence-ordered so
 * "verified, then mutated again" is detected as stale evidence regardless of how
 * many turns separate the two.
 */
export class GoalEvidenceTracker {
	#seq = 0;
	#lastMutationSeq = 0;
	#lastVerificationSeq = 0;
	/** Set when a `complete` was bounced; cleared by any new mutation. */
	#bypassArmed = false;

	/** Reset all evidence (new goal, or goal replaced). */
	reset(): void {
		this.#seq = 0;
		this.#lastMutationSeq = 0;
		this.#lastVerificationSeq = 0;
		this.#bypassArmed = false;
	}

	/** Record a successful project-file mutation (edit/write/ast_edit). */
	recordMutation(): void {
		this.#lastMutationSeq = ++this.#seq;
		// New mutation invalidates a previously granted escape hatch: the model
		// must re-justify (or re-verify) the new change.
		this.#bypassArmed = false;
	}

	/** Record a successful verification run (test/build/typecheck/lint). */
	recordVerification(): void {
		this.#lastVerificationSeq = ++this.#seq;
	}

	get sawMutation(): boolean {
		return this.#lastMutationSeq > 0;
	}

	get sawVerification(): boolean {
		return this.#lastVerificationSeq > 0;
	}

	/** True when the last mutation happened after the last verification. */
	get verificationStale(): boolean {
		return this.#lastMutationSeq > this.#lastVerificationSeq;
	}

	/**
	 * Classify a `complete` attempt. First blocked attempt arms the bypass latch;
	 * the next attempt (with no new mutation in between) passes.
	 */
	classifyCompletion(): EvidenceGateVerdict {
		if (!this.sawMutation) {
			return { state: "pass", block: false, message: "" };
		}
		if (this.sawVerification && !this.verificationStale) {
			return { state: "pass", block: false, message: "" };
		}
		if (this.#bypassArmed) {
			// Second attempt without new evidence: the escape hatch for changes
			// where no verification command applies (docs/config-only).
			return { state: "pass", block: false, message: "" };
		}
		this.#bypassArmed = true;
		if (!this.sawVerification) {
			return {
				state: "unverified",
				block: true,
				message:
					"Completion blocked: this goal session modified project files but no verification signal " +
					"(test/build/typecheck/lint run) was observed. Run the narrowest command that proves the " +
					"change works, then call complete again. If verification is genuinely not applicable " +
					"(docs/config-only change), call complete again and say why in the evidence.",
			};
		}
		return {
			state: "stale-verification",
			block: true,
			message:
				"Completion blocked: files were modified AFTER the last successful verification run, so that " +
				"evidence no longer reflects the current tree. Re-run the narrowest verification command " +
				"against the latest changes, then call complete again. If the later edits are " +
				"verification-irrelevant (docs/config-only), call complete again and say why in the evidence.",
		};
	}
}
