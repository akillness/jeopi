import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "jeopi-agent-core";
import { estimateTokens } from "jeopi-agent-core/compaction/compaction";
import type { AssistantMessage, Message, Model } from "jeopi-ai";
import { z } from "jeopi-ai";
import { createMockModel, type MockModel } from "jeopi-ai/providers/mock";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import type { Skill } from "jeopi-cli/extensibility/skills";
import { StatusLineComponent } from "jeopi-cli/modes/components/status-line";
import { initTheme } from "jeopi-cli/modes/theme/theme";
import {
	computeContextBreakdown,
	computeNonMessageTokens,
	renderContextUsage,
} from "jeopi-cli/modes/utils/context-usage";
import { AgentSession } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { TempDir } from "jeopi-utils";

describe("Context usage consolidation", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mockModel: MockModel;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-context-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		await Settings.init({ inMemory: true });
		await initTheme();

		mockModel = createMockModel({
			id: "gpt-mock",
			provider: "openai",
			contextWindow: 100_000,
			responses: [
				{
					content: ["response text"],
					stopReason: "stop",
					usage: {
						input: 100,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 120,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		});
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	function createSession(
		tempDir: TempDir,
		messages: AgentMessage[] = [],
	): { session: AgentSession; sessionManager: SessionManager; agent: Agent } {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		for (const msg of messages) {
			sessionManager.appendMessage(msg as unknown as Parameters<typeof sessionManager.appendMessage>[0]);
		}

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mockModel,
				systemPrompt: ["You are a helpful assistant."],
				tools: [],
				messages,
			},
			streamFn: mockModel.stream,
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": 8000,
			}),
			modelRegistry,
		});

		const sessionContext = session.buildDisplaySessionContext();
		agent.replaceMessages(sessionContext.messages);

		return { session, sessionManager, agent };
	}

	function syncSession(session: AgentSession, agent: Agent): void {
		const sessionContext = session.buildDisplaySessionContext();
		agent.replaceMessages(sessionContext.messages);
	}

	it("keeps branch-local anchors safe from sibling branches", async () => {
		const tempDir = TempDir.createSync("@branch-local-");
		const { session, sessionManager, agent } = createSession(tempDir);

		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "parent response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 100, nonMessageTokens: 10 },
			timestamp: 2000,
		} as AssistantMessage);

		syncSession(session, agent);
		const parentId = sessionManager.getBranch().slice(-1)[0]?.id;

		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "sibling response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 500,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 520,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 500, nonMessageTokens: 10 },
			timestamp: 3000,
		} as AssistantMessage);

		sessionManager.branch(parentId!);
		sessionManager.appendMessage({ role: "user", content: "active branch hello", timestamp: 4000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "active response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 200,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 220,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 200, nonMessageTokens: 10 },
			timestamp: 5000,
		} as AssistantMessage);

		syncSession(session, agent);

		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);
		expect(breakdown?.usedTokens).toBe(200);

		await tempDir.remove();
	});

	it("recovers correct anchor after rollback", async () => {
		const tempDir = TempDir.createSync("@rollback-");
		const { session, sessionManager, agent } = createSession(tempDir);

		sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1000 } as Message);
		const firstId = sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "first response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 150,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 170,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 150, nonMessageTokens: 10 },
			timestamp: 2000,
		} as AssistantMessage);

		sessionManager.appendMessage({ role: "user", content: "second", timestamp: 3000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "second response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 300,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 320,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 300, nonMessageTokens: 10 },
			timestamp: 4000,
		} as AssistantMessage);

		sessionManager.branch(firstId);
		syncSession(session, agent);

		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);
		expect(breakdown?.usedTokens).toBe(150);

		await tempDir.remove();
	});

	it("uses speculative mode after compaction with no subsequent assistant snapshot", async () => {
		const tempDir = TempDir.createSync("@compaction-speculative-");
		const { session, sessionManager, agent } = createSession(tempDir);

		const firstId = sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "pre compaction response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 150,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 170,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 150, nonMessageTokens: 10 },
			timestamp: 1000,
		} as AssistantMessage);

		sessionManager.appendCompaction("compact summary", "compact summary", firstId, 50);
		syncSession(session, agent);

		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(false);

		await tempDir.remove();
	});

	it("includes custom message / summary in resolved active tail", async () => {
		const tempDir = TempDir.createSync("@tail-custom-");
		const { session, sessionManager, agent } = createSession(tempDir);

		sessionManager.appendMessage({ role: "user", content: "query", timestamp: 1000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "anchor response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 150,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 170,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 150, nonMessageTokens: 10 },
			timestamp: 2000,
		} as AssistantMessage);

		const customMsg: AgentMessage = {
			role: "custom",
			customType: "test-custom",
			content: "custom content block",
			display: true,
			timestamp: 3000,
		};
		sessionManager.appendMessage(customMsg as unknown as Parameters<typeof sessionManager.appendMessage>[0]);
		syncSession(session, agent);

		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);

		const customEstimate = estimateTokens(customMsg);
		expect(breakdown?.usedTokens).toBe(150 + customEstimate);

		await tempDir.remove();
	});

	it("ensures /context, status line, model selector, and idle compaction all agree on used tokens", async () => {
		const tempDir = TempDir.createSync("@agree-");
		const { session, sessionManager, agent } = createSession(tempDir);

		sessionManager.appendMessage({ role: "user", content: "query", timestamp: 1000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "anchor response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 250,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 270,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 250, nonMessageTokens: 10 },
			timestamp: 2000,
		} as AssistantMessage);

		syncSession(session, agent);

		const breakdownVal = session.getContextBreakdown();
		const used = breakdownVal?.usedTokens;

		const cb = computeContextBreakdown(session);
		expect(cb.usedTokens).toBe(used!);

		const sl = new StatusLineComponent(session);
		expect(sl.getCachedContextBreakdown().usedTokens).toBe(used!);

		const cu = session.getContextUsage();
		expect(cu?.tokens).toBe(used!);

		await tempDir.remove();
	});

	it("invalidates status-line cache on reasoning-signature growth", async () => {
		const tempDir = TempDir.createSync("@cache-invalidate-");
		const { session, sessionManager, agent } = createSession(tempDir);

		sessionManager.appendMessage({ role: "user", content: "query", timestamp: 1000 } as Message);
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "text content" }],
			usage: {
				input: 250,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 270,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 250, nonMessageTokens: 10 },
			timestamp: 2000,
			stopReason: "stop",
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
		};
		sessionManager.appendMessage(assistant);
		syncSession(session, agent);

		const sl = new StatusLineComponent(session);
		const initialBreakdown = sl.getCachedContextBreakdown();

		const assistantExt = assistant as unknown as { thinkingSignature: string };
		assistantExt.thinkingSignature = "signature_grows";

		const nextBreakdown = sl.getCachedContextBreakdown();
		expect(nextBreakdown.usedTokens).toBe(initialBreakdown.usedTokens);

		await tempDir.remove();
	});

	it("uses live in-flight pending snapshot when request is active", async () => {
		const tempDir = TempDir.createSync("@inflight-");
		const { session, agent } = createSession(tempDir);

		const { promise, resolve } = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const promptSpy = vi.spyOn(agent, "prompt").mockImplementation(async () => {
			started.resolve();
			await promise;
		});

		const promptPromise = session.prompt("query");

		// Wait until the prompt request is actually in flight (pending snapshot set).
		await started.promise;

		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);
		expect(breakdown?.usedTokens).toBeGreaterThan(0);

		resolve();
		await promptPromise;
		promptSpy.mockRestore();
		await tempDir.remove();
	});

	it("prefers a completed in-turn provider anchor over the pending snapshot", async () => {
		const tempDir = TempDir.createSync("@inturn-anchor-");
		const { session, sessionManager, agent } = createSession(tempDir);

		const { promise, resolve } = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const promptSpy = vi.spyOn(agent, "prompt").mockImplementation(async () => {
			started.resolve();
			await promise;
		});

		const promptPromise = session.prompt("new question");
		await started.promise;

		// While the request hangs (pending snapshot active, cutoff at the new
		// prompt), simulate the turn's user message landing plus a completed tool
		// step carrying a real, large provider prompt count.
		sessionManager.appendMessage({ role: "user", content: "new question", timestamp: 5000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "step" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "toolUse",
			usage: {
				input: 9000,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 9020,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 9000, nonMessageTokens: 10 },
			timestamp: 6000,
		} as AssistantMessage);
		syncSession(session, agent);

		// The in-turn anchor (index >= pending cutoff) must win: usage reflects the
		// real 9000-token prompt, not the tiny turn-start pending estimate that
		// would otherwise stack an estimate of the whole tail on top.
		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);
		expect(breakdown?.usedTokens).toBeGreaterThanOrEqual(9000);

		resolve();
		await promptPromise;
		promptSpy.mockRestore();
		await tempDir.remove();
	});

	it("keeps the pending snapshot (not a pre-cutoff anchor) while the first turn response is pending", async () => {
		const tempDir = TempDir.createSync("@pending-precutoff-");
		const { session, sessionManager, agent } = createSession(tempDir);

		// Prior completed turn establishes a real anchor that PREDATES the new
		// prompt (resolves before the pending cutoff).
		sessionManager.appendMessage({ role: "user", content: "old", timestamp: 1000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "old response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 5000,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 5020,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 5000, nonMessageTokens: 10 },
			timestamp: 2000,
		} as AssistantMessage);
		syncSession(session, agent);

		const { promise, resolve } = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const promptSpy = vi.spyOn(agent, "prompt").mockImplementation(async () => {
			started.resolve();
			await promise;
		});

		// Large prompt in flight, no in-turn step has produced provider usage yet.
		const bigPrompt = "explain this in detail ".repeat(200);
		const promptPromise = session.prompt(bigPrompt);
		await started.promise;

		// Pending must win: it accounts for the just-submitted prompt on top of the
		// prior anchor. The stale pre-cutoff anchor alone (5000) would omit it, so a
		// regression to "always prefer the latest real anchor" would read ~5000.
		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);
		expect(breakdown?.usedTokens).toBeGreaterThan(5500);

		resolve();
		await promptPromise;
		promptSpy.mockRestore();
		await tempDir.remove();
	});

	it("guarantees always numeric nullable-vs-speculative contract", async () => {
		const tempDir = TempDir.createSync("@always-numeric-");
		const { session, sessionManager, agent } = createSession(tempDir);

		const dummyId = sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "dummy" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1000,
		} as AssistantMessage);

		sessionManager.appendCompaction("compact summary", "compact summary", dummyId, 50);
		syncSession(session, agent);

		const cu = session.getContextUsage();
		expect(cu?.tokens).not.toBeNull();
		expect(typeof cu?.tokens).toBe("number");
		expect(cu?.percent).not.toBeNull();
		expect(typeof cu?.percent).toBe("number");

		await tempDir.remove();
	});
	it("separates provider prompt input from estimated current categories and pending tail", async () => {
		const tempDir = TempDir.createSync("@context-measurements-");
		try {
			const { session, sessionManager, agent } = createSession(tempDir);
			const user = {
				role: "user",
				content: "A sufficiently long question about the project",
				timestamp: 1000,
			} as Message;
			const assistant = {
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				api: mockModel.api,
				provider: mockModel.provider,
				model: mockModel.id,
				stopReason: "stop",
				timestamp: 2000,
				usage: {
					input: 100,
					output: 20,
					cacheRead: 30,
					cacheWrite: 20,
					totalTokens: 170,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as AssistantMessage;
			sessionManager.appendMessage(user);
			sessionManager.appendMessage(assistant);
			syncSession(session, agent);
			const pending = {
				role: "user",
				content: "a pending tail not yet sent".repeat(10),
				timestamp: 3000,
			} as Message;
			const before = session.getContextBreakdown()!;
			const after = session.getContextBreakdown({ pendingMessages: [pending] })!;
			expect(before.providerPromptTokens).toBe(150);
			expect(before.providerPromptStatus).toBe("current");
			expect(after.providerPromptTokens).toBe(150);
			expect(after.usedTokens - before.usedTokens).toBe(estimateTokens(pending));
			expect(before.messagesTokens).toBe(estimateTokens(user) + estimateTokens(assistant));
			const panel = computeContextBreakdown(session);
			expect(panel.providerPromptTokens).toBe(150);
			expect(panel.categories.find(category => category.id === "messages")?.tokens).toBe(before.messagesTokens);
		} finally {
			await tempDir.remove();
		}
	});

	it("distinguishes absent provider usage from a successful zero-token report", async () => {
		const tempDir = TempDir.createSync("@context-zero-");
		try {
			const { session, sessionManager, agent } = createSession(tempDir);
			expect(session.getContextBreakdown()?.providerPromptTokens).toBeNull();
			expect(session.getContextBreakdown()?.providerPromptStatus).toBe("unavailable");
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "empty report" }],
				api: mockModel.api,
				provider: mockModel.provider,
				model: mockModel.id,
				stopReason: "stop",
				timestamp: 1000,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as AssistantMessage);
			syncSession(session, agent);
			expect(session.getContextBreakdown()?.providerPromptTokens).toBe(0);
			expect(session.getContextBreakdown()?.providerPromptStatus).toBe("current");
		} finally {
			await tempDir.remove();
		}
	});

	it("marks an earlier provider measurement stale after compaction or model change and ignores failed records", async () => {
		const tempDir = TempDir.createSync("@context-stale-");
		try {
			const { session, sessionManager, agent } = createSession(tempDir);
			const response = (stopReason: AssistantMessage["stopReason"], input: number, timestamp: number) =>
				({
					role: "assistant",
					content: [{ type: "text", text: "response" }],
					api: mockModel.api,
					provider: mockModel.provider,
					model: mockModel.id,
					stopReason,
					timestamp,
					usage: {
						input,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: input,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}) as AssistantMessage;
			const anchor = sessionManager.appendMessage(response("stop", 400, 1000));
			sessionManager.appendMessage(response("aborted", 900, 2000));
			sessionManager.appendMessage(response("error", 800, 3000));
			syncSession(session, agent);
			expect(session.getContextBreakdown()?.providerPromptTokens).toBe(400);
			agent.setModel({ ...mockModel, id: "different-model" });
			expect(session.getContextBreakdown()?.providerPromptTokens).toBe(400);
			expect(session.getContextBreakdown()?.providerPromptStatus).toBe("stale");
			agent.setModel(mockModel);
			sessionManager.appendCompaction("compact summary", "compact summary", anchor, 50);
			syncSession(session, agent);
			expect(session.getContextBreakdown()?.providerPromptTokens).toBe(400);
			expect(session.getContextBreakdown()?.providerPromptStatus).toBe("stale");
		} finally {
			await tempDir.remove();
		}
	});

	it("separates small or large provider prompt measurements from non-empty estimated categories and getContextUsage metadata", async () => {
		const tempDir = TempDir.createSync("@context-separation-");
		try {
			const probeSchema = z.object({ query: z.string(), limit: z.number().optional() });
			const probeTool = {
				name: "probe_search",
				label: "Probe Search",
				description: "Search project symbols and documentation entries",
				parameters: probeSchema,
				async execute() {
					return { content: [{ type: "text" as const, text: "ok" }] };
				},
			};
			const skills: Skill[] = [
				{
					name: "context-probe-skill",
					description: "Detailed skill description used solely for local non-message category estimation",
					filePath: path.join(tempDir.path(), "SKILL.md"),
					baseDir: tempDir.path(),
					source: "test",
				},
			];
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: mockModel,
					systemPrompt: [
						"Base system prompt with <skills>context-probe-skill</skills> instructions.",
						"Additional dynamic system context block for repository state.",
					],
					tools: [probeTool],
					messages: [],
				},
				streamFn: mockModel.stream,
			});
			const session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({
					"compaction.enabled": true,
					"compaction.autoContinue": false,
					"compaction.strategy": "context-full",
					"compaction.thresholdTokens": 8000,
				}),
				modelRegistry,
				skills,
			});

			const user = { role: "user", content: "Explain the context separation contract.", timestamp: 1000 } as Message;
			// Intentionally smaller than non-message category estimates: old `usedTokens - categoryNonMessageTokens`
			// would clamp messagesTokens to 0.
			const smallAssistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "short reply" }],
				api: mockModel.api,
				provider: mockModel.provider,
				model: mockModel.id,
				stopReason: "stop",
				timestamp: 2000,
				usage: {
					input: 12,
					output: 8,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			sessionManager.appendMessage(user);
			sessionManager.appendMessage(smallAssistant);
			syncSession(session, agent);

			const expectedMessagesTokens = estimateTokens(user) + estimateTokens(smallAssistant);
			const smallBreakdown = session.getContextBreakdown()!;
			expect(smallBreakdown.providerPromptTokens).toBe(12);
			expect(smallBreakdown.providerPromptStatus).toBe("current");
			expect(smallBreakdown.contextEstimateKind).toBe("mixed");
			expect(smallBreakdown.messagesTokens).toBe(expectedMessagesTokens);
			expect(smallBreakdown.systemToolsTokens).toBeGreaterThan(0);
			expect(smallBreakdown.systemContextTokens).toBeGreaterThan(0);
			expect(smallBreakdown.skillsTokens).toBeGreaterThan(0);

			const smallUsage = session.getContextUsage()!;
			expect(smallUsage.providerPromptTokens).toBe(12);
			expect(smallUsage.providerPromptStatus).toBe("current");
			expect(smallUsage.estimateKind).toBe("mixed");

			// Provider measurement much larger than local estimates must not inflate messagesTokens either.
			const largeAssistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: mockModel.api,
				provider: mockModel.provider,
				model: mockModel.id,
				stopReason: "stop",
				timestamp: 3000,
				usage: {
					input: 5000,
					output: 10,
					cacheRead: 500,
					cacheWrite: 0,
					totalTokens: 5510,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			sessionManager.appendMessage(largeAssistant);
			syncSession(session, agent);

			const largeBreakdown = session.getContextBreakdown()!;
			expect(largeBreakdown.providerPromptTokens).toBe(5500);
			expect(largeBreakdown.providerPromptStatus).toBe("current");
			expect(largeBreakdown.contextEstimateKind).toBe("mixed");
			expect(largeBreakdown.messagesTokens).toBe(expectedMessagesTokens + estimateTokens(largeAssistant));
			const panel = computeContextBreakdown(session);
			expect(panel.providerPromptTokens).toBe(5500);
			expect(panel.providerPromptStatus).toBe("current");
			expect(panel.contextEstimateKind).toBe("mixed");
			expect(panel.categories.find(category => category.id === "messages")?.tokens).toBe(
				largeBreakdown.messagesTokens,
			);
		} finally {
			await tempDir.remove();
		}
	});

	it("never double-counts nonMessageTokens or output tokens on top of provider promptTokens", async () => {
		const tempDir = TempDir.createSync("@context-no-double-count-");
		try {
			const firstSchema = z.object({ path: z.string() });
			const firstTool = {
				name: "read_file",
				label: "Read File",
				description: "Read a file from disk",
				parameters: firstSchema,
				async execute() {
					return { content: [{ type: "text" as const, text: "ok" }] };
				},
			};
			const { session, sessionManager, agent } = createSession(tempDir);
			agent.setSystemPrompt([
				"Detailed system prompt instructions for engineering tasks.",
				"Repository context metadata.",
			]);
			agent.setTools([firstTool]);

			const initialNonMessage = computeNonMessageTokens(session);
			expect(initialNonMessage).toBeGreaterThan(20);

			const user = { role: "user", content: "Inspect the file.", timestamp: 1000 } as Message;
			const assistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Done inspecting." }],
				api: mockModel.api,
				provider: mockModel.provider,
				model: mockModel.id,
				stopReason: "stop",
				timestamp: 2000,
				usage: {
					input: 700,
					output: 150,
					cacheRead: 200,
					cacheWrite: 100,
					totalTokens: 1150,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				contextSnapshot: {
					promptTokens: 1000,
					nonMessageTokens: initialNonMessage,
				},
			};
			sessionManager.appendMessage(user);
			sessionManager.appendMessage(assistant);
			syncSession(session, agent);

			const breakdown = session.getContextBreakdown()!;
			// promptTokens (1000 = 700 + 200 + 100) already includes system prompt + tools + messages up to anchor.
			expect(breakdown.providerPromptTokens).toBe(1000);
			expect(breakdown.usedTokens).toBe(1000);

			// Adding a new tool adds ONLY the delta of nonMessageTokens to usedTokens, and never mutates providerPromptTokens.
			const secondSchema = z.object({ pattern: z.string(), limit: z.number() });
			const secondTool = {
				name: "grep_files",
				label: "Grep Files",
				description: "Search across files with regex patterns",
				parameters: secondSchema,
				async execute() {
					return { content: [{ type: "text" as const, text: "ok" }] };
				},
			};
			agent.setTools([firstTool, secondTool]);
			const expandedNonMessage = computeNonMessageTokens(session);
			expect(expandedNonMessage).toBeGreaterThan(initialNonMessage);

			const afterToolAdd = session.getContextBreakdown()!;
			expect(afterToolAdd.providerPromptTokens).toBe(1000);
			expect(afterToolAdd.usedTokens).toBe(1000 + (expandedNonMessage - initialNonMessage));

			const panel = computeContextBreakdown(session);
			expect(panel.providerPromptTokens).toBe(1000);
			expect(panel.usedTokens).toBe(afterToolAdd.usedTokens);
		} finally {
			await tempDir.remove();
		}
	});

	it("re-anchors after compaction and ignores post-compaction aborted/error records", async () => {
		const tempDir = TempDir.createSync("@context-compaction-reanchor-");
		try {
			const { session, sessionManager, agent } = createSession(tempDir);
			const makeAssistant = (
				stopReason: AssistantMessage["stopReason"],
				input: number,
				timestamp: number,
			): AssistantMessage => ({
				role: "assistant",
				content: [{ type: "text", text: `reply-${timestamp}` }],
				api: mockModel.api,
				provider: mockModel.provider,
				model: mockModel.id,
				stopReason,
				timestamp,
				usage: {
					input,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: input + 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});

			const anchorId = sessionManager.appendMessage(makeAssistant("stop", 1200, 1000));
			sessionManager.appendCompaction("compacted summary", "compacted summary", anchorId, 60);
			syncSession(session, agent);

			const rightAfterCompaction = session.getContextBreakdown()!;
			expect(rightAfterCompaction.anchored).toBe(false);
			expect(rightAfterCompaction.providerPromptTokens).toBe(1200);
			expect(rightAfterCompaction.providerPromptStatus).toBe("stale");
			expect(rightAfterCompaction.contextEstimateKind).toBe("estimated");
			expect(rightAfterCompaction.usedTokens).toBe(
				computeNonMessageTokens(session) + rightAfterCompaction.messagesTokens,
			);

			// Aborted/error turns after compaction must not clear stale status or steal the anchor.
			sessionManager.appendMessage({ role: "user", content: "after compact", timestamp: 2000 } as Message);
			sessionManager.appendMessage(makeAssistant("aborted", 9999, 2500));
			sessionManager.appendMessage(makeAssistant("error", 8888, 2600));
			syncSession(session, agent);

			const afterPostCompactAbort = session.getContextBreakdown()!;
			expect(afterPostCompactAbort.anchored).toBe(false);
			expect(afterPostCompactAbort.providerPromptTokens).toBe(1200);
			expect(afterPostCompactAbort.providerPromptStatus).toBe("stale");
			expect(afterPostCompactAbort.contextEstimateKind).toBe("estimated");

			// A successful post-compaction assistant turn establishes a fresh current anchor.
			sessionManager.appendMessage(makeAssistant("stop", 240, 3000));
			syncSession(session, agent);

			const reanchored = session.getContextBreakdown()!;
			expect(reanchored.anchored).toBe(true);
			expect(reanchored.providerPromptTokens).toBe(240);
			expect(reanchored.providerPromptStatus).toBe("current");
			expect(reanchored.contextEstimateKind).toBe("mixed");
			expect(reanchored.usedTokens).toBe(240);
		} finally {
			await tempDir.remove();
		}
	});

	it("handles session.setModel switches, rejected switches, and re-anchoring on the new model", async () => {
		const tempDir = TempDir.createSync("@context-model-switch-");
		try {
			const { session, sessionManager, agent } = createSession(tempDir);
			const user = { role: "user", content: "hello", timestamp: 1000 } as Message;
			const firstAssistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "first model reply" }],
				api: mockModel.api,
				provider: mockModel.provider,
				model: mockModel.id,
				stopReason: "stop",
				timestamp: 2000,
				usage: {
					input: 450,
					output: 15,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 465,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			sessionManager.appendMessage(user);
			sessionManager.appendMessage(firstAssistant);
			syncSession(session, agent);

			expect(session.getContextBreakdown()?.providerPromptStatus).toBe("current");

			// Rejected switch (target window smaller than currentContextTokens) must leave model & status current.
			const tinyModel: Model = { ...mockModel, id: "gpt-tiny", contextWindow: 100 };
			const rejected = await session.setModel(tinyModel, "default", { currentContextTokens: 450 });
			expect(rejected.switched).toBe(false);
			expect(session.getContextBreakdown()?.providerPromptStatus).toBe("current");
			expect(session.getContextBreakdown()?.providerPromptTokens).toBe(450);

			// Successful switch marks previous provider measurement stale and falls back to full local estimation.
			const switchedModel: Model = { ...mockModel, id: "gpt-switched", contextWindow: 200_000 };
			const switched = await session.setModel(switchedModel);
			expect(switched.switched).toBe(true);

			const staleAfterSwitch = session.getContextBreakdown()!;
			expect(staleAfterSwitch.providerPromptTokens).toBe(450);
			expect(staleAfterSwitch.providerPromptStatus).toBe("stale");
			expect(staleAfterSwitch.anchored).toBe(false);
			expect(staleAfterSwitch.contextEstimateKind).toBe("estimated");
			expect(staleAfterSwitch.usedTokens).toBe(computeNonMessageTokens(session) + staleAfterSwitch.messagesTokens);

			// A completed response from the new model restores current provider measurement.
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "new model reply" }],
				api: switchedModel.api,
				provider: switchedModel.provider,
				model: switchedModel.id,
				stopReason: "stop",
				timestamp: 3000,
				usage: {
					input: 620,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 640,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as AssistantMessage);
			syncSession(session, agent);

			const afterNewTurn = session.getContextBreakdown()!;
			expect(afterNewTurn.providerPromptTokens).toBe(620);
			expect(afterNewTurn.providerPromptStatus).toBe("current");
			expect(afterNewTurn.anchored).toBe(true);
			expect(afterNewTurn.contextEstimateKind).toBe("mixed");
		} finally {
			await tempDir.remove();
		}
	});

	it("ignores aborted-only turns and clears live pending snapshot on session.abort()", async () => {
		const tempDir = TempDir.createSync("@context-aborted-");
		try {
			const { session, sessionManager, agent } = createSession(tempDir);
			sessionManager.appendMessage({ role: "user", content: "initial", timestamp: 1000 } as Message);
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "aborted partial" }],
				api: mockModel.api,
				provider: mockModel.provider,
				model: mockModel.id,
				stopReason: "aborted",
				timestamp: 2000,
				usage: {
					input: 950,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 955,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as AssistantMessage);
			syncSession(session, agent);

			const abortedOnly = session.getContextBreakdown()!;
			expect(abortedOnly.providerPromptTokens).toBeNull();
			expect(abortedOnly.providerPromptStatus).toBe("unavailable");
			expect(abortedOnly.anchored).toBe(false);
			expect(abortedOnly.contextEstimateKind).toBe("estimated");

			// Record a real anchor, then start a prompt and abort it mid-flight.
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "valid reply" }],
				api: mockModel.api,
				provider: mockModel.provider,
				model: mockModel.id,
				stopReason: "stop",
				timestamp: 3000,
				usage: {
					input: 300,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 310,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as AssistantMessage);
			syncSession(session, agent);

			const sl = new StatusLineComponent(session);
			expect(sl.getCachedContextBreakdown().usedTokens).toBe(300);

			const gate = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			const promptSpy = vi.spyOn(agent, "prompt").mockImplementation(async () => {
				started.resolve();
				await gate.promise;
			});
			const revisionBeforePrompt = session.contextUsageRevision;
			const bigQuestion = "in-flight question that will be aborted ".repeat(40);
			const promptPromise = session.prompt(bigQuestion);
			await started.promise;

			expect(session.contextUsageRevision).toBeGreaterThan(revisionBeforePrompt);
			const duringFlight = sl.getCachedContextBreakdown();
			expect(duringFlight.usedTokens).toBeGreaterThan(350);
			expect(session.getContextBreakdown()?.providerPromptTokens).toBe(300);

			const revisionDuringFlight = session.contextUsageRevision;
			gate.resolve();
			await session.abort();
			await promptPromise;
			promptSpy.mockRestore();

			expect(session.contextUsageRevision).toBeGreaterThan(revisionDuringFlight);
			const afterAbort = session.getContextBreakdown()!;
			expect(afterAbort.providerPromptTokens).toBe(300);
			expect(afterAbort.providerPromptStatus).toBe("current");
			expect(sl.getCachedContextBreakdown().usedTokens).toBe(afterAbort.usedTokens);

			// Unknown / zero context window remains honest without throwing or emitting NaN.
			const zeroWindow = session.getContextBreakdown({ contextWindow: 0 })!;
			expect(zeroWindow.contextWindow).toBe(0);
			const zeroUsage = session.getContextUsage({ contextWindow: 0 })!;
			expect(zeroUsage.contextWindow).toBe(0);
			expect(zeroUsage.percent).toBe(0);
			expect(
				renderContextUsage({ ...computeContextBreakdown(session), contextWindow: 0 }, {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				} as never),
			).toContain("Context usage is unavailable: no model is selected for this session.");
		} finally {
			await tempDir.remove();
		}
	});
});
