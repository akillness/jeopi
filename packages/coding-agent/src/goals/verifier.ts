/**
 * Independent-verifier bridge for goal-mode completion (see GoalRuntimeHost.verifyCompletion
 * in runtime.ts). Spawns the bundled `goal-verifier` sub-agent — a fresh session with its own
 * kernel, its own read-only tool set, and no exposure to the maker's transcript/reasoning —
 * to grade a completion claim against the objective and the actual repo diff. Reuses the eval
 * tool's `agent()` bridge as a plain async call (no eval kernel required outside eval cells;
 * `withBridgeTimeoutPause` in agent-bridge.ts is a no-op when no `emitStatus` sink is wired).
 */
import { runEvalAgent } from "../eval/agent-bridge";
import { getBundledAgent } from "../task/agents";
import type { ToolSession } from "../tools";
import type { GoalCompletionVerdict } from "./runtime";

const VERIFIER_AGENT_NAME = "goal-verifier";

/** Cap the evidence claim embedded in the verifier prompt; the verifier re-derives ground truth from the repo, not from a long claim. */
const MAX_EVIDENCE_CHARS = 4000;

function parseVerdict(output: string): GoalCompletionVerdict {
	let data: unknown;
	try {
		data = JSON.parse(output);
	} catch {
		// Verifier didn't return a structured payload (refused, crashed, plain-text
		// reply). Fail open to "iterate" rather than silently trusting completion —
		// a broken verifier bounces once instead of being bypassed unnoticed.
		return {
			verdict: "iterate",
			justification: `goal-verifier did not return a structured verdict. Raw output: ${output.slice(0, 500)}`,
			requiredFixes: [],
		};
	}
	if (data === null || typeof data !== "object") {
		return {
			verdict: "iterate",
			justification: "goal-verifier returned a non-object payload.",
			requiredFixes: [],
		};
	}
	const record = data as Record<string, unknown>;
	const verdict = record.verdict;
	if (verdict !== "okay" && verdict !== "iterate" && verdict !== "reject") {
		return {
			verdict: "iterate",
			justification: "goal-verifier returned an unrecognized verdict value.",
			requiredFixes: [],
		};
	}
	const rawFixes = record.required_fixes;
	const requiredFixes = Array.isArray(rawFixes)
		? rawFixes.filter((fix): fix is string => typeof fix === "string")
		: [];
	const justification = typeof record.justification === "string" ? record.justification : "";
	const summary = typeof record.summary === "string" ? record.summary : undefined;
	return { verdict, justification, summary, requiredFixes };
}

/**
 * Grade a goal-completion claim with the independent `goal-verifier` sub-agent.
 * Never throws: a spawn failure (depth limit, disabled agent, no model) fails
 * open to `iterate` so it costs one corrective bounce, the same as a genuine
 * gap — never a silent skip of independent grading, never a permanent block.
 */
export async function verifyGoalCompletion(
	session: ToolSession,
	objective: string,
	evidence: string,
): Promise<GoalCompletionVerdict> {
	const truncatedEvidence =
		evidence.length > MAX_EVIDENCE_CHARS ? `${evidence.slice(0, MAX_EVIDENCE_CHARS)}\n[truncated]` : evidence;
	const verifierPrompt =
		`<objective>\n${objective}\n</objective>\n\n` +
		`<evidence>\n${truncatedEvidence}\n</evidence>\n\n` +
		"Verdict whether the objective above is genuinely satisfied by the repo's current state. " +
		"The evidence is the maker's claim, not a fact — verify it independently.";
	try {
		// Explicit schema, not the agent's own frontmatter default: runEvalAgent (the
		// eval `agent()` bridge) only applies `outputSchema` when the caller supplies
		// one — unlike the `task` tool, it never falls back to `effectiveAgent.output`
		// (task/index.ts). Read the bundled definition's own `output` so this can't
		// drift from goal-verifier.md's declared shape. Omit the key entirely when
		// undefined: `Object.hasOwn` (agent-bridge.ts's `structured` check) is true
		// for an explicit `schema: undefined`, which would wrongly disable the
		// agent's frontmatter-schema fallback in the bridge.
		const schema = getBundledAgent(VERIFIER_AGENT_NAME)?.output;
		const args =
			schema === undefined
				? { prompt: verifierPrompt, agent: VERIFIER_AGENT_NAME }
				: { prompt: verifierPrompt, agent: VERIFIER_AGENT_NAME, schema };
		const result = await runEvalAgent(args, { session });
		return parseVerdict(result.text);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			verdict: "iterate",
			justification: `Independent verifier could not run: ${message}`,
			requiredFixes: [],
		};
	}
}
