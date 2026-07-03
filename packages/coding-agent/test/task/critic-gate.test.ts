import { describe, expect, it } from "bun:test";
import {
	CRITIC_GATE_MAX_STRIKES,
	criticGateWriteMessage,
	evaluateCriticGateSpawn,
	GATED_PLAN_LOCAL_URL,
	hashPlanContent,
	parseCriticVerdict,
	planIntegrityMismatchMessage,
	updateCriticGateState,
} from "jeopi-cli/task/critic-gate";

describe("hashPlanContent", () => {
	it("is deterministic for identical content", () => {
		expect(hashPlanContent("# Plan\nDo the thing.")).toBe(hashPlanContent("# Plan\nDo the thing."));
	});

	it("differs for different content", () => {
		expect(hashPlanContent("# Plan A")).not.toBe(hashPlanContent("# Plan B"));
	});

	it("returns a 64-char lowercase hex sha256 digest", () => {
		expect(hashPlanContent("anything")).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("planIntegrityMismatchMessage", () => {
	it("names the gated plan path and the approving critic", () => {
		const message = planIntegrityMismatchMessage({ hash: "abc123", agentId: "critic-42", at: 0 });
		expect(message).toContain(GATED_PLAN_LOCAL_URL);
		expect(message).toContain("critic-42");
		expect(message).toContain("Re-submit the current plan to a fresh `critic`");
	});
});

describe("updateCriticGateState", () => {
	it("clears the gate on an okay verdict", () => {
		const previous = { verdict: "iterate" as const, agentId: "critic-1", at: 0, requiredFixes: [], strikes: 2 };
		expect(updateCriticGateState(previous, { verdict: "okay", requiredFixes: [] }, "critic-2")).toBeUndefined();
	});

	it("engages the gate and increments strikes on a non-okay verdict", () => {
		const first = updateCriticGateState(undefined, { verdict: "iterate", requiredFixes: ["fix a"] }, "critic-1", 100);
		expect(first).toMatchObject({ verdict: "iterate", agentId: "critic-1", at: 100, strikes: 1 });

		const second = updateCriticGateState(first, { verdict: "reject", requiredFixes: [] }, "critic-2", 200);
		expect(second).toMatchObject({ verdict: "reject", agentId: "critic-2", at: 200, strikes: 2 });
	});
});

describe("evaluateCriticGateSpawn", () => {
	const engaged = { verdict: "iterate" as const, agentId: "critic-1", at: 0, requiredFixes: ["fix a"], strikes: 1 };

	it("allows any spawn when the gate is not engaged", () => {
		expect(evaluateCriticGateSpawn(undefined, "task", false)).toBeUndefined();
	});

	it("blocks a non-read-only spawn while the gate is engaged", () => {
		const rejection = evaluateCriticGateSpawn(engaged, "task", false);
		expect(rejection).toContain('Spawning non-read-only agent "task" is blocked by the runtime');
		expect(rejection).toContain("fix a");
	});

	it("allows a read-only spawn while the gate is engaged", () => {
		expect(evaluateCriticGateSpawn(engaged, "plan", true)).toBeUndefined();
	});

	it("refuses even a fresh critic run once the strike budget is exhausted", () => {
		const exhausted = { ...engaged, strikes: CRITIC_GATE_MAX_STRIKES };
		const rejection = evaluateCriticGateSpawn(exhausted, "critic", true);
		expect(rejection).toContain("the iterate loop is closed");
		expect(rejection).toContain("Do NOT re-submit to critic");
	});

	it("still allows a critic run below the strike budget", () => {
		expect(evaluateCriticGateSpawn(engaged, "critic", true)).toBeUndefined();
	});
});

describe("criticGateWriteMessage", () => {
	it("explains the working tree lock and how to clear it", () => {
		const message = criticGateWriteMessage({
			verdict: "reject",
			agentId: "critic-9",
			at: 0,
			requiredFixes: [],
			strikes: 1,
		});
		expect(message).toContain("critic-9");
		expect(message).toContain("working tree is locked");
	});
});

describe("parseCriticVerdict", () => {
	it("parses a well-formed verdict payload", () => {
		expect(
			parseCriticVerdict(JSON.stringify({ verdict: "okay", required_fixes: [], summary: "looks good" })),
		).toEqual({ verdict: "okay", requiredFixes: [], summary: "looks good" });
	});

	it("filters non-string entries out of required_fixes", () => {
		expect(
			parseCriticVerdict(JSON.stringify({ verdict: "iterate", required_fixes: ["real fix", 42, null] })),
		).toEqual({ verdict: "iterate", requiredFixes: ["real fix"], summary: undefined });
	});

	it("returns undefined for non-JSON, non-object, or non-critic-shaped payloads", () => {
		expect(parseCriticVerdict("not json")).toBeUndefined();
		expect(parseCriticVerdict("null")).toBeUndefined();
		expect(parseCriticVerdict(JSON.stringify({ verdict: "maybe" }))).toBeUndefined();
		expect(parseCriticVerdict(JSON.stringify({ notVerdict: true }))).toBeUndefined();
	});
});
