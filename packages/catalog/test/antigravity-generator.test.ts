import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelSpec } from "jeopi-catalog/types";

const packageRoot = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const endpoint = "https://daily-cloudcode-pa.googleapis.com";

const previousModel: ModelSpec<"google-gemini-cli"> = {
	id: "retired-generator-model",
	name: "Retired Generator Model",
	provider: "google-antigravity",
	api: "google-gemini-cli",
	baseUrl: endpoint,
	reasoning: false,
	input: ["text"],
	cost: { input: 2, output: 7, cacheRead: 1, cacheWrite: 3 },
	contextWindow: 81_000,
	maxTokens: 9_000,
};
const { reasoning, input, cost, contextWindow, maxTokens } = previousModel;
const unrelatedModel: ModelSpec<"openai-responses"> = {
	id: "untouched-generator-model",
	name: "Unrelated Prior Model",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://unrelated.invalid/v1",
	reasoning,
	input,
	cost,
	contextWindow,
	maxTokens,
};
const previous = {
	"google-antigravity": { [previousModel.id]: previousModel },
	openai: { [unrelatedModel.id]: unrelatedModel },
};

// All mocks live in a disposable subprocess. The production CLI and discovery,
// parsing, policy, merge, and serialization paths run unchanged on copied files.
const preload = `
import { mock, spyOn } from "bun:test";
const scenario = process.env.GENERATOR_SCENARIO;
mock.module("jeopi-ai/auth-broker/discover", () => ({
	discoverAuthStorage: async () => ({
		getOAuthAccess: async provider => {
			if (provider !== "google-antigravity") throw new Error("Unexpected auth provider: " + provider);
			return { accessToken: "isolated-test-token" };
		},
		close() {},
	}),
}));
spyOn(globalThis, "fetch").mockImplementation(async input => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	if (url === "https://models.dev/api.json") {
		return Response.json({ openai: { models: { "upstream-unrelated-model": {
			name: "Must Not Replace Unrelated Slice", tool_call: true,
			limit: { context: 70000, output: 7000 },
		} } } });
	}
	if (url === "${endpoint}/v1internal:fetchAvailableModels") {
		if (scenario === "failure") return new Response("Discovery unavailable", { status: 503 });
		return Response.json({ models: scenario === "empty" ? {} : {
			"future-generator-model-2099": {
				displayName: "Future Generator Model",
				supportsImages: true,
				supportsThinking: true,
				maxTokens: 321000,
				maxOutputTokens: 19000,
			},
		} });
	}
	throw new Error("Unexpected network request blocked: " + url);
});
`;

async function generate(scenario: "current" | "empty" | "failure") {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeopi-antigravity-generator-"));
	try {
		await Promise.all([
			fs.cp(path.join(packageRoot, "src"), path.join(tempDir, "src"), { recursive: true }),
			fs.cp(path.join(packageRoot, "scripts"), path.join(tempDir, "scripts"), { recursive: true }),
			fs.symlink(path.join(repoRoot, "node_modules"), path.join(tempDir, "node_modules")),
		]);
		const outputPath = path.join(tempDir, "src/models.json");
		await fs.writeFile(outputPath, JSON.stringify(previous));
		const preloadPath = path.join(tempDir, "preload.ts");
		await fs.writeFile(preloadPath, preload);
		const child = Bun.spawn(
			[
				process.execPath,
				"--preload",
				preloadPath,
				path.join(tempDir, "scripts/generate-models.ts"),
				"--provider",
				"google-antigravity",
			],
			{
				cwd: tempDir,
				env: { PATH: process.env.PATH, HOME: tempDir, XDG_CONFIG_HOME: tempDir, GENERATOR_SCENARIO: scenario },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0 || !stdout.includes("Generated src/models.json")) {
			throw new Error(`Generator did not complete (${exitCode}):\n${stdout}\n${stderr}`);
		}
		if (stderr.includes("Unexpected network request blocked") || stderr.includes("Unexpected auth provider")) {
			throw new Error(`Scoped generator crossed an unexpected external boundary:\n${stderr}`);
		}
		return JSON.parse(await fs.readFile(outputPath, "utf8")) as Record<string, Record<string, ModelSpec>>;
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

describe("provider-scoped Antigravity catalog generation", () => {
	it.each(["current", "empty", "failure"] as const)(
		"publishes the %s discovery outcome without changing unrelated providers",
		async scenario => {
			const catalog = await generate(scenario);
			expect(Object.keys(catalog).sort()).toEqual(["google-antigravity", "openai"]);
			expect(catalog.openai).toEqual(previous.openai);
			const selected = catalog["google-antigravity"];
			if (scenario === "empty") {
				expect(selected).toEqual({});
			} else if (scenario === "failure") {
				expect(Object.keys(selected)).toEqual([previousModel.id]);
				expect(selected[previousModel.id]).toMatchObject(previousModel);
			} else {
				expect(Object.keys(selected)).toEqual(["future-generator-model-2099"]);
				expect(selected["future-generator-model-2099"]).toMatchObject({
					id: "future-generator-model-2099",
					name: "Future Generator Model",
					provider: "google-antigravity",
					api: "google-gemini-cli",
					baseUrl: endpoint,
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 321_000,
					maxTokens: 19_000,
				});
			}
		},
	);
});
