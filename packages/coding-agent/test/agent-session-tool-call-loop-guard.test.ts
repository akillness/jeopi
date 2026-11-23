import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "arktype";
import { Agent, type AgentTool } from "jeopi-agent-core";
import type { AssistantMessage, Context } from "jeopi-ai";
import { createMockModel } from "jeopi-ai/providers/mock";
import { AssistantMessageEventStream } from "jeopi-ai/utils/event-stream";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { AgentSession } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { type CustomMessage, convertToLlm } from "jeopi-cli/session/messages";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { TempDir } from "jeopi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession tool-call loop guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-tool-call-loop-guard-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("redirects once, pauses an unchanged loop, and accepts the next prompt", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "1263 passed, 4 skipped" }] }),
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const toolCallTurn = callCount < 10;
				const toolCallId = `tc-${callCount}`;
				callCount++;
				const message: AssistantMessage = toolCallTurn
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pytest -q" } }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Stopped repeating." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolCallTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 5,
			"model.toolCallLoopGuard.exemptTools": ["job", "irc"],
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		await session.prompt("run checks");
		await session.waitForIdle();

		expect(contexts).toHaveLength(10);
		expect(notices.some(text => text.includes("Paused: repeated bash"))).toBe(true);
		await session.prompt("summarize instead");
		await session.waitForIdle();
		expect(contexts).toHaveLength(11);
		expect(JSON.stringify(contexts[5]!.messages)).toContain("tool_call_loop_detected");
		expect(JSON.stringify(contexts[5]!.messages)).toContain("1263 passed, 4 skipped");
		const redirects = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "tool-call-loop-redirect",
		);
		expect(redirects).toHaveLength(1);
		expect(redirects[0]!.display).toBe(false);
	});
	it("injects a hidden redirect when the model alternates between two tools without progress", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "bash output" }] }),
		};
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Mock read tool",
			parameters: type({ "path?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "file contents" }] }),
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool, readTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const alternating = callCount < 6;
				const toolCallId = `tc-${callCount}`;
				const useBash = callCount % 2 === 0;
				callCount++;
				const message: AssistantMessage = alternating
					? {
							role: "assistant",
							content: [
								useBash
									? { type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "ls" } }
									: { type: "toolCall", id: toolCallId, name: "read", arguments: { path: "a.ts" } },
							],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Stopped alternating." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: alternating ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 100,
			"model.toolCallLoopGuard.exemptTools": ["job", "irc"],
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([
				[bashTool.name, bashTool],
				[readTool.name, readTool],
			]),
		});

		await session.prompt("investigate");
		await session.waitForIdle();

		expect(JSON.stringify(contexts.at(-1)!.messages)).toContain("tool_call_cycle_detected");
		const redirects = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "tool-call-cycle-redirect",
		);
		expect(redirects).toHaveLength(1);
		expect(redirects[0]!.display).toBe(false);
		expect(redirects[0]!.details).toMatchObject({ toolNames: ["bash", "read"], windowSize: 6 });
	});

	it("escalates to a hard pause after maxRedirectsBeforeStop redirects even when outputs vary, and resets on the next user prompt", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		let execCount = 0;
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: `run output #${++execCount}` }] }),
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: () => {
				const turnIndex = callCount++;
				// First prompt hits 3 distinct repeated streaks (3x each) with varying outputs -> escalates on turn 9.
				// Second prompt makes 1 tool call (turn 9) then finishes (turn 10).
				const toolUse = turnIndex < 10;
				const cmd = `echo streak-${Math.floor(turnIndex / 3)}`;
				const message: AssistantMessage = toolUse
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: `tc-${turnIndex}`, name: "bash", arguments: { command: cmd } }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Done on second prompt." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 3,
			"model.toolCallLoopGuard.maxRedirectsBeforeStop": 2,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});

		await session.prompt("check status");
		await session.waitForIdle();

		// Threshold 3, maxRedirectsBeforeStop 2 -> redirects at 3 and 6, pauses at 9 (even with varying output).
		expect(callCount).toBe(9);
		expect(notices.some(text => text.includes("persisted across multiple loop warnings"))).toBe(true);

		// A fresh user prompt resets the loop guard instead of immediately re-pausing.
		const noticesBeforeSecondPrompt = notices.length;
		await session.prompt("try one fresh check");
		await session.waitForIdle();
		expect(notices.slice(noticesBeforeSecondPrompt).some(text => text.includes("Paused:"))).toBe(false);
	});

	it("emits workflowGuard soft budget warning and pauses with telemetry when maxOutputTokensPerRun is exceeded", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		let toolSeq = 0;
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: `ok-${++toolSeq}` }] }),
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: () => {
				const turnIndex = callCount++;
				const message: AssistantMessage = {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: `tc-${turnIndex}`,
							name: "bash",
							arguments: { command: `echo step-${turnIndex}` },
						},
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 50,
						output: 450,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 500,
						cost: { input: 0.001, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.011 },
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.workflowGuard.maxOutputTokensPerRun": 1000,
			"model.workflowGuard.softBudgetWarningRatio": 0.8,
			"model.workflowGuard.maxCostUsdPerRun": 0,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});

		await session.prompt("run long task");
		await session.waitForIdle();

		// Turn 1: 450 tokens; Turn 2: 900 tokens (>= 80% -> soft warning); Turn 3: 1350 tokens (>= 1000 -> hard stop).
		expect(callCount).toBe(3);
		expect(notices.some(text => text.includes("Approaching per-run"))).toBe(true);
		expect(notices.some(text => text.includes("token_budget_exceeded") && text.includes("output tokens"))).toBe(true);
	});
});
