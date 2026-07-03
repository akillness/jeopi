/**
 * Contract: the critic-gate plan-integrity pin (task/critic-gate.ts).
 *
 * When a critic verdict resolves `okay`, the runtime records a hash of
 * `local://jeo-plan.md` at that moment. A later attempt to spawn a
 * non-read-only agent must be refused if the plan file no longer hashes to
 * that recorded value — closing the TOCTOU window between critic approval
 * and execution. Read-only agents are unaffected; agents are also unaffected
 * when no approved-plan hash has been recorded at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "jeopi-cli/config/settings";
import { AgentLifecycleManager } from "jeopi-cli/registry/agent-lifecycle";
import { AgentRegistry } from "jeopi-cli/registry/agent-registry";
import { TaskTool } from "jeopi-cli/task";
import { hashPlanContent } from "jeopi-cli/task/critic-gate";
import * as discoveryModule from "jeopi-cli/task/discovery";
import * as executorModule from "jeopi-cli/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "jeopi-cli/task/types";
import type { ToolSession } from "jeopi-cli/tools";
import { removeWithRetries, TempDir } from "jeopi-utils";

const nonReadOnlyAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

describe("critic-gate plan-integrity pin", () => {
	let tempDir: TempDir;
	let approvedPlanHash: { hash: string; agentId: string; at: number } | undefined;

	function createSession(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			localProtocolOptions: {
				getArtifactsDir: () => tempDir.path(),
				getSessionId: () => "critic-gate-plan-integrity-test",
			},
			getApprovedPlanHash: () => approvedPlanHash,
		} as unknown as ToolSession;
	}

	async function writeGatedPlan(content: string): Promise<void> {
		const localDir = path.join(tempDir.path(), "local");
		await fs.mkdir(localDir, { recursive: true });
		await fs.writeFile(path.join(localDir, "jeo-plan.md"), content, "utf8");
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@critic-gate-plan-integrity-");
		approvedPlanHash = undefined;
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [nonReadOnlyAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await removeWithRetries(tempDir.path()).catch(() => {});
	});

	it("blocks a non-read-only spawn when the plan drifted from the approved hash", async () => {
		await writeGatedPlan("# Plan v1\nDo the original thing.");
		approvedPlanHash = {
			hash: hashPlanContent("# Plan v1\nDo the ORIGINAL thing edited."),
			agentId: "critic-1",
			at: 0,
		};
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));

		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tc-1", {
			agent: "task",
			id: "Spawnling",
			assignment: "Do the thing.",
		} as TaskParams);

		expect(getFirstText(result)).toContain("no longer matches the content");
		expect(getFirstText(result)).toContain("critic-1");
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("blocks a non-read-only spawn when the approved plan file was removed", async () => {
		// No writeGatedPlan call: the plan file simply does not exist any more.
		approvedPlanHash = { hash: hashPlanContent("# Plan v1"), agentId: "critic-1", at: 0 };
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));

		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tc-1", {
			agent: "task",
			id: "Spawnling",
			assignment: "Do the thing.",
		} as TaskParams);

		expect(getFirstText(result)).toContain("no longer matches the content");
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("allows a non-read-only spawn when the plan content still matches the approved hash", async () => {
		const planContent = "# Plan v1\nDo the original thing.";
		await writeGatedPlan(planContent);
		approvedPlanHash = { hash: hashPlanContent(planContent), agentId: "critic-1", at: 0 };
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));

		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tc-1", {
			agent: "task",
			id: "Spawnling",
			assignment: "Do the thing.",
		} as TaskParams);

		expect(getFirstText(result)).not.toContain("no longer matches");
		expect(runSpy).toHaveBeenCalledTimes(1);
	});

	it("allows the spawn unconditionally when no approved-plan hash was ever recorded", async () => {
		// No critic has ever returned `okay` this session — approvedPlanHash stays undefined.
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));

		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tc-1", {
			agent: "task",
			id: "Spawnling",
			assignment: "Do the thing.",
		} as TaskParams);

		expect(getFirstText(result)).not.toContain("no longer matches");
		expect(runSpy).toHaveBeenCalledTimes(1);
	});
});
