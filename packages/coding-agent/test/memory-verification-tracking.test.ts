import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "jeopi-cli/config/settings";
import { getMemoryRoot, saveLearnedLesson } from "jeopi-cli/memories";
import { stripOkfFrontmatter } from "jeopi-cli/memories/okf";
import { localBackend } from "jeopi-cli/memory-backend/local-backend";
import type { ToolSession } from "jeopi-cli/tools";
import { LearnTool } from "jeopi-cli/tools/learn";
import { removeWithRetries } from "jeopi-utils";

/**
 * Verification-tracking contract: `learn`-tool lessons carry a `[VERIFIED]`/
 * `[UNVERIFIED]` tag (and, when verified, the evidence that established it),
 * and `localBackend.stats()` reports counts/coverage derived from those tags.
 */
describe("memory verification tracking (local backend)", () => {
	let tmp: string;
	let agentDir: string;
	let projCwd: string;
	let learnedFile: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-verify-track-"));
		agentDir = path.join(tmp, "agent");
		projCwd = path.join(tmp, "proj");
		learnedFile = path.join(getMemoryRoot(agentDir, projCwd), "learned.md");
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmp);
	});

	function localSession(): ToolSession {
		const settings = Settings.isolated({ "autolearn.enabled": true, "memory.backend": "local" });
		spyOn(settings, "getAgentDir").mockReturnValue(agentDir);
		spyOn(settings, "getCwd").mockReturnValue(projCwd);
		return {
			cwd: projCwd,
			hasUI: false,
			skipPythonPreflight: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		};
	}

	it("tags a verified lesson with [VERIFIED] and inlines the evidence", async () => {
		const result = await saveLearnedLesson(agentDir, projCwd, {
			content: "X",
			verified: true,
			evidence: "ran npm test",
		});
		expect(result.stored).toBe(1);
		const line = stripOkfFrontmatter(await Bun.file(learnedFile).text()).trim();
		expect(line).toBe("- [VERIFIED] X _(evidence: ran npm test)_");
	});

	it("tags an unverified lesson with [UNVERIFIED] and adds no evidence annotation", async () => {
		const result = await saveLearnedLesson(agentDir, projCwd, { content: "Y" });
		expect(result.stored).toBe(1);
		const line = stripOkfFrontmatter(await Bun.file(learnedFile).text()).trim();
		expect(line).toBe("- [UNVERIFIED] Y");
		expect(line).not.toContain("evidence");
	});

	it("ignores evidence on an unverified lesson (evidence is only meaningful when verified is true)", async () => {
		const result = await saveLearnedLesson(agentDir, projCwd, {
			content: "Z",
			evidence: "should be ignored",
		});
		expect(result.stored).toBe(1);
		const line = stripOkfFrontmatter(await Bun.file(learnedFile).text()).trim();
		expect(line).toBe("- [UNVERIFIED] Z");
		expect(line).not.toContain("should be ignored");
	});

	it("LearnTool.execute() with verified+evidence params produces a [VERIFIED] tagged line", async () => {
		await new LearnTool(localSession()).execute("1", {
			memory: "Tool-verified lesson",
			verified: true,
			evidence: "grepped the source",
		});
		const line = stripOkfFrontmatter(await Bun.file(learnedFile).text()).trim();
		expect(line).toBe("- [VERIFIED] Tool-verified lesson _(evidence: grepped the source)_");
	});

	it("stats() reports total/verified/unverified counts and matching coverage percentage", async () => {
		await saveLearnedLesson(agentDir, projCwd, { content: "V1", verified: true, evidence: "e1" });
		await saveLearnedLesson(agentDir, projCwd, { content: "V2", verified: true, evidence: "e2" });
		await saveLearnedLesson(agentDir, projCwd, { content: "U1" });
		await saveLearnedLesson(agentDir, projCwd, { content: "U2" });
		await saveLearnedLesson(agentDir, projCwd, { content: "U3" });

		const report = await localBackend.stats?.(agentDir, projCwd);
		expect(report).toBeDefined();
		const text = report as string;
		expect(text).toContain("- Lessons: 5");
		expect(text).toContain("- Verified: 2");
		expect(text).toContain("- Unverified: 3");
		// 2/5 = 40.0%
		expect(text).toContain("- Verification coverage: 40.0%");
	});

	it("stats() with no lessons written reports zero counts and N/A coverage", async () => {
		const report = await localBackend.stats?.(agentDir, projCwd);
		expect(report).toBeDefined();
		const text = report as string;
		expect(text).toContain("- Lessons: 0");
		expect(text).toContain("- Verified: 0");
		expect(text).toContain("- Unverified: 0");
		expect(text).toContain("- Verification coverage: N/A");
	});
});
