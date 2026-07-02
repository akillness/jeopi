import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import { enforceCriticGateWrite } from "../tools/plan-mode-guard";
import {
	CRITIC_GATE_MAX_STRIKES,
	type CriticGateState,
	evaluateCriticGateSpawn,
	parseCriticVerdict,
	updateCriticGateState,
} from "./critic-gate";
import * as taskDiscovery from "./discovery";
import * as executor from "./executor";
import { TaskTool } from "./index";
import type { AgentDefinition, SingleResult } from "./types";

const criticAgent = {
	name: "critic",
	description: "Plan gate.",
	systemPrompt: "Gate plans.",
	source: "bundled",
	tools: ["read", "grep", "glob", "web_search", "ast_grep"],
} satisfies AgentDefinition;

const workerAgent = {
	name: "task",
	description: "General worker.",
	systemPrompt: "Do work.",
	source: "bundled",
} satisfies AgentDefinition;

const planAgent = {
	name: "plan",
	description: "Read-only planner.",
	systemPrompt: "Plan.",
	source: "bundled",
	tools: ["read", "grep", "glob"],
} satisfies AgentDefinition;

function engagedGate(overrides: Partial<CriticGateState> = {}): CriticGateState {
	return {
		verdict: "reject",
		agentId: "Critic1",
		at: Date.now(),
		requiredFixes: ["name the target file"],
		strikes: 1,
		...overrides,
	};
}

function makeSession(gate: { state?: CriticGateState }): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.batch": true,
		"task.isolation.mode": "none",
	});
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getCriticGateState: () => gate.state,
		setCriticGateState: state => {
			gate.state = state;
		},
	};
}

function criticResult(output: string): SingleResult {
	return {
		index: 0,
		id: "Critic1",
		agent: "critic",
		agentSource: "bundled",
		task: "gate the plan",
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 1,
		requests: 1,
	};
}

describe("critic gate verdict lifecycle", () => {
	it("parses schema-shaped verdicts and ignores non-critic payloads", () => {
		expect(parseCriticVerdict(JSON.stringify({ verdict: "iterate", required_fixes: ["fix a", 3] }))).toEqual({
			verdict: "iterate",
			requiredFixes: ["fix a"],
			summary: undefined,
		});
		expect(parseCriticVerdict("not json")).toBeUndefined();
		expect(parseCriticVerdict(JSON.stringify({ verdict: "maybe" }))).toBeUndefined();
		expect(parseCriticVerdict(JSON.stringify({ findings: [] }))).toBeUndefined();
	});

	it("engages on non-okay, counts consecutive strikes, and clears on okay", () => {
		const first = updateCriticGateState(undefined, { verdict: "iterate", requiredFixes: ["x"] }, "Critic1");
		expect(first).toMatchObject({ verdict: "iterate", strikes: 1, requiredFixes: ["x"] });

		const second = updateCriticGateState(first, { verdict: "reject", requiredFixes: [] }, "Critic2");
		expect(second).toMatchObject({ verdict: "reject", strikes: 2, agentId: "Critic2" });

		expect(updateCriticGateState(second, { verdict: "okay", requiredFixes: [] }, "Critic3")).toBeUndefined();
	});

	it("blocks non-read-only spawns while engaged, keeps read-only lanes open", () => {
		const state = engagedGate();
		expect(evaluateCriticGateSpawn(undefined, "task", false)).toBeUndefined();
		expect(evaluateCriticGateSpawn(state, "plan", true)).toBeUndefined();
		expect(evaluateCriticGateSpawn(state, "critic", true)).toBeUndefined();

		const blocked = evaluateCriticGateSpawn(state, "task", false);
		expect(blocked).toContain("`reject`");
		expect(blocked).toContain("name the target file");
	});

	it("closes the iterate loop after the strike budget is exhausted", () => {
		const state = engagedGate({ verdict: "iterate", strikes: CRITIC_GATE_MAX_STRIKES });
		const blocked = evaluateCriticGateSpawn(state, "critic", true);
		expect(blocked).toContain("Do NOT re-submit to critic");
		// Other read-only lanes stay open so the agent can still gather what it
		// needs to write the report.
		expect(evaluateCriticGateSpawn(state, "plan", true)).toBeUndefined();
	});
});

describe("critic gate write guard", () => {
	it("rejects working-tree writes while engaged and allows them once cleared", () => {
		const gate: { state?: CriticGateState } = { state: engagedGate() };
		const session = makeSession(gate);
		expect(() => enforceCriticGateWrite(session, "src/index.ts")).toThrow(/Critic gate engaged/);

		gate.state = undefined;
		expect(() => enforceCriticGateWrite(session, "src/index.ts")).not.toThrow();
	});
});

describe("critic gate task-tool enforcement", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refuses to spawn a non-read-only agent while the gate is engaged", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [criticAgent, workerAgent, planAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi.spyOn(executor, "runSubprocess").mockResolvedValue(criticResult("{}"));

		const tool = await TaskTool.create(makeSession({ state: engagedGate() }));
		const result = await tool.execute("call-1", { agent: "task", assignment: "implement the fix" });

		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("Critic gate engaged");
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("records a reject verdict from a critic run and clears it on okay", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [criticAgent, workerAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi
			.spyOn(executor, "runSubprocess")
			.mockResolvedValue(criticResult(JSON.stringify({ verdict: "reject", required_fixes: ["broken step 2"] })));

		const gate: { state?: CriticGateState } = {};
		const tool = await TaskTool.create(makeSession(gate));
		await tool.execute("call-1", { agent: "critic", assignment: "gate the plan" });

		expect(gate.state).toMatchObject({ verdict: "reject", strikes: 1, requiredFixes: ["broken step 2"] });

		runSpy.mockResolvedValue(criticResult(JSON.stringify({ verdict: "okay" })));
		await tool.execute("call-2", { agent: "critic", assignment: "gate the revised plan" });

		expect(gate.state).toBeUndefined();
	});
});
