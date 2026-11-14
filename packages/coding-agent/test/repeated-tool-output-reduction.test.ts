import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "jeopi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "jeopi-ai";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { ArtifactProtocolHandler } from "jeopi-cli/internal-urls/artifact-protocol";
import { registerArtifactsDir, resetRegisteredArtifactDirsForTests } from "jeopi-cli/internal-urls/registry-helpers";
import { AgentSession } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { TempDir } from "jeopi-utils";

const usage = {
	input: 16,
	output: 8,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 24,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("AgentSession repeated tool output reduction", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessionManager: SessionManager;
	let session: AgentSession;
	let apiInfo: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; model: string };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-repeated-reduce-");
		resetRegisteredArtifactDirsForTests();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const artifactsDir = sessionManager.getArtifactsDir();
		if (artifactsDir) registerArtifactsDir(artifactsDir);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		apiInfo = { api: model.api, provider: model.provider, model: model.id };

		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		resetRegisteredArtifactDirsForTests();
		await tempDir.remove();
		vi.restoreAllMocks();
	});

	function appendToolTurn(opts: {
		toolName: string;
		args: Record<string, unknown>;
		text: string;
		isError?: boolean;
		details?: Record<string, unknown>;
		stopReason?: AssistantMessage["stopReason"];
		extraContent?: ToolResultMessage["content"];
		timestamp?: number;
	}): string {
		const callId = `call_${opts.toolName}_${Math.random().toString(36).slice(2)}`;
		const ts = opts.timestamp ?? Date.now();
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `run ${opts.toolName}` }],
			timestamp: ts - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: opts.toolName, arguments: opts.args }],
			...apiInfo,
			stopReason: opts.stopReason ?? "toolUse",
			usage,
			timestamp: ts - 1,
		});
		const content: ToolResultMessage["content"] = [{ type: "text", text: opts.text }, ...(opts.extraContent ?? [])];
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: callId,
			toolName: opts.toolName,
			content,
			isError: opts.isError ?? false,
			details: opts.details,
			timestamp: ts,
		});
		return callId;
	}

	function branchToolResults(): ToolResultMessage[] {
		const results: ToolResultMessage[] = [];
		for (const entry of sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				results.push(entry.message);
			}
		}
		return results;
	}

	async function invokeReduceRepeated(): Promise<unknown> {
		const candidate = session as unknown as {
			reduceRepeatedToolOutputs?: () => Promise<unknown>;
		};
		if (typeof candidate.reduceRepeatedToolOutputs !== "function") {
			throw new Error("Expected AgentSession.reduceRepeatedToolOutputs() to exist");
		}
		return candidate.reduceRepeatedToolOutputs();
	}

	it("reduces older repeated large tool results with durable artifact:// recovery while keeping newest and preserving pairing/errors/aborts/images", async () => {
		const bashOutputs = [0, 1, 2].map(idx =>
			Array.from({ length: 80 }, (_, line) => `bash-run-${idx}-line-${line} alpha beta gamma delta é`).join("\n"),
		);
		const oldBash1 = appendToolTurn({ toolName: "bash", args: { command: "echo 1" }, text: bashOutputs[0]! });
		const oldBash2 = appendToolTurn({ toolName: "bash", args: { command: "echo 2" }, text: bashOutputs[1]! });
		const errBash = appendToolTurn({
			toolName: "bash",
			args: { command: "false" },
			text: "fatal error output ".repeat(120),
			isError: true,
		});
		const abortedTask = appendToolTurn({
			toolName: "task",
			args: { assignment: "cancelled" },
			text: "aborted task output ".repeat(120),
			details: { aborted: true },
		});
		const mixedImg = appendToolTurn({
			toolName: "read_image",
			args: { path: "img.png" },
			text: "image metadata ".repeat(120),
			extraContent: [{ type: "image", data: "iVBORw0KGgo", mimeType: "image/png" }],
		});
		const skillRead = appendToolTurn({
			toolName: "read",
			args: { path: "skill://testing" },
			text: "skill instructions ".repeat(120),
		});
		const newestBash = appendToolTurn({ toolName: "bash", args: { command: "echo 3" }, text: bashOutputs[2]! });

		const beforeMessages = session.buildDisplaySessionContext().messages;
		session.agent.replaceMessages(beforeMessages);
		const beforeBytes = Buffer.byteLength(JSON.stringify(beforeMessages), "utf-8");
		const beforeCallIds = beforeMessages
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content.filter(b => b.type === "toolCall").map(b => b.id));

		await invokeReduceRepeated();

		const afterMessages = session.agent.state.messages;
		const afterBytes = Buffer.byteLength(JSON.stringify(afterMessages), "utf-8");
		expect(afterBytes).toBeLessThan(beforeBytes);

		const results = branchToolResults();
		const byId = new Map(results.map(r => [r.toolCallId, r]));

		// Older repeated bash outputs reduced to artifact:// links
		for (const [id, expectedText] of [
			[oldBash1, bashOutputs[0]!],
			[oldBash2, bashOutputs[1]!],
		] as const) {
			const msg = byId.get(id)!;
			expect(msg.prunedAt).toBeGreaterThan(0);
			const text = msg.content.map(b => (b.type === "text" ? b.text : "")).join("");
			const match = text.match(/artifact:\/\/(\d+)/);
			expect(match).not.toBeNull();
			const resolved = await new ArtifactProtocolHandler().resolve(new URL(`artifact://${match![1]}`) as never);
			expect(resolved.content).toBe(expectedText);
		}

		// Newest bash, error, aborted, mixed-image, and skill:// read preserved untouched
		expect(byId.get(newestBash)?.prunedAt).toBeUndefined();
		expect(byId.get(newestBash)?.content[0]).toEqual({ type: "text", text: bashOutputs[2]! });
		expect(byId.get(errBash)?.isError).toBe(true);
		expect(byId.get(errBash)?.prunedAt).toBeUndefined();
		expect(byId.get(abortedTask)?.prunedAt).toBeUndefined();
		expect(byId.get(mixedImg)?.prunedAt).toBeUndefined();
		expect(byId.get(mixedImg)?.content.some(b => b.type === "image")).toBe(true);
		expect(byId.get(skillRead)?.prunedAt).toBeUndefined();

		// 1:1 toolCall/toolResult pairing intact
		const afterCallIds = afterMessages
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content.filter(b => b.type === "toolCall").map(b => b.id));
		const afterResultIds = afterMessages
			.filter((m): m is ToolResultMessage => m.role === "toolResult")
			.map(m => m.toolCallId);
		expect(afterCallIds).toEqual(beforeCallIds);
		expect(afterResultIds).toEqual(beforeCallIds);

		// Survives session close + resume
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await sessionManager.close();

		const resumed = await SessionManager.open(sessionFile, tempDir.path());
		try {
			const resumedMsg = resumed
				.getBranch()
				.flatMap(e => (e.type === "message" && e.message.role === "toolResult" ? [e.message] : []))
				.find(m => m.toolCallId === oldBash1);
			expect(resumedMsg).toBeDefined();
			const firstBlock = resumedMsg!.content[0];
			if (!firstBlock || firstBlock.type !== "text") throw new Error("Expected text block");
			const match = firstBlock.text.match(/artifact:\/\/(\d+)/);
			expect(match).not.toBeNull();
			const artifactPath = await resumed.getArtifactPath(match![1]!);
			if (!artifactPath) throw new Error("Expected artifact on disk after resume");
			expect(await Bun.file(artifactPath).text()).toBe(bashOutputs[0]!);
		} finally {
			await resumed.close();
		}
	});

	it("leaves repeated historical tool outputs untouched when artifact save or readback fails", async () => {
		const bashOutputs = [0, 1].map(idx =>
			Array.from({ length: 80 }, (_, line) => `repeated-fail-${idx}-line-${line} payload`).join("\n"),
		);
		appendToolTurn({ toolName: "bash", args: { command: "echo a" }, text: bashOutputs[0]! });
		appendToolTurn({ toolName: "bash", args: { command: "echo b" }, text: bashOutputs[1]! });

		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const originalBranch = structuredClone(sessionManager.getBranch());
		const originalMessages = structuredClone(session.agent.state.messages);

		vi.spyOn(sessionManager, "saveArtifact").mockRejectedValue(new Error("disk full"));

		await invokeReduceRepeated();

		expect(sessionManager.getBranch()).toEqual(originalBranch);
		expect(session.agent.state.messages).toEqual(originalMessages);
	});
});
