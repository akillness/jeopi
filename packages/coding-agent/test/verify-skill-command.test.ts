import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "jeopi-cli/config/settings";
import * as agentBridge from "jeopi-cli/eval/agent-bridge";
import type { Skill } from "jeopi-cli/extensibility/skills";
import { executeAcpBuiltinSlashCommand } from "jeopi-cli/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "jeopi-cli/slash-commands/types";
import * as taskDiscovery from "jeopi-cli/task/discovery";
import type { AgentDefinition } from "jeopi-cli/task/types";
import { TempDir } from "jeopi-utils";

const CRITIC_AGENT = {
	name: "critic",
	description: "Read-only plan-actionability gate.",
	systemPrompt: "Verdict the plan.",
	source: "bundled",
} satisfies AgentDefinition;

function mockCriticAvailable(): void {
	vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [CRITIC_AGENT], projectAgentsDir: null });
}

/** Minimal `SlashCommandRuntime` fixture, following the compact/shake TUI test pattern. */
function makeFixture(cwd: string, skills: Skill[]) {
	const output = vi.fn(async (_text: string) => {});
	const settings = Settings.isolated({});
	const modelRegistryStub = { authStorage: {} };
	const modelRegistry = modelRegistryStub as unknown as SlashCommandRuntime["session"]["modelRegistry"];
	const session = {
		cwd,
		skills,
		model: undefined,
		modelRegistry,
		sessionManager: { getSessionFile: () => null },
		getPlanModeState: () => undefined,
		getAgentId: () => null,
	} as unknown as SlashCommandRuntime["session"];
	const runtime = {
		session,
		cwd,
		settings,
		output,
	} as unknown as SlashCommandRuntime;
	return { runtime, output };
}

async function makeSkill(
	cwd: string,
	name: string,
	body: string,
	sourceOverrides?: Partial<Skill["_source"]>,
): Promise<Skill> {
	const filePath = `${cwd}/${name}.md`;
	await Bun.write(filePath, body);
	const skill: Skill = {
		name,
		description: `${name} skill`,
		filePath,
		baseDir: cwd,
		source: "project",
	};
	if (sourceOverrides) {
		skill._source = {
			provider: "test-provider",
			providerName: "Test",
			path: filePath,
			level: "project",
			...sourceOverrides,
		};
	}
	return skill;
}

describe("/verify-skill", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns a usage error listing available skills for an unknown name", async () => {
		using tempDir = TempDir.createSync("@verify-skill-unknown-");
		const skillA = await makeSkill(tempDir.path(), "alpha", "# alpha\n");
		const { runtime, output } = makeFixture(tempDir.path(), [skillA]);
		const discoverSpy = vi.spyOn(taskDiscovery, "discoverAgents");

		await executeAcpBuiltinSlashCommand("/verify-skill missing-skill", runtime);

		expect(output).toHaveBeenCalledWith('Unknown skill "missing-skill". Available: alpha');
		expect(discoverSpy).not.toHaveBeenCalled();
	});

	it("reports 'No eval cases defined' for a skill without an ## Eval Cases section and never spawns a subagent", async () => {
		using tempDir = TempDir.createSync("@verify-skill-no-cases-");
		const skill = await makeSkill(tempDir.path(), "no-cases", "# no-cases\n\nJust a description, no eval section.\n");
		const { runtime, output } = makeFixture(tempDir.path(), [skill]);
		const runEvalSpy = vi.spyOn(agentBridge, "runEvalAgent");
		const discoverSpy = vi.spyOn(taskDiscovery, "discoverAgents");

		await executeAcpBuiltinSlashCommand("/verify-skill no-cases", runtime);

		expect(output).toHaveBeenCalledWith(
			"No eval cases defined for this skill — add an `## Eval Cases` section with bulleted verifiable claims to enable self-verification",
		);
		expect(runEvalSpy).not.toHaveBeenCalled();
		expect(discoverSpy).not.toHaveBeenCalled();
	});

	it("renders a mixed pass/fail report matching the mocked critic verdicts", async () => {
		using tempDir = TempDir.createSync("@verify-skill-mixed-");
		const body = [
			"# mixed",
			"",
			"## Eval Cases",
			"",
			"- The tool reads files via the `read` function",
			"- The tool writes files atomically",
			"",
			"## Other Section",
			"unrelated",
			"",
		].join("\n");
		const skill = await makeSkill(tempDir.path(), "mixed", body);
		const { runtime, output } = makeFixture(tempDir.path(), [skill]);
		mockCriticAvailable();
		const runEvalSpy = vi
			.spyOn(agentBridge, "runEvalAgent")
			.mockResolvedValueOnce({
				text: JSON.stringify({ verdict: "okay", summary: "Confirmed via read.ts:12." }),
				details: { agent: "critic", id: "c1", structured: true },
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({ verdict: "iterate", summary: "write.ts uses a non-atomic write." }),
				details: { agent: "critic", id: "c2", structured: true },
			});

		await executeAcpBuiltinSlashCommand("/verify-skill mixed", runtime);

		expect(runEvalSpy).toHaveBeenCalledTimes(2);
		const report = String(output.mock.calls.at(-1)?.[0] ?? "");
		expect(report).toContain("## Skill verification: `mixed`");
		expect(report).toContain("✅ PASS — The tool reads files via the `read` function");
		expect(report).toContain("Confirmed via read.ts:12.");
		expect(report).toContain("❌ FAIL — The tool writes files atomically");
		expect(report).toContain("write.ts uses a non-atomic write.");
		expect(report).toContain("1/2 eval cases passed.");
	});

	it("suggests a ## Known Failure Modes line for a failing managed skill and writes nothing to disk", async () => {
		using tempDir = TempDir.createSync("@verify-skill-managed-");
		const body = ["# managed-skill", "", "## Eval Cases", "", "- The retry loop caps at 3 attempts", ""].join("\n");
		const skill = await makeSkill(tempDir.path(), "managed-skill", body, { provider: "jeopi-managed" });
		const { runtime, output } = makeFixture(tempDir.path(), [skill]);
		mockCriticAvailable();
		vi.spyOn(agentBridge, "runEvalAgent").mockResolvedValueOnce({
			text: JSON.stringify({ verdict: "reject", summary: "Retry loop caps at 5, not 3 (see retry.ts:40)." }),
			details: { agent: "critic", id: "c1", structured: true },
		});
		const writeSpy = vi.spyOn(Bun, "write");
		const bodyBeforeRun = await Bun.file(skill.filePath).text();

		await executeAcpBuiltinSlashCommand("/verify-skill managed-skill", runtime);

		const report = String(output.mock.calls.at(-1)?.[0] ?? "");
		expect(report).toContain("This is a managed (auto-learn) skill");
		expect(report).toContain("## Known Failure Modes");
		expect(report).toContain(
			'- "The retry loop caps at 3 attempts" — Retry loop caps at 5, not 3 (see retry.ts:40).',
		);
		expect(writeSpy).not.toHaveBeenCalled();
		const bodyAfterRun = await Bun.file(skill.filePath).text();
		expect(bodyAfterRun).toBe(bodyBeforeRun);
	});
});
