import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage } from "jeopi-agent-core";
import * as compactionModule from "jeopi-agent-core/compaction";
import type { AssistantMessage, ImageContent, ToolResultMessage } from "jeopi-ai";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { AgentSession, type AgentSessionEvent } from "jeopi-cli/session/agent-session";
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

describe("AgentSession shake", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let events: AgentSessionEvent[];
	let apiInfo: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; model: string };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-shake-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		apiInfo = { api: model.api, provider: model.provider, model: model.id };

		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
		});
		session.subscribe(event => events.push(event));
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	/** Seed a user → assistant(toolCall) → toolResult turn carrying a heavy bash result. */
	function seedHeavyToolResult(text: string, toolName = "bash"): void {
		const toolCallId = `call_${toolName}_${Math.random().toString(36).slice(2)}`;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "do it" }],
			timestamp: Date.now() - 3,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "working" },
				{ type: "toolCall", id: toolCallId, name: toolName, arguments: { command: "ls" } },
			],
			...apiInfo,
			stopReason: "toolUse",
			usage,
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now() - 1,
		});
	}

	function branchToolResults(): ToolResultMessage[] {
		return sessionManager
			.getBranch()
			.filter(e => e.type === "message" && (e.message as { role?: string }).role === "toolResult")
			.map(e => (e as { message: ToolResultMessage }).message);
	}

	describe("elide", () => {
		it("drops the tool result, offloads to an artifact, and embeds the recovery link", async () => {
			seedHeavyToolResult("X".repeat(4000));
			const replaceSpy = vi.spyOn(session.agent, "replaceMessages");

			const result = await session.shake("elide");

			expect(result.mode).toBe("elide");
			expect(result.toolResultsDropped).toBe(1);
			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(result.artifactId).toBeDefined();
			expect(replaceSpy).toHaveBeenCalled();

			const [tr] = branchToolResults();
			expect(tr.prunedAt).toBeGreaterThan(0);
			const text = tr.content.map(b => (b.type === "text" ? b.text : "")).join("");
			expect(text).toContain(`artifact://${result.artifactId}`);
			expect(text).toContain("shaken");
		});

		it("recovers complete task output after resuming and keeps its paired call identity", async () => {
			const original = Array.from({ length: 300 }, (_, i) => `task line ${i} é`).join("\n");
			seedHeavyToolResult(original, "task");
			const before = branchToolResults()[0];
			const beforeBytes = Buffer.byteLength(JSON.stringify(before));
			const callId = before.toolCallId;
			const result = await session.shake("elide");
			const after = branchToolResults()[0];
			expect(after.toolCallId).toBe(callId);
			expect(after.toolName).toBe("task");
			expect(Buffer.byteLength(JSON.stringify(after))).toBeLessThan(beforeBytes);
			if (!result.artifactId) throw new Error("Expected recoverable artifact");
			await sessionManager.flush();
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected persisted session");
			await sessionManager.close();
			const resumed = await SessionManager.open(file, tempDir.path());
			try {
				const messages = resumed
					.getBranch()
					.filter(entry => entry.type === "message")
					.map(entry => entry.message);
				const call = messages.find(
					message =>
						message.role === "assistant" &&
						message.content.some(block => block.type === "toolCall" && block.id === callId),
				);
				const restored = messages.find(message => message.role === "toolResult" && message.toolCallId === callId);
				expect(call).toBeDefined();
				expect(restored).toEqual(after);
				const artifactPath = await resumed.getArtifactPath(result.artifactId);
				if (!artifactPath) throw new Error("Artifact unavailable after resume");
				expect(await Bun.file(artifactPath).text()).toContain(original);
			} finally {
				await resumed.close();
			}
		});

		for (const failure of ["undefined", "throw", "missing readback"] as const) {
			it(`preserves the complete result when artifact ${failure}`, async () => {
				seedHeavyToolResult("must survive é ".repeat(500));
				const original = structuredClone(branchToolResults()[0]);
				if (failure === "throw") vi.spyOn(sessionManager, "saveArtifact").mockRejectedValue(new Error("disk full"));
				else if (failure === "undefined") vi.spyOn(sessionManager, "saveArtifact").mockResolvedValue(undefined);
				else vi.spyOn(sessionManager, "saveArtifact").mockResolvedValue("999999999");
				await session.shake("elide");
				expect(branchToolResults()[0]).toEqual(original);
			});
		}

		it("preserves error results and mixed image results", async () => {
			seedHeavyToolResult("error details ".repeat(400), "bash");
			const error = branchToolResults()[0];
			error.isError = true;
			seedHeavyToolResult("image description ".repeat(400), "read_image");
			const mixed = branchToolResults()[1];
			mixed.content.push({ type: "image", data: "iVBORw0KGgo", mimeType: "image/png" });
			const originals = structuredClone(branchToolResults());
			await session.shake("elide");
			expect(branchToolResults()).toEqual(originals);
		});

		it("preserves branch and agent messages untouched when artifact readback is corrupted or mismatched", async () => {
			seedHeavyToolResult("corrupt readback test ".repeat(400), "bash");
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `notes\n\`\`\`ts\n${"const x = 1;\n".repeat(120)}\n\`\`\`` }],
				...apiInfo,
				stopReason: "stop",
				usage,
				timestamp: Date.now(),
			});
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			const originalBranch = structuredClone(sessionManager.getBranch());
			const originalAgentMessages = structuredClone(session.agent.state.messages);
			const replaceSpy = vi.spyOn(session.agent, "replaceMessages");

			const originalSave = sessionManager.saveArtifact.bind(sessionManager);
			vi.spyOn(sessionManager, "saveArtifact").mockImplementation(async (content, toolType) => {
				const id = await originalSave(content, toolType);
				if (id) {
					const artifactPath = await sessionManager.getArtifactPath(id);
					if (artifactPath) {
						await Bun.write(artifactPath, "CORRUPTED_TRUNCATED_BYTES");
					}
				}
				return id;
			});

			const result = await session.shake("elide");

			expect(result.toolResultsDropped).toBe(0);
			expect(result.blocksDropped).toBe(0);
			expect(result.tokensFreed).toBe(0);
			expect(result.artifactId).toBeUndefined();
			expect(replaceSpy).not.toHaveBeenCalled();
			expect(sessionManager.getBranch()).toEqual(originalBranch);
			expect(session.agent.state.messages).toEqual(originalAgentMessages);
		});

		it("preserves aborted tool results alongside error and mixed-image results", async () => {
			seedHeavyToolResult("aborted run output ".repeat(400), "task");
			const abortedEntry = branchToolResults()[0];
			abortedEntry.details = { aborted: true };

			const abortedCallId = "call-aborted-assistant";
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: abortedCallId, name: "bash", arguments: { command: "sleep 10" } }],
				...apiInfo,
				stopReason: "aborted",
				errorMessage: "Aborted by user",
				usage,
				timestamp: Date.now() - 2,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: abortedCallId,
				toolName: "bash",
				content: [{ type: "text", text: "cancelled output ".repeat(300) }],
				isError: false,
				timestamp: Date.now() - 1,
			});

			const originals = structuredClone(branchToolResults());
			const result = await session.shake("elide");
			expect(result.toolResultsDropped).toBe(0);
			expect(branchToolResults()).toEqual(originals);
		});

		it("reduces synthetic multi-turn session size, preserves pairing and protected/error/aborted/image items, and recovers after resume", async () => {
			const ts0 = Date.now() - 10_000;
			const repeatedOutputs = Array.from({ length: 4 }, (_, turn) =>
				Array.from({ length: 220 }, (_, line) => `turn-${turn}-row-${line} payload alpha beta gamma é`).join("\n"),
			);

			// Turn 0..3: repeated long bash/task outputs + one large fenced block
			for (let i = 0; i < repeatedOutputs.length; i++) {
				seedHeavyToolResult(repeatedOutputs[i]!, i % 2 === 0 ? "bash" : "task");
			}
			const fencedBody = `\`\`\`ts\n${"export const item = computeLargeValue(1, 2, 3, 4);\n".repeat(160)}\n\`\`\``;
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `Analysis:\n${fencedBody}\nDone.` }],
				...apiInfo,
				stopReason: "stop",
				usage,
				timestamp: ts0 + 50,
			});

			// Protected skill read + error + aborted + mixed image turn
			const skillCallId = "call-skill-keep";
			const errCallId = "call-err-keep";
			const imgCallId = "call-img-keep";
			sessionManager.appendMessage({
				role: "assistant",
				content: [
					{ type: "toolCall", id: skillCallId, name: "read", arguments: { path: "skill://testing" } },
					{ type: "toolCall", id: errCallId, name: "bash", arguments: { command: "exit 1" } },
					{ type: "toolCall", id: imgCallId, name: "read_image", arguments: { path: "a.png" } },
				],
				...apiInfo,
				stopReason: "toolUse",
				usage,
				timestamp: ts0 + 60,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: skillCallId,
				toolName: "read",
				content: [{ type: "text", text: "SKILL CONTENT ".repeat(200) }],
				isError: false,
				timestamp: ts0 + 61,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: errCallId,
				toolName: "bash",
				content: [{ type: "text", text: "ERROR STACK ".repeat(200) }],
				isError: true,
				timestamp: ts0 + 62,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: imgCallId,
				toolName: "read_image",
				content: [
					{ type: "text", text: "IMG META ".repeat(200) },
					{ type: "image", data: "iVBORw0KGgo", mimeType: "image/png" },
				],
				isError: false,
				timestamp: ts0 + 63,
			});

			const beforeMessages = session.buildDisplaySessionContext().messages;
			session.agent.replaceMessages(beforeMessages);
			const beforeBytes = Buffer.byteLength(JSON.stringify(beforeMessages), "utf-8");
			const beforeToolCallIds = beforeMessages
				.filter((m): m is AssistantMessage => m.role === "assistant")
				.flatMap(m => m.content.filter(b => b.type === "toolCall").map(b => b.id));
			const beforeToolResultIds = beforeMessages
				.filter((m): m is ToolResultMessage => m.role === "toolResult")
				.map(m => m.toolCallId);
			expect(beforeToolResultIds).toEqual(beforeToolCallIds);

			const result = await session.shake("elide");

			expect(result.toolResultsDropped).toBe(4);
			expect(result.blocksDropped).toBe(1);
			expect(result.tokensFreed).toBeGreaterThan(0);
			if (!result.artifactId) throw new Error("Expected durable artifactId");

			const afterMessages = session.agent.state.messages;
			const afterBytes = Buffer.byteLength(JSON.stringify(afterMessages), "utf-8");
			expect(afterBytes).toBeLessThan(Math.floor(beforeBytes * 0.5));

			// Pairing preserved 1:1 in order
			const afterToolCallIds = afterMessages
				.filter((m): m is AssistantMessage => m.role === "assistant")
				.flatMap(m => m.content.filter(b => b.type === "toolCall").map(b => b.id));
			const afterToolResultIds = afterMessages
				.filter((m): m is ToolResultMessage => m.role === "toolResult")
				.map(m => m.toolCallId);
			expect(afterToolCallIds).toEqual(beforeToolCallIds);
			expect(afterToolResultIds).toEqual(beforeToolResultIds);

			// Protected skill, error, and mixed-image results untouched
			const keptSkill = branchToolResults().find(r => r.toolCallId === skillCallId);
			const keptErr = branchToolResults().find(r => r.toolCallId === errCallId);
			const keptImg = branchToolResults().find(r => r.toolCallId === imgCallId);
			expect(keptSkill?.prunedAt).toBeUndefined();
			expect(keptErr?.isError).toBe(true);
			expect(keptErr?.prunedAt).toBeUndefined();
			expect(keptImg?.prunedAt).toBeUndefined();
			expect(keptImg?.content.some(b => b.type === "image")).toBe(true);

			// Resume recovery
			await sessionManager.flush();
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			await sessionManager.close();

			const resumed = await SessionManager.open(sessionFile, tempDir.path());
			try {
				const artifactPath = await resumed.getArtifactPath(result.artifactId);
				if (!artifactPath) throw new Error("Expected artifact file after resume");
				const recovered = await Bun.file(artifactPath).text();
				for (const text of repeatedOutputs) {
					expect(recovered).toContain(text);
				}
				expect(recovered).toContain(fencedBody);
			} finally {
				await resumed.close();
			}
		});

		it("returns zero counts for an empty branch", async () => {
			const result = await session.shake("elide");
			expect(result.toolResultsDropped).toBe(0);
			expect(result.blocksDropped).toBe(0);
			expect(result.tokensFreed).toBe(0);
		});
	});

	describe("images", () => {
		it("mirrors dropImages and reports the removed image count", async () => {
			const png: ImageContent = { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" };
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "look" }, png],
				timestamp: Date.now(),
			});

			const result = await session.shake("images");

			expect(result.mode).toBe("images");
			expect(result.imagesDropped).toBe(1);
			const branch = sessionManager.getBranch();
			const userMsg = branch.find(e => e.type === "message" && (e.message as { role?: string }).role === "user");
			const content = (userMsg as { message: { content: unknown } }).message.content as Array<{ type: string }>;
			expect(content.some(b => b.type === "image")).toBe(false);
		});
	});

	describe("protected tools", () => {
		it("never shakes skill results", async () => {
			seedHeavyToolResult("S".repeat(4000), "skill");
			const result = await session.shake("elide");
			expect(result.toolResultsDropped).toBe(0);
		});
	});

	describe("auto-shake strategy", () => {
		it("dispatches the elide path and emits a shake action for threshold maintenance", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdPercent", 1);
			session.settings.set("contextPromotion.enabled", false);

			// Reclaim enough that the corrected (provider − tokensFreed) figure lands
			// inside the 80% recovery band — otherwise the #2275 post-shake check would
			// (correctly) declare pressure unresolved and fall back to context-full.
			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10_000 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await Bun.sleep(20);

			expect(shakeSpy).toHaveBeenCalledWith("elide", expect.anything());
			const start = events.filter(e => e.type === "auto_compaction_start");
			expect(start).toHaveLength(1);
			expect(start[0]).toMatchObject({ type: "auto_compaction_start", reason: "threshold", action: "shake" });
			const end = events.filter(e => e.type === "auto_compaction_end");
			expect(end).toHaveLength(1);
			expect(end[0]).toMatchObject({ type: "auto_compaction_end", action: "shake" });
		});

		it("keeps a successful overflow shake recovery committed before retrying", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("contextPromotion.enabled", false);
			seedHeavyToolResult("X ".repeat(20000));
			branchToolResults()[0].useless = true;
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			vi.spyOn(session.agent, "continue").mockResolvedValue();
			vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 200000, percent: 0.5 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				...apiInfo,
				stopReason: "error",
				errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
				usage: {
					input: 250_000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 250_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end" && event.action === "shake") onCompactionDone();
			});
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });

			await compactionDone;
			await session.waitForIdle();

			const shakeEnd = events.find(event => event.type === "auto_compaction_end" && event.action === "shake");
			expect(shakeEnd).toMatchObject({ type: "auto_compaction_end", action: "shake", willRetry: true });
			expect(sessionManager.getBranch()).not.toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({
						role: "assistant",
						stopReason: "error",
						errorMessage: assistantMessage.errorMessage,
					}),
				}),
			);
			expect(session.agent.state.messages).not.toContainEqual(
				expect.objectContaining({
					role: "assistant",
					stopReason: "error",
					errorMessage: assistantMessage.errorMessage,
				}),
			);
		});

		it("keeps a no-op incomplete shake retry committed before rollback can restore the length tail", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("contextPromotion.enabled", false);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			vi.spyOn(session.agent, "continue").mockResolvedValue();
			vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 200000, percent: 0.5 });
			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "partial response" }],
				...apiInfo,
				stopReason: "length",
				usage: {
					input: 20_000,
					output: 5_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 25_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end" && event.action === "shake") onCompactionDone();
			});
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });

			await compactionDone;
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			const shakeEnd = events.find(event => event.type === "auto_compaction_end" && event.action === "shake");
			expect(shakeEnd).toMatchObject({ type: "auto_compaction_end", action: "shake", willRetry: true });
			expect(sessionManager.getBranch()).not.toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({
						role: "assistant",
						stopReason: "length",
						timestamp: assistantMessage.timestamp,
					}),
				}),
			);
			expect(session.agent.state.messages).not.toContainEqual(
				expect.objectContaining({
					role: "assistant",
					stopReason: "length",
					timestamp: assistantMessage.timestamp,
				}),
			);
		});

		it("has isCompacting true when the shake auto_compaction_start event fires", async () => {
			// Defect 1 parity for the shake strategy: the controller backing isCompacting
			// must be installed before auto_compaction_start is emitted, so a message
			// typed as the loader appears is queued safely rather than mis-routed.
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdPercent", 1);
			session.settings.set("contextPromotion.enabled", false);

			let capturedIsCompacting: boolean | undefined;
			const { promise: shakeStarted, resolve: onShakeStarted } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_start" && event.action === "shake") {
					capturedIsCompacting = session.isCompacting;
					onShakeStarted();
				}
			});

			vi.spyOn(session, "shake").mockResolvedValue({
				mode: "elide",
				toolResultsDropped: 1,
				blocksDropped: 0,
				tokensFreed: 10_000,
			});

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await shakeStarted;

			expect(capturedIsCompacting).toBe(true);
		});

		it("falls back to context-full when shake cannot drop context below the threshold (regression #2119)", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdPercent", 1);
			session.settings.set("contextPromotion.enabled", false);

			// Seed agent state so the post-shake estimate is well above the 1% threshold
			// (~2K tokens for a 200K window). The mocked shake returns reclaimed=true but
			// does not modify state, mimicking the dead-loop scenario where shake removes
			// nothing material yet the threshold check stays positive.
			session.agent.replaceMessages([
				{
					role: "user",
					content: [{ type: "text", text: "x".repeat(40000) }],
					timestamp: Date.now(),
				} as never,
			]);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await Bun.sleep(50);

			// Shake fires once. The pre-fix bug auto-continued, which would re-trigger shake
			// on the next agent_end. The fix replaces that loop with a one-shot fallback.
			expect(shakeSpy).toHaveBeenCalledTimes(1);

			const shakeEnd = events.find(
				e => e.type === "auto_compaction_end" && (e as { action?: string }).action === "shake",
			) as { errorMessage?: string; skipped?: boolean } | undefined;
			expect(shakeEnd).toBeDefined();
			expect(shakeEnd?.errorMessage).toMatch(/falling back to context-full/i);

			// Fallback enters the context-full path so the situation actually resolves.
			const fullStart = events.find(
				e => e.type === "auto_compaction_start" && (e as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeDefined();
		});

		it("falls back when provider-reported usage stays above the threshold even though the local estimate is below it (regression #2275)", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdTokens", 5_000);
			session.settings.set("contextPromotion.enabled", false);

			// Agent state holds almost no content, so #estimatePendingPromptTokens reads
			// well below the 5K threshold. The pre-fix post-shake check trusted that
			// estimate and treated the pressure as resolved, even though the assistant
			// message's provider-reported usage (11K) was well above the threshold.
			// This is the metric-divergence dead loop from #2275: thinking-heavy
			// sessions hit it for real (thinkingSignature payloads aren't counted by
			// the estimator), and an empty-state probe mimics it deterministically.
			session.agent.replaceMessages([]);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await Bun.sleep(50);

			expect(shakeSpy).toHaveBeenCalledTimes(1);

			const shakeEnd = events.find(
				e => e.type === "auto_compaction_end" && (e as { action?: string }).action === "shake",
			) as { errorMessage?: string; skipped?: boolean } | undefined;
			expect(shakeEnd).toBeDefined();
			expect(shakeEnd?.errorMessage).toMatch(/falling back to context-full/i);

			const fullStart = events.find(
				e => e.type === "auto_compaction_start" && (e as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeDefined();
		});

		it("counts pre-shake prune savings when deciding whether to fall back to context-full", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdTokens", 76384);
			session.settings.set("compaction.thresholdPercent", -1);
			session.settings.set("compaction.dropUseless", true);
			session.settings.set("contextPromotion.enabled", false);

			const now = Date.now();
			sessionManager.appendMessage({
				role: "user",
				content: "Investigate every module of the project.",
				timestamp: now - 200,
			});
			const bigCallId = "call-big-useless-for-shake";
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: bigCallId, name: "grep", arguments: { pattern: "TODO" } }],
				...apiInfo,
				stopReason: "toolUse",
				usage,
				timestamp: now - 180,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: bigCallId,
				toolName: "grep",
				content: [{ type: "text", text: "match line\n".repeat(20000) }],
				isError: false,
				useless: true,
				timestamp: now - 170,
			});
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 100 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 5000,
					output: 1000,
					cacheRead: 85000,
					cacheWrite: 0,
					totalTokens: 91000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: now,
			};

			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await Bun.sleep(50);

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			const fullStart = events.find(
				event => event.type === "auto_compaction_start" && (event as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeUndefined();
		});

		it("falls back after pre-prompt shake when the floored stored conversation remains over threshold", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdTokens", 8_000);
			session.settings.set("compaction.keepRecentTokens", 1);
			session.settings.set("contextPromotion.enabled", false);

			const seedUser: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: "seed" }],
				timestamp: Date.now() - 2,
			};
			const bulkText = "alpha beta gamma delta epsilon ".repeat(3_000);
			const seedAssistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: bulkText }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 1_000,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_010,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now() - 1,
			};
			sessionManager.appendMessage(seedUser);
			sessionManager.appendMessage(seedAssistant);
			session.agent.replaceMessages([seedUser, seedAssistant]);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 });
			const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "pre-prompt shake fallback compacted",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
			vi.spyOn(session.agent, "prompt").mockImplementation(async () => {});

			expect(session.getContextUsage({ contextWindow: 200_000 })?.tokens).toBe(1_000);

			await session.prompt("small pending prompt", { skipCompactionCheck: true });

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			expect(compactSpy).toHaveBeenCalled();
			const fullStart = events.find(
				event => event.type === "auto_compaction_start" && (event as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeDefined();
		});
	});
});
