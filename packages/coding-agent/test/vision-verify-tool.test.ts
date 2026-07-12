/**
 * Contract: vision_verify parses a structured `{matches, summary, gaps}`
 * verdict out of the model's raw text response and renders it for both the
 * LLM-facing summary and `details`. Malformed responses (non-JSON, or valid
 * JSON with the wrong shape) fail loudly via ToolError rather than silently
 * falling back to a default verdict. When `baseline` is supplied, the request
 * carries two labeled images instead of one.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { completeSimple, Model } from "jeopi-ai";
import { buildModel } from "jeopi-catalog/build";
import { Settings } from "jeopi-cli/config/settings";
import type { ToolSession } from "jeopi-cli/tools";
import { ToolError } from "jeopi-cli/tools/tool-errors";
import { VisionVerifyTool } from "jeopi-cli/tools/vision-verify";
import { removeSyncWithRetries } from "jeopi-utils";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const visionModel: Model<"openai-responses"> = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
	contextWindow: 128000,
	maxTokens: 4096,
});

interface CompleteSimpleStub {
	calls: unknown[][];
	fn: typeof completeSimple;
}

function createSession(cwd: string, model: Model<"openai-responses"> = visionModel): ToolSession {
	const settings = Settings.isolated({ "images.autoResize": false });
	settings.setModelRole("vision", `${model.provider}/${model.id}`);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getModelString: () => `${model.provider}/${model.id}`,
		getActiveModelString: () => `${model.provider}/${model.id}`,
		settings,
		modelRegistry: {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false },
			resolver: () => async () => "test-key",
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
	};
}

function createCompleteSimpleStub(text: string): CompleteSimpleStub {
	const calls: unknown[][] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args);
		return {
			role: "assistant",
			api: visionModel.api,
			provider: visionModel.provider,
			model: visionModel.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			content: [{ type: "text", text }],
		};
	}) as typeof completeSimple;

	return { calls, fn };
}

interface RequestContent {
	messages?: Array<{ content?: unknown }>;
}

function contentParts(
	stub: CompleteSimpleStub,
): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
	const request = stub.calls[0]?.[1] as RequestContent | undefined;
	const content = request?.messages?.[0]?.content;
	return (Array.isArray(content) ? content : []) as Array<{
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
	}>;
}

describe("VisionVerifyTool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vision-verify-"));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	function writeTinyPng(name: string): string {
		const imagePath = path.join(testDir, name);
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
		return imagePath;
	}

	it("returns matches=true with empty gaps for a well-formed matching verdict", async () => {
		const screenshot = writeTinyPng("after.png");
		const stub = createCompleteSimpleStub(
			JSON.stringify({ matches: true, summary: "Save button is disabled as required.", gaps: [] }),
		);
		const tool = new VisionVerifyTool(createSession(testDir), stub.fn);

		const result = await tool.execute("call-1", {
			goal: "Save button disabled until a field changes",
			screenshot,
		});

		expect(result.details?.matches).toBe(true);
		expect(result.details?.gaps).toEqual([]);
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("Matches: yes");
		expect(text).toContain("Save button is disabled as required.");
		expect(text).not.toContain("Gaps:");
	});

	it("renders bulleted gap items and matches=false for a non-matching verdict", async () => {
		const screenshot = writeTinyPng("after.png");
		const stub = createCompleteSimpleStub(
			JSON.stringify({
				matches: false,
				summary: "Header layout regressed.",
				gaps: ["Notification icon missing", "Logo shifted right by 8px"],
			}),
		);
		const tool = new VisionVerifyTool(createSession(testDir), stub.fn);

		const result = await tool.execute("call-2", {
			goal: "Header layout unchanged aside from the new notification icon",
			screenshot,
		});

		expect(result.details?.matches).toBe(false);
		expect(result.details?.gaps).toEqual(["Notification icon missing", "Logo shifted right by 8px"]);
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("Matches: no");
		expect(text).toContain("Gaps:");
		expect(text).toContain("- Notification icon missing");
		expect(text).toContain("- Logo shifted right by 8px");
	});

	it("throws ToolError with the raw response when the model returns non-JSON prose", async () => {
		const screenshot = writeTinyPng("after.png");
		const rawResponse = "I'm sorry, I can't compare screenshots in that format.";
		const stub = createCompleteSimpleStub(rawResponse);
		const tool = new VisionVerifyTool(createSession(testDir), stub.fn);

		let thrown: unknown;
		try {
			await tool.execute("call-3", { goal: "Anything", screenshot });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ToolError);
		expect((thrown as ToolError).message).toContain("not valid JSON");
		expect((thrown as ToolError).message).toContain(rawResponse);
	});

	it("throws ToolError when the response is valid JSON but has the wrong shape", async () => {
		const screenshot = writeTinyPng("after.png");
		const rawResponse = JSON.stringify({ result: "yes" });
		const stub = createCompleteSimpleStub(rawResponse);
		const tool = new VisionVerifyTool(createSession(testDir), stub.fn);

		let thrown: unknown;
		try {
			await tool.execute("call-4", { goal: "Anything", screenshot });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ToolError);
		expect((thrown as ToolError).message).toContain("did not match the expected");
		expect((thrown as ToolError).message).toContain(rawResponse);
	});

	it("sends only the current image (with goal text) when baseline is omitted", async () => {
		const screenshot = writeTinyPng("after.png");
		const stub = createCompleteSimpleStub(JSON.stringify({ matches: true, summary: "ok", gaps: [] }));
		const tool = new VisionVerifyTool(createSession(testDir), stub.fn);

		await tool.execute("call-5", { goal: "Goal text here", screenshot });

		const parts = contentParts(stub);
		const imageParts = parts.filter(p => p.type === "image");
		expect(imageParts).toHaveLength(1);
		expect(parts).toEqual([
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
			{ type: "text", text: "Goal: Goal text here" },
		]);
	});

	it("sends two labeled images (baseline then current) when baseline is provided", async () => {
		const screenshot = writeTinyPng("after.png");
		const baseline = writeTinyPng("before.png");
		const stub = createCompleteSimpleStub(JSON.stringify({ matches: true, summary: "ok", gaps: [] }));
		const tool = new VisionVerifyTool(createSession(testDir), stub.fn);

		await tool.execute("call-6", { goal: "Goal text here", screenshot, baseline });

		const parts = contentParts(stub);
		const imageParts = parts.filter(p => p.type === "image");
		expect(imageParts).toHaveLength(2);
		expect(parts[0]).toEqual({ type: "text", text: "Baseline (prior):" });
		expect(parts[1]?.type).toBe("image");
		expect(parts[2]).toEqual({ type: "text", text: "Current:" });
		expect(parts[3]?.type).toBe("image");
		expect(parts[4]).toEqual({ type: "text", text: "Goal: Goal text here" });
	});
});
