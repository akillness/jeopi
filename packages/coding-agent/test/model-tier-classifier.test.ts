/**
 * Contract: `classifyDefaultTaskModelTier` reuses the auto-thinking
 * `classifyDifficulty` classifier to decide whether a `task()` spawn's
 * assignment is trivially simple enough to route to the cheap `smol` model
 * tier. It only ever suggests a downgrade (never an upgrade or a block), and
 * fails open — returning `undefined`, never propagating — on any
 * classification error.
 *
 * The wiring gate in task/index.ts (`agentName === "task" &&
 * settingsModelOverride === undefined && task.autoModelTier`) is covered by
 * the last case below: with `task.autoModelTier` off, the classifier is never
 * invoked for a real spawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Effort } from "jeopi-ai";
import { getBundledModel } from "jeopi-catalog/models";
import * as autoThinkingClassifier from "jeopi-cli/auto-thinking/classifier";
import type { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { AgentLifecycleManager } from "jeopi-cli/registry/agent-lifecycle";
import { AgentRegistry } from "jeopi-cli/registry/agent-registry";
import { TaskTool } from "jeopi-cli/task";
import * as discoveryModule from "jeopi-cli/task/discovery";
import * as executorModule from "jeopi-cli/task/executor";
import * as modelTierClassifier from "jeopi-cli/task/model-tier-classifier";
import { classifyDefaultTaskModelTier } from "jeopi-cli/task/model-tier-classifier";
import type { AgentDefinition, SingleResult, TaskParams } from "jeopi-cli/task/types";
import type { ToolSession } from "jeopi-cli/tools";

function getModelOrThrow() {
	const model = getBundledModel("anthropic", "claude-sonnet-4-6");
	if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");
	return model;
}

describe("classifyDefaultTaskModelTier", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function deps() {
		return {
			settings: Settings.isolated(),
			registry: {} as ModelRegistry,
			model: getModelOrThrow(),
		};
	}

	it("returns smol when classifyDifficulty resolves Minimal", async () => {
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Minimal);
		const tier = await classifyDefaultTaskModelTier("fix a typo", deps());
		expect(tier).toBe("smol");
	});

	it("returns smol when classifyDifficulty resolves Low", async () => {
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
		const tier = await classifyDefaultTaskModelTier("rename a variable", deps());
		expect(tier).toBe("smol");
	});

	it.each([
		Effort.Medium,
		Effort.High,
		Effort.XHigh,
	])("returns undefined (no override) when classifyDifficulty resolves %s", async effort => {
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(effort);
		const tier = await classifyDefaultTaskModelTier("refactor the auth module", deps());
		expect(tier).toBeUndefined();
	});

	it("fails open to undefined without propagating when classifyDifficulty rejects", async () => {
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockRejectedValue(new Error("classifier unavailable"));
		await expect(classifyDefaultTaskModelTier("do something", deps())).resolves.toBeUndefined();
	});
});

// Integration: the task/index.ts wiring gate. `task.autoModelTier` must be
// checked before the classifier ever runs, so flipping it off suppresses the
// classifier call entirely for a real "task" spawn.
describe("task.autoModelTier setting gates classifier invocation", () => {
	const taskAgent: AgentDefinition = {
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled",
	};

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function createSession(autoModelTier: boolean): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({
				"task.isolation.mode": "none",
				"task.batch": false,
				"task.autoModelTier": autoModelTier,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getActiveModel: () => getModelOrThrow(),
			modelRegistry: {} as ModelRegistry,
		} as unknown as ToolSession;
	}

	it("never calls the classifier for a trivial assignment when task.autoModelTier is off", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(
			async (options): Promise<SingleResult> => ({
				index: 0,
				id: options.id ?? "X",
				agent: "task",
				agentSource: "bundled",
				task: "t",
				assignment: "fix a typo",
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			}),
		);
		const classifierSpy = vi.spyOn(modelTierClassifier, "classifyDefaultTaskModelTier");

		const tool = await TaskTool.create(createSession(false));
		await tool.execute("tc", { agent: "task", id: "X", assignment: "fix a typo" } as TaskParams);

		expect(classifierSpy).not.toHaveBeenCalled();
	});
});
