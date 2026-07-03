/**
 * Validation for the `evidence` argument the `complete` goal-tool op requires.
 *
 * Code-level counterpart to the prompt rule ("call `complete` only when the goal is
 * actually done and verified" — `prompts/tools/goal.md`, `goal-continuation.md`).
 * Before this, "call complete" was pure self-attestation: a model under budget
 * pressure or scope-shrink temptation could close a goal with zero code-level
 * friction. This does not (cannot) verify the claim is *true* — that still requires
 * the model to have actually checked the repo state — but it forces the model to
 * commit to a specific, non-trivial claim that a human reviewing the transcript can
 * hold it to, and it rejects the exact rubber-stamp phrases the prompt already
 * tells the model never to use as a reason to complete.
 */

/** Below this length, evidence can't meaningfully describe what was verified. */
export const MIN_COMPLETION_EVIDENCE_LENGTH = 15;

/** Rubber-stamp phrases that carry no verification content, normalized (trimmed,
 * lowercased, trailing punctuation stripped). Mirrors the intent of
 * `advisor/emission-guard.ts`'s `SUPPRESSED_NORMALIZED_PHRASES`. */
const TRIVIAL_COMPLETION_EVIDENCE_PHRASES = new Set([
	"done",
	"complete",
	"completed",
	"finished",
	"ok",
	"okay",
	"yes",
	"verified",
	"all done",
	"n/a",
	"na",
	"none",
	"good",
	"looks good",
	"lgtm",
	"task complete",
	"task done",
	"goal complete",
	"goal achieved",
	"it works",
	"it's done",
]);

function normalizeCompletionEvidence(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[.!]+$/, "");
}

/**
 * Validate that `evidence` is a substantive, non-generic completion claim.
 * Returns the trimmed evidence on success; throws a plain `Error` describing
 * what's missing otherwise (callers map this to their own error type).
 */
export function assertSubstantiveCompletionEvidence(evidence: string | undefined): string {
	const trimmed = evidence?.trim();
	if (!trimmed) {
		throw new Error(
			"evidence is required when op=complete: state which deliverables you verified and how (tests run, output inspected, files diffed, etc.)",
		);
	}
	if (
		trimmed.length < MIN_COMPLETION_EVIDENCE_LENGTH ||
		TRIVIAL_COMPLETION_EVIDENCE_PHRASES.has(normalizeCompletionEvidence(trimmed))
	) {
		throw new Error(
			"evidence is too generic to count as verification — describe the specific deliverables checked and how, not a status word",
		);
	}
	return trimmed;
}
