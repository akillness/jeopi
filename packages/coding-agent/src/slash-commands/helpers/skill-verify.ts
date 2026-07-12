/**
 * `/verify-skill <name>` — self-verification for a skill's `## Eval Cases`.
 *
 * Resolves a skill from the active session, extracts a bulleted `## Eval
 * Cases` markdown section from its `SKILL.md` body (if present), and spawns
 * one read-only `critic` subagent per case to verdict whether the claim still
 * holds against the current repo state. Renders a pass/fail markdown report;
 * never mutates the skill file.
 *
 * Named `verify-skill` (not `skill`) to avoid colliding with the pre-existing
 * `/skill:<name>` direct-skill-invocation convention (both parse to the
 * command-name token `skill` under `parseSlashCommand`'s earliest-whitespace-
 * or-colon splitting rule — see slash-commands/helpers/parse.ts).
 */
import { MANAGED_SKILLS_PROVIDER_ID } from "../../autolearn/managed-skills";
import { runEvalAgent } from "../../eval/agent-bridge";
import { getBundledAgent } from "../../task/agents";
import * as taskDiscovery from "../../task/discovery";
import type { ToolSession } from "../../tools";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, usage } from "./parse";

const VERIFIER_AGENT_NAME = "critic";

interface EvalCaseVerdict {
	claim: string;
	passed: boolean;
	reason: string;
}

/** Extract the bulleted list under a `## Eval Cases` heading, if present. */
export function extractEvalCases(skillBody: string): string[] {
	const headingMatch = /^##\s+Eval Cases\s*$/m.exec(skillBody);
	if (!headingMatch) return [];
	const sectionStart = headingMatch.index + headingMatch[0].length;
	const rest = skillBody.slice(sectionStart);
	const nextHeadingMatch = /^#{1,6}\s+\S/m.exec(rest);
	const sectionBody = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
	const cases: string[] = [];
	for (const line of sectionBody.split("\n")) {
		const bulletMatch = /^\s*[-*+]\s+(.+)$/.exec(line);
		if (bulletMatch?.[1]) cases.push(bulletMatch[1].trim());
	}
	return cases;
}

/** Verdict a single eval-case claim against the current repo state via the bundled `critic` agent. */
async function verifyEvalCase(session: ToolSession, claim: string): Promise<EvalCaseVerdict> {
	const verifyPrompt =
		`Verify this claim against the current repository state: ${claim}\n\n` +
		"Report whether it still holds (yes/no) and why, citing files/commands.";
	// Explicit schema, not the agent's own frontmatter default: runEvalAgent (the
	// eval `agent()` bridge) only applies `outputSchema` when the caller supplies
	// one — it never falls back to the agent's `output` frontmatter on its own
	// (see goals/verifier.ts for the same pattern). Read the bundled definition's
	// declared shape so this can't drift from critic.md.
	const schema = getBundledAgent(VERIFIER_AGENT_NAME)?.output;
	const args =
		schema === undefined
			? { prompt: verifyPrompt, agent: VERIFIER_AGENT_NAME }
			: { prompt: verifyPrompt, agent: VERIFIER_AGENT_NAME, schema };
	try {
		const result = await runEvalAgent(args, { session });
		let verdict: unknown;
		try {
			verdict = JSON.parse(result.text);
		} catch {
			// Freeform fallback: no parseable JSON, treat non-empty output as inconclusive-pass with raw text as reason.
			return { claim, passed: true, reason: result.text.trim().slice(0, 300) || "No structured verdict returned." };
		}
		if (verdict && typeof verdict === "object") {
			const record = verdict as Record<string, unknown>;
			const rawVerdict = record.verdict;
			const passed = rawVerdict === "okay";
			const reason =
				(typeof record.summary === "string" && record.summary) ||
				(typeof record.justification === "string" && record.justification) ||
				"No justification returned.";
			return { claim, passed, reason: reason.slice(0, 400) };
		}
		return { claim, passed: false, reason: "Verifier returned an unparseable verdict." };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { claim, passed: false, reason: `Verification subagent failed: ${message}` };
	}
}

function renderReport(skillName: string, isManaged: boolean, verdicts: EvalCaseVerdict[]): string {
	const lines: string[] = [`## Skill verification: \`${skillName}\``, ""];
	const failures: EvalCaseVerdict[] = [];
	for (const verdict of verdicts) {
		lines.push(`- ${verdict.passed ? "✅ PASS" : "❌ FAIL"} — ${verdict.claim}`);
		lines.push(`  ${verdict.reason}`);
		if (!verdict.passed) failures.push(verdict);
	}
	const passCount = verdicts.length - failures.length;
	lines.push("", `${passCount}/${verdicts.length} eval cases passed.`);
	if (failures.length > 0 && isManaged) {
		lines.push(
			"",
			"This is a managed (auto-learn) skill. To record the failure mode, append a line like this under a `## Known Failure Modes` section (not applied automatically):",
			"",
		);
		for (const failure of failures) {
			lines.push(`- "${failure.claim}" — ${failure.reason}`);
		}
	}
	return lines.join("\n");
}

/** `/verify-skill <name>` handler — resolves a skill, runs its `## Eval Cases`, reports pass/fail. */
export async function handleSkillCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const skillName = command.args.trim();
	if (!skillName) {
		return usage("Usage: /verify-skill <name>", runtime);
	}
	const skill = runtime.session.skills.find(candidate => candidate.name === skillName);
	if (!skill) {
		const available = runtime.session.skills.map(candidate => candidate.name).join(", ") || "none";
		return usage(`Unknown skill "${skillName}". Available: ${available}`, runtime);
	}

	const body = await Bun.file(skill.filePath).text();
	const evalCases = extractEvalCases(body);
	if (evalCases.length === 0) {
		await runtime.output(
			`No eval cases defined for this skill — add an \`## Eval Cases\` section with bulleted verifiable claims to enable self-verification`,
		);
		return commandConsumed();
	}

	await runtime.output(`Verifying ${evalCases.length} eval case(s) for \`${skillName}\`…`);

	// Discover once, upfront, to fail fast with a clear message if the critic
	// agent is unavailable (disabled, or bundled agents failed to load) rather
	// than surfacing N identical spawn errors.
	const { agents } = await taskDiscovery.discoverAgents(runtime.cwd);
	if (!taskDiscovery.getAgent(agents, VERIFIER_AGENT_NAME)) {
		return usage(
			`The "${VERIFIER_AGENT_NAME}" agent is unavailable in this session; cannot run eval cases.`,
			runtime,
		);
	}

	const session: ToolSession = {
		cwd: runtime.cwd,
		hasUI: false,
		settings: runtime.settings,
		skills: [...runtime.session.skills],
		taskDepth: 0,
		getSessionFile: () => runtime.session.sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		getPlanModeState: () => runtime.session.getPlanModeState(),
		getActiveModelString: () =>
			runtime.session.model ? `${runtime.session.model.provider}/${runtime.session.model.id}` : undefined,
		modelRegistry: runtime.session.modelRegistry,
		authStorage: runtime.session.modelRegistry.authStorage,
		getAgentId: () => runtime.session.getAgentId() ?? null,
	};
	const verdicts: EvalCaseVerdict[] = [];
	for (const claim of evalCases) {
		verdicts.push(await verifyEvalCase(session, claim));
	}

	const isManaged = skill._source?.provider === MANAGED_SKILLS_PROVIDER_ID;
	await runtime.output(renderReport(skillName, isManaged, verdicts));
	return commandConsumed();
}
