/**
 * Default `task`-agent spawn model-tier classifier.
 *
 * Reuses the auto-thinking difficulty classifier ({@link classifyDifficulty})
 * to decide whether a `task()` spawn's assignment is trivially simple enough
 * to route to the cheap `smol` model tier instead of the default `task`
 * tier. Only ever suggests a downgrade — never blocks or upgrades — and
 * fails open (returns `undefined`, meaning "don't override") on any
 * classification error or timeout, mirroring `AgentSession`'s
 * `#applyAutoThinkingLevel` fallback behavior.
 */
import { Effort } from "jeopi-ai";
import { logger } from "jeopi-utils";
import { type ClassifyDifficultyDeps, classifyDifficulty } from "../auto-thinking/classifier";

/** Timeout (ms) for the spawn-time model-tier classification before failing open. */
const MODEL_TIER_CLASSIFICATION_TIMEOUT_MS = 2000;

/**
 * Classify `assignment` and return `"smol"` when the work is trivially
 * simple ({@link Effort.Minimal} or {@link Effort.Low}), or `undefined` when
 * the caller should leave normal model resolution in place (not-simple
 * enough, no classifier available, or the classification failed/timed out).
 */
export async function classifyDefaultTaskModelTier(
	assignment: string,
	deps: ClassifyDifficultyDeps,
): Promise<"smol" | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODEL_TIER_CLASSIFICATION_TIMEOUT_MS);
	const signal = deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;
	try {
		const effort = await classifyDifficulty(assignment, { ...deps, signal });
		return effort === Effort.Minimal || effort === Effort.Low ? "smol" : undefined;
	} catch (error) {
		logger.debug("task: model-tier classification failed; leaving model resolution unchanged", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
