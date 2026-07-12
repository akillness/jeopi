import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "jeopi-cli/config/settings";
import { verifyGoalCompletion } from "jeopi-cli/goals/verifier";
import { resetRegisteredArtifactDirsForTests } from "jeopi-cli/internal-urls/registry-helpers";
import { getBundledAgent } from "jeopi-cli/task/agents";
import * as taskDiscovery from "jeopi-cli/task/discovery";
import type { ExecutorOptions } from "jeopi-cli/task/executor";
import * as taskExecutor from "jeopi-cli/task/executor";
import type { AgentDefinition, SingleResult } from "jeopi-cli/task/types";
import type { ToolSession } from "jeopi-cli/tools";

// Fixture agent registered with the mocked discovery layer so runEvalAgent's
// lookup/enable/spawn checks succeed for the "goal-verifier" agent name. The
// actual output schema verifyGoalCompletion sends to runSubprocess comes from
// the real bundled `goal-verifier.md` (via getBundledAgent), not from this
// fixture — mirrored here only so discovery resolves the agent at all.
const goalVerifierAgent = {
	name: "goal-verifier",
	description: "Independent grader for goal-mode completion",
	systemPrompt: "Grade the completion claim.",
	source: "bundled",
	model: ["pi/slow"],
} satisfies AgentDefinition;

function makeSession(): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.isolation.mode": "none",
	});
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		taskDepth: 0,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-eval-session",
	};
}

function mockAgents(agents: AgentDefinition[] = [goalVerifierAgent]): void {
	vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

function singleResult(options: ExecutorOptions, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

describe("verifyGoalCompletion", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetRegisteredArtifactDirsForTests();
	});

	it("resolves an okay verdict with an empty requiredFixes list when required_fixes is absent", async () => {
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options =>
			singleResult(options, {
				output: JSON.stringify({
					verdict: "okay",
					justification: "Diff covers every part of the objective; re-ran the test suite and it passed.",
					summary: "Feature implemented and verified.",
				}),
			}),
		);

		const verdict = await verifyGoalCompletion(makeSession(), "Ship the feature", "Ran tests, all green.");

		expect(verdict).toEqual({
			verdict: "okay",
			justification: "Diff covers every part of the objective; re-ran the test suite and it passed.",
			summary: "Feature implemented and verified.",
			requiredFixes: [],
		});
	});

	it("resolves requiredFixes from the required_fixes array on an iterate verdict", async () => {
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options =>
			singleResult(options, {
				output: JSON.stringify({
					verdict: "iterate",
					justification: "Two gaps remain between the objective and the diff.",
					required_fixes: ["fix A", "fix B"],
				}),
			}),
		);

		const verdict = await verifyGoalCompletion(makeSession(), "Ship the feature", "Ran tests, all green.");

		expect(verdict.verdict).toBe("iterate");
		expect(verdict.requiredFixes).toEqual(["fix A", "fix B"]);
	});

	it("fails open to iterate when the sub-agent returns unparseable non-JSON output", async () => {
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options =>
			singleResult(options, {
				output: "I looked at the repo and it seems mostly fine, hard to say for sure.",
			}),
		);

		const verdict = await verifyGoalCompletion(makeSession(), "Ship the feature", "Ran tests, all green.");

		expect(verdict.verdict).toBe("iterate");
		expect(verdict.requiredFixes).toEqual([]);
	});

	it("never rejects when the sub-agent spawn itself fails", async () => {
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async () => {
			throw new Error("boom: no model available");
		});

		const verdict = await verifyGoalCompletion(makeSession(), "Ship the feature", "Ran tests, all green.");

		expect(verdict.verdict).toBe("iterate");
		expect(verdict.requiredFixes).toEqual([]);
	});

	it("sends the bundled goal-verifier agent's own output schema as the explicit runSubprocess schema", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options =>
			singleResult(options, {
				output: JSON.stringify({ verdict: "okay", justification: "ok" }),
			}),
		);

		await verifyGoalCompletion(makeSession(), "Ship the feature", "Ran tests, all green.");

		const bundledSchema = getBundledAgent("goal-verifier")?.output;
		expect(bundledSchema).toBeDefined();
		const capturedOptions = runSpy.mock.calls[0]?.[0];
		if (!capturedOptions) throw new Error("runSubprocess was not called");
		expect(capturedOptions.outputSchema).toBe(bundledSchema);
		expect(capturedOptions.outputSchemaOverridesAgent).toBe(true);
	});
});
