import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "jeopi-cli/extensibility/skills";
import { buildSystemPrompt, selectPromptSkills } from "jeopi-cli/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

function makeSkill(overrides: Partial<Skill> & { name: string }): Skill {
	const name = overrides.name;
	return {
		name,
		description: overrides.description ?? `Description for ${name}`,
		filePath: overrides.filePath ?? `/skills/${name}/SKILL.md`,
		baseDir: overrides.baseDir ?? `/skills/${name}`,
		source: overrides.source ?? "user",
		...(overrides.hide !== undefined ? { hide: overrides.hide } : {}),
		...(overrides._source !== undefined ? { _source: overrides._source } : {}),
	};
}

describe("selectPromptSkills", () => {
	it("returns an empty selection for an empty skill list", () => {
		expect(selectPromptSkills([], { maxSkills: 5, maxChars: 1000 })).toEqual({
			included: [],
			omittedCount: 0,
			totalCount: 0,
		});
	});

	it("prioritizes project-scoped skills ahead of user skills and sorts alphabetically within each tier", () => {
		const skills: Skill[] = [
			makeSkill({ name: "zeta-user", source: "user" }),
			makeSkill({
				name: "beta-project-meta",
				source: "custom",
				_source: { provider: "custom", providerName: "Custom", path: "/p", level: "project" },
			}),
			makeSkill({ name: "alpha-user", source: "user" }),
			makeSkill({ name: "gamma-project-suffix", source: "claude:project" }),
			makeSkill({ name: "alpha-project-direct", source: "project" }),
		];

		const result = selectPromptSkills(skills, { maxSkills: 10, maxChars: 10_000 });
		expect(result.totalCount).toBe(5);
		expect(result.omittedCount).toBe(0);
		expect(result.included.map(entry => entry.name)).toEqual([
			"alpha-project-direct",
			"beta-project-meta",
			"gamma-project-suffix",
			"alpha-user",
			"zeta-user",
		]);
	});

	it("normalizes whitespace and truncates long descriptions to maxDescriptionChars", () => {
		const longDesc = "Line one\n\n  with   irregular\tspacing and plenty of trailing detail for testing truncation";
		const skills: Skill[] = [
			makeSkill({ name: "alpha", description: longDesc }),
			makeSkill({ name: "beta", description: "Short desc" }),
		];

		const bounded = selectPromptSkills(skills, {
			maxSkills: 10,
			maxChars: 10_000,
			maxDescriptionChars: 24,
		});
		expect(bounded.included[0]).toEqual({
			name: "alpha",
			description: "Line one with irregular…",
		});
		expect(bounded.included[0]!.description.length).toBeLessThanOrEqual(24);
		expect(bounded.included[1]).toEqual({
			name: "beta",
			description: "Short desc",
		});

		const singleChar = selectPromptSkills([skills[0]!], {
			maxSkills: 10,
			maxChars: 10_000,
			maxDescriptionChars: 1,
		});
		expect(singleChar.included[0]!.description).toBe("…");

		const unlimitedDesc = selectPromptSkills([skills[0]!], {
			maxSkills: 10,
			maxChars: 10_000,
			maxDescriptionChars: 0,
		});
		expect(unlimitedDesc.included[0]!.description).toBe(longDesc.replace(/\s+/g, " ").trim());
	});

	it("caps selection by maxSkills while preserving priority order and accurate counts", () => {
		const skills: Skill[] = [
			makeSkill({ name: "u-one", source: "user" }),
			makeSkill({ name: "p-two", source: "project" }),
			makeSkill({ name: "u-two", source: "user" }),
			makeSkill({ name: "p-one", source: "project" }),
			makeSkill({ name: "u-three", source: "user" }),
		];

		const result = selectPromptSkills(skills, { maxSkills: 3, maxChars: 10_000 });
		expect(result.included.map(entry => entry.name)).toEqual(["p-one", "p-two", "u-one"]);
		expect(result.omittedCount).toBe(2);
		expect(result.totalCount).toBe(5);
	});

	it("caps selection by maxChars using rendered line length", () => {
		// Rendered line format: `- ${name}: ${description}\n` => name.length + description.length + 5
		const skills: Skill[] = [
			makeSkill({ name: "a", description: "1234567890" }), // 1 + 10 + 5 = 16 chars
			makeSkill({ name: "b", description: "1234567890" }), // 16 chars (total 32)
			makeSkill({ name: "c", description: "1234567890" }), // 16 chars (total 48 > 35)
		];

		const result = selectPromptSkills(skills, { maxSkills: 10, maxChars: 35 });
		expect(result.included.map(entry => entry.name)).toEqual(["a", "b"]);
		expect(result.omittedCount).toBe(1);
		expect(result.totalCount).toBe(3);

		// When budget cannot fit even the first skill, include zero and omit all.
		const tooSmall = selectPromptSkills(skills, { maxSkills: 10, maxChars: 10 });
		expect(tooSmall.included).toEqual([]);
		expect(tooSmall.omittedCount).toBe(3);
		expect(tooSmall.totalCount).toBe(3);
	});

	it("treats maxSkills: 0 and maxChars: 0 as unlimited", () => {
		const skills: Skill[] = Array.from({ length: 65 }, (_, index) =>
			makeSkill({
				name: `skill-${String(index).padStart(2, "0")}`,
				description: "x".repeat(300),
				source: "user",
			}),
		);

		const result = selectPromptSkills(skills, { maxSkills: 0, maxChars: 0, maxDescriptionChars: 0 });
		expect(result.included).toHaveLength(65);
		expect(result.omittedCount).toBe(0);
		expect(result.totalCount).toBe(65);
		expect(result.included[0]!.description).toHaveLength(300);
	});
});

