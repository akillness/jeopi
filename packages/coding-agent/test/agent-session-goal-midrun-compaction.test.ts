import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "arktype";
import { Agent, type AgentMessage, type AgentTool } from "jeopi-agent-core";
import * as compactionModule from "jeopi-agent-core/compaction";
import { AssistantMessageEventStream } from "jeopi-ai/utils/event-stream";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "jeopi-cli/extensibility/extensions/loader";
import { ExtensionRunner } from "jeopi-cli/extensibility/extensions/runner";
import type { GoalModeState } from "jeopi-cli/goals/state";
import { AgentSession } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { convertToLlm } from "jeopi-cli/session/messages";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { EventBus } from "jeopi-cli/utils/event-bus";
import { TempDir } from "jeopi-utils";

function activeGoalState(): GoalModeState {
	const now = Date.now();
	return {
		enabled: true,
		mode: "active",
		goal: {
			id: "goal-midrun-compaction",
			objective: "Ship the release",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		},
	};
}

function highUsage(input: number) {
	return {
		input,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("AgentSession mid-run threshold compaction", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-goal-midrun-compaction-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(
		settingsOverride: Record<string, unknown> = {},
		options: { extensionRunner?: ExtensionRunner; toolOutput?: string } = {},
	): Promise<{
		session: AgentSession;
		observedContexts: string[][];
		sessionManager: SessionManager;
		modelRegistry: ModelRegistry;
	}> {
		const observedContexts: string[][] = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `testauth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${cleanups.length}.yml`));
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.autoContinue": true,
			"compaction.midTurnEnabled": true,
			"compaction.thresholdTokens": 1000,
			"compaction.thresholdPercent": -1,
			"contextPromotion.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			...settingsOverride,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: options.toolOutput ?? "tool output" }] }),
		};

		let call = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockBashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				const index = call++;
				observedContexts.push(context.messages.map(message => JSON.stringify(message)));
				const stream = new AssistantMessageEventStream();
				const isToolTurn = index === 0;
				const message = isToolTurn
					? {
							role: "assistant" as const,
							content: [
								{ type: "toolCall" as const, id: `tc-${index}`, name: "bash", arguments: { cmd: "pwd" } },
							],
							api: "anthropic-messages" as const,
							provider: "anthropic" as const,
							model: "claude-sonnet-4-5",
							usage: highUsage(50_000),
							stopReason: "toolUse" as const,
							timestamp: Date.now(),
						}
					: {
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "All done." }],
							api: "anthropic-messages" as const,
							provider: "anthropic" as const,
							model: "claude-sonnet-4-5",
							usage: highUsage(200),
							stopReason: "stop" as const,
							timestamp: Date.now(),
						};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[mockBashTool.name, mockBashTool]]),
			extensionRunner: options.extensionRunner,
		});

		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, sessionManager, observedContexts, modelRegistry };
	}

	function mockCompaction(summary: string) {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary,
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	async function createCompactionRunner(onCompact?: () => void) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_compact", event => {
					onCompact?.();
					return { compaction: {
						summary: "COMPACTED",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					} };
				});
			},
			tempDir.path(), new EventBus(), runtime, "compaction-fixture",
		);
		const auth = await AuthStorage.create(path.join(tempDir.path(), "extension-auth.db"));
		cleanups.push(async () => auth.close());
		return new ExtensionRunner([extension], runtime, tempDir.path(), SessionManager.inMemory(), new ModelRegistry(auth));
	}

	async function createCancelCompactionRunner() {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_compact", () => ({ cancel: true }));
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"compaction-cancel-fixture",
		);
		const auth = await AuthStorage.create(path.join(tempDir.path(), `extension-auth-cancel-${cleanups.length}.db`));
		cleanups.push(async () => auth.close());
		return new ExtensionRunner([extension], runtime, tempDir.path(), SessionManager.inMemory(), new ModelRegistry(auth));
	}

	it("pauses before another provider call when a retained tool result leaves no headroom", async () => {
		let session: AgentSession;
		const runner = await createCompactionRunner();
		const harness = await createHarness({}, { extensionRunner: runner, toolOutput: "oversized output ".repeat(3000) });
		({ session } = harness);
		const { observedContexts } = harness;
		const notices: string[] = [];
		let queued = false;
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
			if (event.type === "auto_compaction_start" && !queued) {
				queued = true;
				session.agent.steer({ role: "user", content: "queued steering", timestamp: Date.now() });
				session.agent.followUp({ role: "user", content: "queued follow-up", timestamp: Date.now() });
			}
		});
		await session.prompt("work on the release");
		expect(notices.some(message => message.includes("Compaction freed too little context"))).toBe(true);
		expect(observedContexts).toHaveLength(1);
		expect(session.agent.peekSteeringQueue().map(message => JSON.stringify(message)).join("\n")).toContain("queued steering");
		expect(session.agent.peekFollowUpQueue().map(message => JSON.stringify(message)).join("\n")).toContain("queued follow-up");
		const history = session.agent.state.messages.map(message => JSON.stringify(message));
		const call = history.findIndex(message => message.includes('"id":"tc-0"'));
		const result = history.findIndex(message => message.includes('"toolCallId":"tc-0"'));
		expect(call).toBeGreaterThanOrEqual(0);
		expect(result).toBeGreaterThan(call);
		await session.prompt("new user request", { skipCompactionCheck: true });
		expect(observedContexts[1].join("\n")).toContain("new user request");
		expect(observedContexts.slice(1).flat().join("\n")).toContain("queued steering");
		expect(observedContexts.slice(1).flat().join("\n")).toContain("queued follow-up");
	});

	it("continues with paired tool messages when compaction leaves headroom", async () => {
		const runner = await createCompactionRunner();
		const { session, observedContexts } = await createHarness({}, { extensionRunner: runner });
		await session.prompt("work on the release");
		expect(observedContexts).toHaveLength(2);
		const context = observedContexts[1];
		expect(context.join("\n")).toContain("COMPACTED");
		const call = context.findIndex(message => message.includes('"id":"tc-0"'));
		const result = context.findIndex(message => message.includes('"toolCallId":"tc-0"'));
		expect(call).toBeGreaterThanOrEqual(0);
		expect(result).toBeGreaterThan(call);
	});

	it("does not issue another provider request after cancellation during mid-run compaction", async () => {
		let session: AgentSession;
		let cancellation: Promise<void> | undefined;
		const runner = await createCompactionRunner(() => { cancellation = session.abort(); });
		const harness = await createHarness({}, { extensionRunner: runner });
		({ session } = harness);
		await session.prompt("work on the release");
		expect(cancellation).toBeDefined();
		await cancellation;
		expect(harness.observedContexts).toHaveLength(1);
	});

	it("compacts in place between tool-call turns outside goal mode", async () => {
		const { session, observedContexts } = await createHarness();
		const compactSpy = mockCompaction("MID-RUN-COMPACTED");

		await session.prompt("work on the release");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		expect(observedContexts[1].join("\n")).toContain("MID-RUN-COMPACTED");
	});

	it("compacts in place between tool-call turns during an active goal run", async () => {
		const { session, observedContexts } = await createHarness();
		session.setGoalModeState(activeGoalState());
		const compactSpy = mockCompaction("ACTIVE-GOAL-MID-RUN-COMPACTED");

		await session.prompt("work on the release");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		expect(observedContexts[1].join("\n")).toContain("ACTIVE-GOAL-MID-RUN-COMPACTED");
	});

	it("falls back to in-place compaction for mid-run handoff strategy", async () => {
		const { session, observedContexts } = await createHarness({ "compaction.strategy": "handoff" });
		const handoffSpy = vi.spyOn(session, "handoff").mockImplementation(async () => {
			throw new Error("mid-run compaction must not reset the session through handoff");
		});
		const compactSpy = mockCompaction("HANDOFF-MID-RUN-COMPACTED-IN-PLACE");

		await session.prompt("work on the release");

		expect(handoffSpy).not.toHaveBeenCalled();
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts[1].join("\n")).toContain("HANDOFF-MID-RUN-COMPACTED-IN-PLACE");
	});

	it("preserves the just-finished tool turn when message_end hooks are still pending", async () => {
		const releaseMessageEnd = Promise.withResolvers<void>();
		const messageEndEntered = Promise.withResolvers<void>();
		const turnEndEntered = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "message_end" || eventType === "turn_end"),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			emit: vi.fn(async (event: { type: string; message?: AgentMessage }) => {
				if (event.type === "turn_end") {
					turnEndEntered.resolve();
					return;
				}
				if (
					event.type === "message_end" &&
					event.message?.role === "assistant" &&
					event.message.stopReason === "toolUse"
				) {
					messageEndEntered.resolve();
					await releaseMessageEnd.promise;
				}
			}),
		} as unknown as ExtensionRunner;
		const { session, sessionManager, observedContexts } = await createHarness({}, { extensionRunner });
		const compactSpy = mockCompaction("MID-RUN-COMPACTED-WITH-PENDING-HOOK");

		const prompt = session.prompt("work on the release");
		await messageEndEntered.promise;
		await turnEndEntered.promise;
		releaseMessageEnd.resolve();
		await prompt;

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		const nextProviderContext = observedContexts[1];
		const toolUseAssistantIndex = nextProviderContext.findIndex(
			serialized =>
				serialized.includes('"role":"assistant"') &&
				serialized.includes('"stopReason":"toolUse"') &&
				serialized.includes('"id":"tc-0"'),
		);
		const toolResultIndex = nextProviderContext.findIndex(
			serialized => serialized.includes('"role":"toolResult"') && serialized.includes('"toolCallId":"tc-0"'),
		);
		expect(toolUseAssistantIndex).toBeGreaterThanOrEqual(0);
		expect(toolResultIndex).toBeGreaterThan(toolUseAssistantIndex);
		expect(nextProviderContext.filter(serialized => serialized.includes('"id":"tc-0"'))).toHaveLength(1);
		expect(nextProviderContext.filter(serialized => serialized.includes('"toolCallId":"tc-0"'))).toHaveLength(1);
		expect(nextProviderContext.join("\n")).toContain("MID-RUN-COMPACTED-WITH-PENDING-HOOK");
		expect(nextProviderContext.join("\n")).toContain("tool output");

		const persistedToolTurnRoles = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message)
			.filter(message => {
				const serialized = JSON.stringify(message);
				return (
					(message.role === "assistant" || message.role === "toolResult") &&
					(serialized.includes('"id":"tc-0"') || serialized.includes('"toolCallId":"tc-0"'))
				);
			})
			.map(message => message.role);
		expect(persistedToolTurnRoles).toEqual(["assistant", "toolResult"]);
	});

	it("treats same-key assistant content variants as persisted before mid-run compaction", async () => {
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("message_end", event => {
					if (event.message.role !== "assistant" || event.message.stopReason !== "toolUse") return;
					const [block] = event.message.content;
					if (block?.type !== "toolCall") return;
					event.message.content = [{ ...block, arguments: { cmd: "display-variant" } }];
				});
			},
			tempDir.path(),
			new EventBus(),
			extensionRuntime,
			"assistant-display-variant",
		);
		const extensionAuthStorage = await AuthStorage.create(path.join(tempDir.path(), "extension-auth-variant.db"));
		cleanups.push(async () => {
			extensionAuthStorage.close();
		});
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir.path(),
			SessionManager.inMemory(),
			new ModelRegistry(extensionAuthStorage, path.join(tempDir.path(), "extension-models-variant.yml")),
		);
		const { session, observedContexts } = await createHarness({}, { extensionRunner });
		const compactSpy = mockCompaction("MID-RUN-COMPACTED-WITH-CONTENT-VARIANT");

		await session.prompt("work on the release");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		expect(observedContexts[1].join("\n")).toContain("MID-RUN-COMPACTED-WITH-CONTENT-VARIANT");
	});

	it("does not compact mid-run outside goal mode when disabled", async () => {
		const { session } = await createHarness({ "compaction.midTurnEnabled": false });
		const compactSpy = mockCompaction("SHOULD-NOT-RUN");

		await session.prompt("work on the release");

		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("does not compact mid-run during active goal mode when disabled", async () => {
		const { session } = await createHarness({ "compaction.midTurnEnabled": false });
		session.setGoalModeState(activeGoalState());
		const compactSpy = mockCompaction("SHOULD-NOT-RUN");

		await session.prompt("work on the release");

		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("pauses mid-run and preserves queued steering when no compaction model is available and no headroom remains", async () => {
		const { session, observedContexts, modelRegistry } = await createHarness();
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([]);
		const compactionEnds: Array<{ skipped?: boolean; aborted?: boolean; errorMessage?: string }> = [];
		let queued = false;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start" && !queued) {
				queued = true;
				session.agent.steer({ role: "user", content: "queued steering", timestamp: Date.now() });
				session.agent.followUp({ role: "user", content: "queued follow-up", timestamp: Date.now() });
			}
			if (event.type === "auto_compaction_end") {
				compactionEnds.push({
					skipped: event.skipped,
					aborted: event.aborted,
					errorMessage: event.errorMessage,
				});
			}
		});

		await session.prompt("work on the release");

		expect(compactionEnds).toEqual([expect.objectContaining({ skipped: true })]);
		expect(observedContexts).toHaveLength(1);
		expect(session.agent.peekSteeringQueue().map(message => JSON.stringify(message)).join("\n")).toContain(
			"queued steering",
		);
		expect(session.agent.peekFollowUpQueue().map(message => JSON.stringify(message)).join("\n")).toContain(
			"queued follow-up",
		);
		const history = session.agent.state.messages.map(message => JSON.stringify(message));
		const call = history.findIndex(message => message.includes('"id":"tc-0"'));
		const result = history.findIndex(message => message.includes('"toolCallId":"tc-0"'));
		expect(call).toBeGreaterThanOrEqual(0);
		expect(result).toBeGreaterThan(call);

		await session.prompt("new user request", { skipCompactionCheck: true });
		expect(observedContexts[1].join("\n")).toContain("new user request");
		expect(observedContexts.slice(1).flat().join("\n")).toContain("queued steering");
		expect(observedContexts.slice(1).flat().join("\n")).toContain("queued follow-up");
	});

	it("pauses mid-run and preserves queued steering when summarizer fails and no headroom remains", async () => {
		const { session, observedContexts } = await createHarness();
		const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(new Error("summarizer unavailable"));
		const compactionEnds: Array<{ skipped?: boolean; aborted?: boolean; errorMessage?: string }> = [];
		let queued = false;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start" && !queued) {
				queued = true;
				session.agent.steer({ role: "user", content: "queued steering", timestamp: Date.now() });
				session.agent.followUp({ role: "user", content: "queued follow-up", timestamp: Date.now() });
			}
			if (event.type === "auto_compaction_end") {
				compactionEnds.push({
					skipped: event.skipped,
					aborted: event.aborted,
					errorMessage: event.errorMessage,
				});
			}
		});

		await session.prompt("work on the release");

		expect(compactSpy).toHaveBeenCalled();
		expect(compactionEnds).toEqual([
			expect.objectContaining({ errorMessage: expect.stringContaining("summarizer unavailable") }),
		]);
		expect(observedContexts).toHaveLength(1);
		expect(session.agent.peekSteeringQueue().map(message => JSON.stringify(message)).join("\n")).toContain(
			"queued steering",
		);
		expect(session.agent.peekFollowUpQueue().map(message => JSON.stringify(message)).join("\n")).toContain(
			"queued follow-up",
		);
		const history = session.agent.state.messages.map(message => JSON.stringify(message));
		const call = history.findIndex(message => message.includes('"id":"tc-0"'));
		const result = history.findIndex(message => message.includes('"toolCallId":"tc-0"'));
		expect(call).toBeGreaterThanOrEqual(0);
		expect(result).toBeGreaterThan(call);

		await session.prompt("new user request", { skipCompactionCheck: true });
		expect(observedContexts[1].join("\n")).toContain("new user request");
		expect(observedContexts.slice(1).flat().join("\n")).toContain("queued steering");
		expect(observedContexts.slice(1).flat().join("\n")).toContain("queued follow-up");
	});

	it("pauses mid-run and preserves queued steering when hook cancels compaction and no headroom remains", async () => {
		const runner = await createCancelCompactionRunner();
		const { session, observedContexts } = await createHarness({}, { extensionRunner: runner });
		const compactionEnds: Array<{ skipped?: boolean; aborted?: boolean; errorMessage?: string }> = [];
		let queued = false;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start" && !queued) {
				queued = true;
				session.agent.steer({ role: "user", content: "queued steering", timestamp: Date.now() });
				session.agent.followUp({ role: "user", content: "queued follow-up", timestamp: Date.now() });
			}
			if (event.type === "auto_compaction_end") {
				compactionEnds.push({
					skipped: event.skipped,
					aborted: event.aborted,
					errorMessage: event.errorMessage,
				});
			}
		});

		await session.prompt("work on the release");

		expect(compactionEnds).toEqual([expect.objectContaining({ aborted: true })]);
		expect(observedContexts).toHaveLength(1);
		expect(session.agent.peekSteeringQueue().map(message => JSON.stringify(message)).join("\n")).toContain(
			"queued steering",
		);
		expect(session.agent.peekFollowUpQueue().map(message => JSON.stringify(message)).join("\n")).toContain(
			"queued follow-up",
		);
		const history = session.agent.state.messages.map(message => JSON.stringify(message));
		const call = history.findIndex(message => message.includes('"id":"tc-0"'));
		const result = history.findIndex(message => message.includes('"toolCallId":"tc-0"'));
		expect(call).toBeGreaterThanOrEqual(0);
		expect(result).toBeGreaterThan(call);

		await session.prompt("new user request", { skipCompactionCheck: true });
		expect(observedContexts[1].join("\n")).toContain("new user request");
		expect(observedContexts.slice(1).flat().join("\n")).toContain("queued steering");
		expect(observedContexts.slice(1).flat().join("\n")).toContain("queued follow-up");
	});

	it("pauses mid-run and preserves queued steering when shake fails and no headroom remains", async () => {
		const { session, observedContexts } = await createHarness({ "compaction.strategy": "shake" });
		const shakeSpy = vi.spyOn(session, "shake").mockRejectedValue(new Error("shake unavailable"));
		const compactionEnds: Array<{ skipped?: boolean; aborted?: boolean; errorMessage?: string }> = [];
		let queued = false;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start" && !queued) {
				queued = true;
				session.agent.steer({ role: "user", content: "queued steering", timestamp: Date.now() });
				session.agent.followUp({ role: "user", content: "queued follow-up", timestamp: Date.now() });
			}
			if (event.type === "auto_compaction_end") {
				compactionEnds.push({
					skipped: event.skipped,
					aborted: event.aborted,
					errorMessage: event.errorMessage,
				});
			}
		});

		await session.prompt("work on the release");

		expect(shakeSpy).toHaveBeenCalledTimes(1);
		expect(compactionEnds).toEqual([
			expect.objectContaining({ errorMessage: expect.stringContaining("shake unavailable") }),
		]);
		expect(observedContexts).toHaveLength(1);
		expect(session.agent.peekSteeringQueue().map(message => JSON.stringify(message)).join("\n")).toContain(
			"queued steering",
		);
		expect(session.agent.peekFollowUpQueue().map(message => JSON.stringify(message)).join("\n")).toContain(
			"queued follow-up",
		);
		const history = session.agent.state.messages.map(message => JSON.stringify(message));
		const call = history.findIndex(message => message.includes('"id":"tc-0"'));
		const result = history.findIndex(message => message.includes('"toolCallId":"tc-0"'));
		expect(call).toBeGreaterThanOrEqual(0);
		expect(result).toBeGreaterThan(call);

		await session.prompt("new user request", { skipCompactionCheck: true });
		expect(observedContexts[1].join("\n")).toContain("new user request");
		expect(observedContexts.slice(1).flat().join("\n")).toContain("queued steering");
		expect(observedContexts.slice(1).flat().join("\n")).toContain("queued follow-up");
	});

	it("continues mid-run and delivers queued steering alongside paired tool messages when compaction leaves headroom", async () => {
		const runner = await createCompactionRunner();
		const { session, observedContexts } = await createHarness({}, { extensionRunner: runner });
		let queued = false;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start" && !queued) {
				queued = true;
				session.agent.steer({ role: "user", content: "queued steering", timestamp: Date.now() });
			}
		});

		await session.prompt("work on the release");

		expect(observedContexts).toHaveLength(2);
		const context = observedContexts[1];
		expect(context.join("\n")).toContain("COMPACTED");
		expect(context.join("\n")).toContain("queued steering");
		const call = context.findIndex(message => message.includes('"id":"tc-0"'));
		const result = context.findIndex(message => message.includes('"toolCallId":"tc-0"'));
		expect(call).toBeGreaterThanOrEqual(0);
		expect(result).toBeGreaterThan(call);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
	});

	it("continues mid-run and delivers queued steering when shake frees headroom", async () => {
		const { session, observedContexts } = await createHarness({ "compaction.strategy": "shake" });
		const shakeSpy = vi.spyOn(session, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 1,
			blocksDropped: 0,
			tokensFreed: 50_000,
		});
		let queued = false;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start" && !queued) {
				queued = true;
				session.agent.steer({ role: "user", content: "queued steering", timestamp: Date.now() });
			}
		});

		await session.prompt("work on the release");

		expect(shakeSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts).toHaveLength(2);
		const context = observedContexts[1];
		expect(context.join("\n")).toContain("queued steering");
		const call = context.findIndex(message => message.includes('"id":"tc-0"'));
		const result = context.findIndex(message => message.includes('"toolCallId":"tc-0"'));
		expect(call).toBeGreaterThanOrEqual(0);
		expect(result).toBeGreaterThan(call);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
	});
});
