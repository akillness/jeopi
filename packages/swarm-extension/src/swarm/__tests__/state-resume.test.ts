import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSource, ModelRegistry, SingleResult } from "jeopi-cli";
import * as executorModule from "../executor";
import { PipelineController } from "../pipeline";
import type { SwarmAgent, SwarmDefinition } from "../schema";
import { StateTracker } from "../state";

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-state-resume-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("StateTracker.load()", () => {
	it("returns null and does not throw when no pipeline.json has been persisted", async () => {
		const tracker = new StateTracker(workspace, "unpersisted-swarm");

		const loaded = await tracker.load();

		expect(loaded).toBeNull();
	});

	it("returns state matching a prior init()+updatePipeline() from a separate tracker instance pointed at the same dir, and mutates the calling tracker's own internal state to match", async () => {
		const writer = new StateTracker(workspace, "resume-swarm");
		await writer.init(["agent-a"], 5, "pipeline");
		await writer.updatePipeline({ status: "running", iteration: 3 });

		const reader = new StateTracker(workspace, "resume-swarm");
		// Before load(), a freshly constructed tracker has its own idle default state.
		expect(reader.state.iteration).toBe(0);
		expect(reader.state.status).toBe("idle");

		const loaded = await reader.load();

		expect(loaded).not.toBeNull();
		expect(loaded?.iteration).toBe(3);
		expect(loaded?.status).toBe("running");

		// load() reassigns the tracker's private #state field from the persisted JSON,
		// so the calling tracker's own `.state` getter reflects the loaded values too.
		expect(reader.state.iteration).toBe(3);
		expect(reader.state.status).toBe("running");
		expect(reader.state).toEqual(loaded as NonNullable<typeof loaded>);
	});
});

describe("PipelineController resume via startIteration", () => {
	const mockSuccessResult: SingleResult = {
		index: 0,
		id: "mock-id",
		agent: "solo",
		agentSource: "project" as AgentSource,
		task: "do the thing",
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 10,
		tokens: 0,
		requests: 1,
	};

	it("only runs iterations from startIteration through targetCount-1, not from 0", async () => {
		const executeSpy = vi.spyOn(executorModule, "executeSwarmAgent").mockResolvedValue(mockSuccessResult);

		const soloAgent: SwarmAgent = {
			name: "solo",
			role: "solo runner",
			task: "do the thing",
			reportsTo: [],
			waitsFor: [],
		};
		const agents = new Map<string, SwarmAgent>([["solo", soloAgent]]);
		const def: SwarmDefinition = {
			name: "resume-pipeline",
			workspace,
			mode: "sequential",
			targetCount: 4,
			agents,
			agentOrder: ["solo"],
		};
		const waves: string[][] = [["solo"]];

		const stateTracker = new StateTracker(workspace, "resume-pipeline");
		await stateTracker.init(["solo"], 4, "sequential");

		const controller = new PipelineController(def, waves, stateTracker);
		const modelRegistry = {} as ModelRegistry;

		const result = await controller.run({
			workspace,
			startIteration: 2,
			modelRegistry,
		});

		expect(result.status).toBe("completed");
		expect(executeSpy).toHaveBeenCalledTimes(2);

		const executedIterations = executeSpy.mock.calls.map(call => call[2].iteration);
		expect(executedIterations).toEqual([2, 3]);
	});
});
