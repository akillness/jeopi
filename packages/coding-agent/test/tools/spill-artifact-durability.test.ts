import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type AgentTool, type AgentToolContext, type AgentToolResult } from "jeopi-agent-core";
import { type } from "arktype";
import { Settings } from "jeopi-cli/config/settings";
import { ArtifactProtocolHandler } from "jeopi-cli/internal-urls/artifact-protocol";
import { registerArtifactsDir, resetRegisteredArtifactDirsForTests } from "jeopi-cli/internal-urls/registry-helpers";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { type OutputMeta, wrapToolWithMetaNotice } from "jeopi-cli/tools/output-meta";
import { TempDir } from "jeopi-utils";

function makeWrappedTool(
	name: string,
	executeImpl: () => Promise<AgentToolResult>,
): AgentTool {
	return wrapToolWithMetaNotice({
		name,
		label: name,
		description: `test ${name}`,
		parameters: type("object"),
		execute: executeImpl,
	} as unknown as AgentTool);
}

function createSpillContext(sessionManager: SessionManager): AgentToolContext {
	return {
		sessionManager,
		settings: Settings.isolated({
			"tools.artifactSpillThreshold": 1,
			"tools.artifactHeadBytes": 1,
			"tools.artifactTailBytes": 1,
			"tools.artifactTailLines": 5,
		}),
		modelRegistry: {} as never,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	} as unknown as AgentToolContext;
}

function textOf(result: AgentToolResult): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

describe("spillLargeResultToArtifact durability", () => {
	let tempDir: TempDir;
	let sessionManager: SessionManager;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-spill-");
		resetRegisteredArtifactDirsForTests();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const artifactsDir = sessionManager.getArtifactsDir();
		if (artifactsDir) registerArtifactsDir(artifactsDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetRegisteredArtifactDirsForTests();
		await sessionManager.close();
		await tempDir.remove();
	});

	it("spills oversized output only after durable write/readback and resolves via artifact://", async () => {
		const big = Array.from({ length: 400 }, (_, i) => `spill line ${i} é payload`).join("\n");
		const tool = makeWrappedTool("custom_dump", async () => ({
			content: [{ type: "text", text: big }],
		}));

		const result = await tool.execute("call-durable", {}, undefined, undefined, createSpillContext(sessionManager));
		const text = textOf(result);
		const meta = (result.details as { meta?: OutputMeta } | undefined)?.meta;

		expect(Buffer.byteLength(text)).toBeLessThan(Buffer.byteLength(big));
		expect(meta?.truncation?.artifactId).toBeDefined();
		expect(text).toContain(`artifact://${meta!.truncation!.artifactId}`);

		const resolved = await new ArtifactProtocolHandler().resolve(
			new URL(`artifact://${meta!.truncation!.artifactId}`) as never,
		);
		expect(resolved.content).toBe(big);
	});

	it("leaves oversized output untouched when saveArtifact throws, returns undefined, or fails readback", async () => {
		const big = Array.from({ length: 400 }, (_, i) => `must-keep-line-${i} é`).join("\n");
		const tool = makeWrappedTool("custom_dump", async () => ({
			content: [{ type: "text", text: big }],
		}));

		// Case 1: saveArtifact throws
		vi.spyOn(sessionManager, "saveArtifact").mockRejectedValueOnce(new Error("disk full"));
		const onThrow = await tool.execute("call-throw", {}, undefined, undefined, createSpillContext(sessionManager));
		expect(textOf(onThrow)).toBe(big);
		expect((onThrow.details as { meta?: OutputMeta } | undefined)?.meta?.truncation).toBeUndefined();
		expect(textOf(onThrow)).not.toContain("artifact://");

		// Case 2: saveArtifact returns undefined
		vi.spyOn(sessionManager, "saveArtifact").mockResolvedValueOnce(undefined);
		const onUndef = await tool.execute("call-undef", {}, undefined, undefined, createSpillContext(sessionManager));
		expect(textOf(onUndef)).toBe(big);
		expect((onUndef.details as { meta?: OutputMeta } | undefined)?.meta?.truncation).toBeUndefined();

		// Case 3: missing readback (id returned, no file on disk)
		vi.spyOn(sessionManager, "saveArtifact").mockResolvedValueOnce("999999999");
		const onMissing = await tool.execute("call-missing", {}, undefined, undefined, createSpillContext(sessionManager));
		expect(textOf(onMissing)).toBe(big);
		expect((onMissing.details as { meta?: OutputMeta } | undefined)?.meta?.truncation).toBeUndefined();

		// Case 4: corrupted/mismatched readback on disk
		const origSave = sessionManager.saveArtifact.bind(sessionManager);
		vi.spyOn(sessionManager, "saveArtifact").mockImplementationOnce(async (content, toolType) => {
			const id = await origSave(content, toolType);
			if (id) {
				const artifactPath = await sessionManager.getArtifactPath(id);
				if (artifactPath) await Bun.write(artifactPath, "CORRUPTED");
			}
			return id;
		});
		const onCorrupt = await tool.execute("call-corrupt", {}, undefined, undefined, createSpillContext(sessionManager));
		expect(textOf(onCorrupt)).toBe(big);
		expect((onCorrupt.details as { meta?: OutputMeta } | undefined)?.meta?.truncation).toBeUndefined();
	});

	it("preserves error results, aborted results, and mixed image blocks without truncating away evidence", async () => {
		const bigErr = Array.from({ length: 300 }, (_, i) => `error stack line ${i}`).join("\n");
		const errTool = makeWrappedTool("custom_err", async () => ({
			content: [{ type: "text", text: bigErr }],
			isError: true,
		}));
		const errResult = await errTool.execute("call-err", {}, undefined, undefined, createSpillContext(sessionManager));
		expect(errResult.isError).toBe(true);
		expect(textOf(errResult)).toBe(bigErr);
		expect((errResult.details as { meta?: OutputMeta } | undefined)?.meta?.truncation).toBeUndefined();

		const bigAborted = Array.from({ length: 300 }, (_, i) => `aborted trace line ${i}`).join("\n");
		const abortTool = makeWrappedTool("custom_abort", async () => ({
			content: [{ type: "text", text: bigAborted }],
			details: { aborted: true },
		}));
		const abortResult = await abortTool.execute(
			"call-abort",
			{},
			undefined,
			undefined,
			createSpillContext(sessionManager),
		);
		expect(textOf(abortResult)).toBe(bigAborted);
		expect((abortResult.details as { meta?: OutputMeta } | undefined)?.meta?.truncation).toBeUndefined();

		const bigImgText = Array.from({ length: 300 }, (_, i) => `image caption line ${i}`).join("\n");
		const mixedTool = makeWrappedTool("custom_img", async () => ({
			content: [
				{ type: "text", text: bigImgText },
				{ type: "image", data: "iVBORw0KGgo", mimeType: "image/png" },
			],
		}));
		vi.spyOn(sessionManager, "saveArtifact").mockRejectedValueOnce(new Error("disk full"));
		const mixedResult = await mixedTool.execute(
			"call-img",
			{},
			undefined,
			undefined,
			createSpillContext(sessionManager),
		);
		expect(textOf(mixedResult)).toBe(bigImgText);
		expect(mixedResult.content.some(b => b.type === "image" && b.data === "iVBORw0KGgo")).toBe(true);
	});
});
