/**
 * Critic gate — the hard, code-enforced counterpart of the prompt rule
 * "You NEVER execute a plan whose latest critic verdict is not `okay`".
 *
 * When a `critic` subagent completes with a schema-validated verdict, the
 * parent session records it here. While the latest verdict is `iterate` or
 * `reject` the runtime — not the prompt — blocks execution:
 *
 * - `task` refuses to spawn non-read-only agents (read-only lanes such as
 *   `plan`, `explore`, and `critic` itself stay open so the plan can be
 *   revised and re-gated).
 * - Working-tree mutations through `write`/`edit`/patch are rejected; the
 *   `local://` artifact sandbox stays writable for seeds, plans, and notes.
 *
 * The gate clears in exactly two ways: a subsequent critic verdict of `okay`,
 * or the next user-authored prompt (the user regaining control is the only
 * override — mirroring jeo-code's `approve` hard gate, scoped to a turn-chain
 * instead of a state file).
 *
 * A strike counter bounds the iterate loop: after
 * {@link CRITIC_GATE_MAX_STRIKES} consecutive non-okay verdicts without user
 * input, even re-submitting to `critic` is refused — the agent must stop and
 * report the surviving gaps instead of burning tokens on convergence-free
 * re-planning.
 */

/** Agent name whose structured verdicts drive the gate. */
export const CRITIC_AGENT_NAME = "critic";

/** Consecutive non-okay verdicts allowed before the gate forces a stop-and-report. */
export const CRITIC_GATE_MAX_STRIKES = 3;

/** Non-okay verdicts that engage the gate. */
export type CriticGateVerdict = "iterate" | "reject";

/** Gate state held by the parent session while the latest verdict is not `okay`. */
export interface CriticGateState {
	/** Latest non-okay verdict. */
	verdict: CriticGateVerdict;
	/** Agent id of the critic run that produced the verdict. */
	agentId: string;
	/** Epoch ms when the verdict was recorded. */
	at: number;
	/** `required_fixes` from the critic's structured output (empty for reject without fixes). */
	requiredFixes: string[];
	/** Consecutive non-okay verdicts since the last okay/user prompt. */
	strikes: number;
}

/** Verdict parsed from a critic subagent's validated structured output. */
export interface ParsedCriticVerdict {
	verdict: "okay" | CriticGateVerdict;
	requiredFixes: string[];
	summary?: string;
}

/**
 * Parse a critic verdict from the subagent's final output payload (the
 * JSON-serialized, schema-validated yield data). Returns undefined when the
 * payload is not a critic-shaped verdict — the gate then stays untouched.
 */
export function parseCriticVerdict(output: string): ParsedCriticVerdict | undefined {
	let data: unknown;
	try {
		data = JSON.parse(output);
	} catch {
		return undefined;
	}
	if (data === null || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	const verdict = record.verdict;
	if (verdict !== "okay" && verdict !== "iterate" && verdict !== "reject") return undefined;
	const rawFixes = record.required_fixes;
	const requiredFixes = Array.isArray(rawFixes)
		? rawFixes.filter((fix): fix is string => typeof fix === "string")
		: [];
	const summary = typeof record.summary === "string" ? record.summary : undefined;
	return { verdict, requiredFixes, summary };
}

/**
 * Fold a new verdict into the gate state. `okay` clears the gate; a non-okay
 * verdict engages it and increments the consecutive-strike counter.
 */
export function updateCriticGateState(
	previous: CriticGateState | undefined,
	parsed: ParsedCriticVerdict,
	agentId: string,
	now: number = Date.now(),
): CriticGateState | undefined {
	if (parsed.verdict === "okay") return undefined;
	return {
		verdict: parsed.verdict,
		agentId,
		at: now,
		requiredFixes: parsed.requiredFixes,
		strikes: (previous?.strikes ?? 0) + 1,
	};
}

function formatRequiredFixes(state: CriticGateState): string {
	if (state.requiredFixes.length === 0) return "";
	const bullets = state.requiredFixes.map(fix => `- ${fix}`).join("\n");
	return `\nUnresolved required fixes:\n${bullets}`;
}

function gateSummaryLine(state: CriticGateState): string {
	return `Critic gate engaged: the latest critic verdict (from \`${state.agentId}\`) was \`${state.verdict}\`, not \`okay\`.`;
}

/**
 * Decide whether a spawn is allowed under the current gate state. Returns the
 * rejection message when blocked, undefined when allowed.
 *
 * Read-only agents (plan revision, exploration, re-gating via critic) stay
 * allowed — except that once the strike budget is exhausted, even a fresh
 * critic run is refused so the loop terminates at the user instead of cycling.
 */
export function evaluateCriticGateSpawn(
	state: CriticGateState | undefined,
	agentName: string,
	agentIsReadOnly: boolean,
): string | undefined {
	if (!state) return undefined;
	if (agentName === CRITIC_AGENT_NAME && state.strikes >= CRITIC_GATE_MAX_STRIKES) {
		return (
			`Critic gate: ${state.strikes} consecutive non-okay critic verdicts without user input — the iterate loop is closed. ` +
			`Do NOT re-submit to critic. Stop and report the surviving gaps to the user; the gate clears on the next user message.${formatRequiredFixes(state)}`
		);
	}
	if (agentIsReadOnly) return undefined;
	return (
		`${gateSummaryLine(state)} Spawning non-read-only agent "${agentName}" is blocked by the runtime, not just the prompt. ` +
		`To proceed: revise the plan (read-only \`plan\` agent), re-submit to a fresh \`critic\`, and execute only after an \`okay\` verdict — or stop and report to the user (the gate clears on the next user message).${formatRequiredFixes(state)}`
	);
}

/**
 * Error text for a working-tree mutation attempted while the gate is engaged.
 * The `local://` sandbox is exempt (seeds/plans/notes live there); callers
 * check that before invoking this.
 */
export function criticGateWriteMessage(state: CriticGateState): string {
	return (
		`${gateSummaryLine(state)} The working tree is locked until a critic returns \`okay\` for the revised plan ` +
		`(or the user sends a new message). Write plans and notes to local:// files instead.${formatRequiredFixes(state)}`
	);
}