describe("buildSystemPrompt bounded skills rendering", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-skills-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-skills-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("renders bounded <skills> with project priority, excludes hidden skills, and shows omission notice", async () => {
		const skills: Skill[] = [
			makeSkill({ name: "user-zeta", description: "User zeta skill", source: "user" }),
			makeSkill({ name: "proj-alpha", description: "Project alpha skill", source: "project" }),
			makeSkill({ name: "user-beta", description: "User beta skill", source: "user" }),
			makeSkill({ name: "user-gamma", description: "User gamma skill", source: "user" }),
			makeSkill({ name: "secret-hidden", description: "Hidden skill", source: "project", hide: true }),
		];

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			rules: [],
			toolNames: ["read"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			skills,
			skillsSettings: { maxPromptSkills: 2, maxPromptChars: 10_000 },
		});
		const rendered = systemPrompt.join("\n\n");

		expect(rendered).toContain("<skills>");
		expect(rendered).toContain("- proj-alpha: Project alpha skill");
		expect(rendered).toContain("- user-beta: User beta skill");
		expect(rendered).not.toContain("- user-gamma:");
		expect(rendered).not.toContain("- user-zeta:");
		expect(rendered).not.toContain("secret-hidden");
		// 4 visible skills total, 2 included => 2 more skills installed
		expect(rendered).toContain("2 more skills installed");
		expect(rendered).toContain("skill://?q=<keywords>");
	});

	it("omits the discovery notice when all visible skills fit within budget", async () => {
		const skills: Skill[] = [
			makeSkill({ name: "alpha", description: "Alpha skill" }),
			makeSkill({ name: "beta", description: "Beta skill" }),
		];

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			rules: [],
			toolNames: ["read"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			skills,
			skillsSettings: { maxPromptSkills: 10, maxPromptChars: 10_000 },
		});
		const rendered = systemPrompt.join("\n\n");

		expect(rendered).toContain("<skills>");
		expect(rendered).toContain("- alpha: Alpha skill");
		expect(rendered).toContain("- beta: Beta skill");
		expect(rendered).not.toContain("more skills installed");
	});

	it("renders the discovery-only notice without <skills> when char budget fits zero skills", async () => {
		const skills: Skill[] = [
			makeSkill({ name: "alpha", description: "Alpha skill description" }),
			makeSkill({ name: "beta", description: "Beta skill description" }),
		];

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			rules: [],
			toolNames: ["read"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			skills,
			skillsSettings: { maxPromptSkills: 10, maxPromptChars: 5 },
		});
		const rendered = systemPrompt.join("\n\n");

		expect(rendered).not.toContain("<skills>");
		expect(rendered).toContain("2 skills installed");
		expect(rendered).toContain("skill://?q=<keywords>");
	});
});
