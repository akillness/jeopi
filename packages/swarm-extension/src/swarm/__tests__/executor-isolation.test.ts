import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SingleResult } from "jeopi-cli";
import * as taskExecutor from "jeopi-cli";
import type { IsolationContext, IsolationMergeOutcome } from "jeopi-cli/task/isolation-runner";
import * as isolationRunner from "jeopi-cli/task/isolation-runner";
import { executeSwarmAgent } from "../executor";
import type { SwarmAgent } from "../schema";
import { StateTracker } from "../state";

const plainResult: SingleResult = {
	index: 0,
	id: "test-agent-0",
	agent: "test-agent",
	agentSource: "project",
	task: "do something",
	exitCode: 0,
	output: "plain ok",
	stderr: "",
	truncated: false,
	durationMs: 100,
	tokens: 0,
	requests: 1,
};

const isolatedResult: SingleResult = {
	index: 0,
	id: "test-agent-0",
	agent: "test-agent",
	agentSource: "project",
	task: "do something",
	exitCode: 0,
	output: "isolated ok",
	stderr: "",
	truncated: false,
	durationMs: 150,
	tokens: 0,
	requests: 1,
};

const mockContext: IsolationContext = {
	repoRoot: "/tmp/fake-repo",
	baseline: {
		root: {
			repoRoot: "/tmp/fake-repo",
			headCommit: "deadbeef",
			staged: "",
			unstaged: "",
			untracked: [],
			untrackedPatch: "",
		},
		nested: [],
	},
};

const mergeOutcomeSuccess: IsolationMergeOutcome = {
	summary: "",
	changesApplied: true,
	hadAnyChanges: true,
	mergedBranchForNestedPatches: true,
};

const testAgent: SwarmAgent = {
	name: "test-agent",
	role: "tester",
	task: "do something",
	reportsTo: [],
	waitsFor: [],
};

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-isolation-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("executeSwarmAgent isolation routing", () => {
	it("uses the plain runSubprocess path and never touches prepareIsolationContext when isolation is omitted", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(plainResult);
		const prepareSpy = vi.spyOn(isolationRunner, "prepareIsolationContext");
		const runIsolatedSpy = vi.spyOn(isolationRunner, "runIsolatedSubprocess");

		const stateTracker = new StateTracker(workspace, "test-swarm");
		await stateTracker.init(["test-agent"], 1, "sequential");

		const result = await executeSwarmAgent(testAgent, 0, {
			workspace,
			swarmName: "test-swarm",
			iteration: 0,
			stateTracker,
		});

		expect(result.exitCode).toBe(0);
		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		expect(prepareSpy).not.toHaveBeenCalled();
		expect(runIsolatedSpy).not.toHaveBeenCalled();
	});

	it("uses the plain runSubprocess path and never touches prepareIsolationContext when isolation is explicitly false", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(plainResult);
		const prepareSpy = vi.spyOn(isolationRunner, "prepareIsolationContext");

		const stateTracker = new StateTracker(workspace, "test-swarm");
		await stateTracker.init(["test-agent"], 1, "sequential");

		const result = await executeSwarmAgent(testAgent, 0, {
			workspace,
			swarmName: "test-swarm",
			iteration: 0,
			stateTracker,
			isolation: false,
		});

		expect(result.exitCode).toBe(0);
		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		expect(prepareSpy).not.toHaveBeenCalled();
	});

	it("routes through prepareIsolationContext/runIsolatedSubprocess/mergeIsolatedChanges and records success when isolation is true", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess");
		const prepareSpy = vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue(mockContext);
		const runIsolatedSpy = vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockResolvedValue(isolatedResult);
		const mergeSpy = vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue(mergeOutcomeSuccess);

		const stateTracker = new StateTracker(workspace, "test-swarm");
		await stateTracker.init(["test-agent"], 1, "sequential");
		const updateAgentSpy = vi.spyOn(stateTracker, "updateAgent");

		const result = await executeSwarmAgent(testAgent, 0, {
			workspace,
			swarmName: "test-swarm",
			iteration: 0,
			stateTracker,
			isolation: true,
		});

		expect(result).toEqual(isolatedResult);
		expect(prepareSpy).toHaveBeenCalledTimes(1);
		expect(prepareSpy).toHaveBeenCalledWith(workspace);
		expect(runIsolatedSpy).toHaveBeenCalledTimes(1);
		expect(mergeSpy).toHaveBeenCalledTimes(1);
		expect(mergeSpy).toHaveBeenCalledWith(
			expect.objectContaining({ result: isolatedResult, repoRoot: mockContext.repoRoot, mergeMode: "branch" }),
		);
		expect(runSubprocessSpy).not.toHaveBeenCalled();

		// Final state update reflects success matching the mocked exit code (0 -> "completed").
		const finalCall = updateAgentSpy.mock.calls.at(-1);
		expect(finalCall).toBeDefined();
		const [finalAgentName, finalUpdate] = finalCall!;
		expect(finalAgentName).toBe("test-agent");
		expect(finalUpdate.status).toBe("completed");
		expect(stateTracker.state.agents["test-agent"]?.status).toBe("completed");
	});

	it("marks the iteration failed with no silent fallback when prepareIsolationContext rejects (not a git repository)", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess");
		const prepareSpy = vi
			.spyOn(isolationRunner, "prepareIsolationContext")
			.mockRejectedValue(new Error("fatal: not a git repository (or any of the parent directories): .git"));
		const runIsolatedSpy = vi.spyOn(isolationRunner, "runIsolatedSubprocess");
		const mergeSpy = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const stateTracker = new StateTracker(workspace, "test-swarm");
		await stateTracker.init(["test-agent"], 1, "sequential");
		const updateAgentSpy = vi.spyOn(stateTracker, "updateAgent");
		const appendLogSpy = vi.spyOn(stateTracker, "appendLog");

		await expect(
			executeSwarmAgent(testAgent, 0, {
				workspace,
				swarmName: "test-swarm",
				iteration: 0,
				stateTracker,
				isolation: true,
			}),
		).rejects.toThrow(/not a git repository/);

		expect(prepareSpy).toHaveBeenCalledTimes(1);
		expect(runIsolatedSpy).not.toHaveBeenCalled();
		expect(mergeSpy).not.toHaveBeenCalled();
		expect(runSubprocessSpy).not.toHaveBeenCalled();

		const finalCall = updateAgentSpy.mock.calls.at(-1);
		expect(finalCall).toBeDefined();
		const [finalAgentName, finalUpdate] = finalCall!;
		expect(finalAgentName).toBe("test-agent");
		expect(finalUpdate.status).toBe("failed");
		expect(finalUpdate.error).toMatch(/not a git repository/);
		expect(stateTracker.state.agents["test-agent"]?.status).toBe("failed");

		const loggedMessages = appendLogSpy.mock.calls.map(call => call[1]);
		expect(loggedMessages.some(message => message.includes("not a git repository"))).toBe(true);
	});
});
