import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetActiveSkillsForTests, type Skill } from "jeopi-cli/extensibility/skills";
import { InternalUrlRouter } from "jeopi-cli/internal-urls";

function makeSkill(overrides: Partial<Skill> & { name: string }): Skill {
	const name = overrides.name;
	return {
		name,
		description: overrides.description ?? `Description for ${name}`,
		filePath: overrides.filePath ?? `/skills/${name}/SKILL.md`,
		baseDir: overrides.baseDir ?? `/skills/${name}`,
		source: overrides.source ?? "user",
		...(overrides.hide !== undefined ? { hide: overrides.hide } : {}),
	};
}

describe("SkillProtocolHandler listing, search, and unknown-skill errors", () => {
	beforeEach(() => {
		InternalUrlRouter.resetForTests();
		resetActiveSkillsForTests();
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
		resetActiveSkillsForTests();
	});

	it("lists non-hidden skills alphabetically on skill:// and truncates long descriptions", async () => {
		const longDesc = `${"word ".repeat(35)}tail`;
		const skills: Skill[] = [
			makeSkill({ name: "zeta", description: "Last skill" }),
			makeSkill({ name: "hidden-internal", description: "Should not appear", hide: true }),
			makeSkill({ name: "alpha", description: longDesc }),
			makeSkill({ name: "middle", description: "Middle\n  skill\tdesc" }),
		];

		const router = InternalUrlRouter.instance();
		const res = await router.resolve("skill://", { skills });

		expect(res.contentType).toBe("text/markdown");
		expect(res.content).toContain("# Installed Skills (3)");
		expect(res.content).not.toContain("hidden-internal");

		const skillLines = res.content.split("\n").filter(line => line.startsWith("- "));
		expect(skillLines.map(line => line.slice(2, line.indexOf(":")))).toEqual(["alpha", "middle", "zeta"]);
		expect(skillLines[1]).toBe("- middle: Middle skill desc");
		// Long descriptions are truncated with trailing ellipsis to keep the listing compact.
		expect(skillLines[0]!.endsWith("…")).toBe(true);
		expect(skillLines[0]!.length).toBeLessThan(longDesc.length);
	});

	it("honors limit on skill:// listing and renders empty state cleanly", async () => {
		const skills: Skill[] = [makeSkill({ name: "gamma" }), makeSkill({ name: "alpha" }), makeSkill({ name: "beta" })];

		const router = InternalUrlRouter.instance();
		const limited = await router.resolve("skill://?limit=2", { skills });
		expect(limited.content).toContain("# Installed Skills (showing 2 of 3)");
		const lines = limited.content.split("\n").filter(line => line.startsWith("- "));
		expect(lines.map(line => line.slice(2, line.indexOf(":")))).toEqual(["alpha", "beta"]);

		const empty = await router.resolve("skill://", { skills: [] });
		expect(empty.content).toContain("# Installed Skills (0)");
		expect(empty.content).toContain("_No skills installed._");
	});

	it("ranks name matches above description matches on skill://?q= and honors limit", async () => {
		const skills: Skill[] = [
			makeSkill({
				name: "ops-helper",
				description: "Run docker containers and deploy services",
			}),
			makeSkill({
				name: "cloud-deploy",
				description: "General cloud release helpers",
			}),
			makeSkill({
				name: "deploy-fast",
				description: "Fast release pipeline",
			}),
			makeSkill({
				name: "deploy",
				description: "Primary deployment workflow",
			}),
			makeSkill({
				name: "unrelated",
				description: "Database schema formatting",
			}),
			makeSkill({
				name: "hidden-deploy",
				description: "Hidden deploy skill",
				hide: true,
			}),
		];

		const router = InternalUrlRouter.instance();
		const full = await router.resolve("skill://?q=deploy", { skills });
		expect(full.contentType).toBe("text/markdown");
		expect(full.content).toContain('# Skills matching "deploy" (4 matches)');
		expect(full.content).not.toContain("unrelated");
		expect(full.content).not.toContain("hidden-deploy");

		const rankedNames = full.content
			.split("\n")
			.filter(line => line.startsWith("- "))
			.map(line => line.slice(2, line.indexOf(":")));
		// Exact name ("deploy") > prefix ("deploy-fast") > substring ("cloud-deploy") > description-only ("ops-helper")
		expect(rankedNames).toEqual(["deploy", "deploy-fast", "cloud-deploy", "ops-helper"]);

		const limited = await router.resolve("skill://?q=deploy&limit=2", { skills });
		expect(limited.content).toContain('# Skills matching "deploy" (showing 2 of 4 matches)');
		const limitedNames = limited.content
			.split("\n")
			.filter(line => line.startsWith("- "))
			.map(line => line.slice(2, line.indexOf(":")));
		expect(limitedNames).toEqual(["deploy", "deploy-fast"]);
	});

	it("allows exact-name lookup of hidden skills via query and reports zero matches clearly", async () => {
		const skills: Skill[] = [
			makeSkill({ name: "secret-tool", description: "Internal hidden workflow", hide: true }),
			makeSkill({ name: "public-tool", description: "Regular workflow" }),
		];

		const router = InternalUrlRouter.instance();
		const exactHidden = await router.resolve("skill://?q=secret-tool", { skills });
		expect(exactHidden.content).toContain("- secret-tool: Internal hidden workflow");

		const noMatch = await router.resolve("skill://?q=nonexistent-topic", { skills });
		expect(noMatch.content).toContain('# Skills matching "nonexistent-topic" (0 matches)');
		expect(noMatch.content).toContain("skill://");
	});

	it("throws on unknown skill and truncates huge available skill lists cleanly", async () => {
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("skill://missing", { skills: [] })).rejects.toThrow(
			"Unknown skill: missing\nAvailable: none",
		);

		const smallList: Skill[] = [makeSkill({ name: "alpha" }), makeSkill({ name: "beta" })];
		await expect(router.resolve("skill://missing", { skills: smallList })).rejects.toThrow(
			"Unknown skill: missing\nAvailable: alpha, beta",
		);

		const hugeList: Skill[] = Array.from({ length: 60 }, (_, index) =>
			makeSkill({ name: `skill-${String(index).padStart(2, "0")}` }),
		);
		let caughtError: Error | undefined;
		try {
			await router.resolve("skill://missing", { skills: hugeList });
		} catch (error) {
			caughtError = error as Error;
		}
		expect(caughtError).toBeDefined();
		expect(caughtError!.message).toContain("Unknown skill: missing");
		expect(caughtError!.message).toContain("skill-00");
		expect(caughtError!.message).toContain("skill-29");
		expect(caughtError!.message).not.toContain("skill-30");
		expect(caughtError!.message).not.toContain("skill-59");
		expect(caughtError!.message).toContain("(60 total; read skill://?q=<query> to search)");
	});
});
