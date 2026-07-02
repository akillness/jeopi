import { describe, expect, it } from "bun:test";
import { isReadOnlyAgent } from "jeopi-cli/task";
import { loadBundledAgents } from "jeopi-cli/task/agents";
import type { AgentDefinition } from "jeopi-cli/task/types";

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}

describe("task agent capability descriptions", () => {
	it("classifies bundled explore and critic as the read-only delegated agents", () => {
		const agents = loadBundledAgents();

		expect(isReadOnlyAgent(agentByName(agents, "explore"))).toBe(true);
		expect(isReadOnlyAgent(agentByName(agents, "critic"))).toBe(true);
		for (const name of ["task", "sonic", "plan", "reviewer", "designer", "architect"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("disables read summarization for explore and librarian, leaves other agents summarizing", () => {
		const agents = loadBundledAgents();

		expect(agentByName(agents, "explore").readSummarize).toBe(false);
		expect(agentByName(agents, "librarian").readSummarize).toBe(false);
		for (const name of ["task", "sonic", "plan", "reviewer", "designer", "critic", "architect"]) {
			expect(agentByName(agents, name).readSummarize).toBeUndefined();
		}
	});
});
