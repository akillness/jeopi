import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "jeopi-agent-core";
import { Settings } from "jeopi-cli/config/settings";
import type { ToolSession } from "jeopi-cli/tools";
import type { ReadToolDetails } from "jeopi-cli/tools/read";
import { ReadTool } from "jeopi-cli/tools/read";
import { removeWithRetries } from "jeopi-utils";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	settings.set("read.summarize.enabled", false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
	};
}

function makeNumberedContent(lines: number): string {
	return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("read tool raw selector range padding", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-raw-range-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("returns exactly the requested line for a single-line raw range, without leading/trailing context", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(50));

		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("call-raw-single", { path: `${filePath}:raw:31-31` }));

		expect(text.trim()).toBe("line 31");
		expect(text).not.toContain("line 30");
		expect(text).not.toContain("line 32");
	});

	it("still pads a non-raw range read with leading/trailing context for the same offsets", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(50));

		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("call-nonraw-single", { path: `${filePath}:31-31` }));

		expect(text).toContain("line 31");
		// Non-raw single-line reads expand with leading/trailing context lines,
		// unlike raw mode where padding would be indistinguishable from content.
		expect(text).toContain("line 30");
	});
});
