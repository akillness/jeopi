import { describe, expect, it } from "bun:test";
import { shouldAutoApprovePlan } from "./approved-plan";

describe("shouldAutoApprovePlan — plan-gate autonomy boundary", () => {
	it("auto-approves an existing plan when plan.autoApprove is enabled", () => {
		expect(shouldAutoApprovePlan({ autoApprove: true, planExists: true })).toBe(true);
	});

	it("keeps the human plan-review gate when auto-approve is disabled", () => {
		expect(shouldAutoApprovePlan({ autoApprove: false, planExists: true })).toBe(false);
	});

	it("never auto-approves a missing/empty plan even under Full Auto", () => {
		expect(shouldAutoApprovePlan({ autoApprove: true, planExists: false })).toBe(false);
	});
});
