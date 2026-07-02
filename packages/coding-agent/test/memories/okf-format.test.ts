/**
 * OKF (Open Knowledge Format v0.1) contract for jeopi memory documents.
 *
 * jeo-skills' `okf` skill lints knowledge atoms with these rules: a leading
 * `---` fence, a closing fence, and required `type` / `title` / `description`
 * frontmatter fields. jeopi's local memory backend must produce artifacts any
 * OKF consumer can ingest, while prompt-injection read paths must never leak
 * the frontmatter into the model context — and legacy (fenceless) files must
 * keep working.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { Settings } from "jeopi-cli/config/settings";
import { buildMemoryToolDeveloperInstructions, getMemoryRoot, saveLearnedLesson } from "jeopi-cli/memories";
import {
	okfTimestamp,
	parseOkfDocument,
	renderOkfDocument,
	stripOkfFrontmatter,
	validateOkfDocument,
} from "jeopi-cli/memories/okf";
import { removeWithRetries } from "jeopi-utils";

describe("okf document primitives", () => {
	it("renders atoms the jeo okf linter accepts and round-trips the body", () => {
		const body = "# Overview\n\nSome knowledge.\n\n# Schema\n\n| a | b |";
		const doc = renderOkfDocument(
			{
				type: "Memory",
				title: 'Title with "quotes" and: colons',
				description: "One-sentence summary.",
				tags: ["jeopi", "memory"],
				timestamp: okfTimestamp(1_780_000_000),
				extra: { thread_id: "thread-1", updated_at: 1_780_000_000 },
			},
			body,
		);

		expect(validateOkfDocument(doc)).toEqual([]);
		expect(stripOkfFrontmatter(doc).trim()).toBe(body);

		// The frontmatter block is real YAML — parseable by any OKF consumer.
		const { frontmatter } = parseOkfDocument(doc);
		expect(frontmatter).toMatchObject({
			type: "Memory",
			title: 'Title with "quotes" and: colons',
			description: "One-sentence summary.",
			tags: ["jeopi", "memory"],
			thread_id: "thread-1",
			updated_at: 1_780_000_000,
		});
		expect(YAML.parse(doc.split("---")[1])).toBeTruthy();
	});

	it("flags the violations the jeo okf linter reports", () => {
		expect(validateOkfDocument("no frontmatter at all")).toEqual(["missing leading frontmatter fence (---)"]);
		expect(validateOkfDocument("---\ntype: X\nnever closed")).toEqual(["unclosed frontmatter"]);
		expect(validateOkfDocument('---\ntype: "Memory"\n---\nbody')).toEqual([
			"missing required field 'title'",
			"missing required field 'description'",
		]);
	});

	it("is tolerant on strip: fenceless legacy text passes through verbatim", () => {
		const legacy = "just a legacy memory summary\nwith lines";
		expect(stripOkfFrontmatter(legacy)).toBe(legacy);
		expect(parseOkfDocument(legacy).frontmatter).toBeUndefined();
	});
});

describe("learned.md as an OKF atom", () => {
	let tmp: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "okf-learned-"));
		agentDir = path.join(tmp, "agent");
		cwd = path.join(tmp, "proj");
	});
	afterEach(async () => {
		await removeWithRetries(tmp);
	});

	it("writes a valid OKF atom and keeps the prompt path frontmatter-free", async () => {
		await saveLearnedLesson(agentDir, cwd, { content: "Always run the focused test first" });
		await saveLearnedLesson(agentDir, cwd, { content: "Prefer bounded loops", context: "jeo pipeline" });

		const file = path.join(getMemoryRoot(agentDir, cwd), "learned.md");
		const text = await Bun.file(file).text();
		expect(validateOkfDocument(text)).toEqual([]);
		const { frontmatter, body } = parseOkfDocument(text);
		expect(frontmatter).toMatchObject({ type: "Lessons", title: "jeopi Learned Lessons" });
		// Newest-first lesson list survives the OKF wrapper.
		const lines = body.trim().split("\n");
		expect(lines[0]).toContain("Prefer bounded loops");
		expect(lines[1]).toContain("Always run the focused test first");

		// Prompt injection must carry the lessons but never the fence. The
		// instruction builder keys the memory root off settings.getCwd(), so
		// store one lesson under that root too.
		const settings = Settings.isolated({ "memory.backend": "local" });
		await saveLearnedLesson(agentDir, settings.getCwd(), { content: "Prefer bounded loops" });
		const instructions = await buildMemoryToolDeveloperInstructions(agentDir, settings);
		expect(instructions).toBeDefined();
		expect(instructions).toContain("Prefer bounded loops");
		expect(instructions).not.toContain('type: "Lessons"');
		expect(instructions).not.toContain("---");
	});

	it("folds a legacy fenceless learned.md into the OKF atom without losing lessons", async () => {
		const file = path.join(getMemoryRoot(agentDir, cwd), "learned.md");
		await Bun.write(file, "- legacy lesson one\n- legacy lesson two\n");

		await saveLearnedLesson(agentDir, cwd, { content: "new lesson" });

		const text = await Bun.file(file).text();
		expect(validateOkfDocument(text)).toEqual([]);
		const body = stripOkfFrontmatter(text);
		expect(body).toContain("- new lesson");
		expect(body).toContain("- legacy lesson one");
		expect(body).toContain("- legacy lesson two");
	});
});
