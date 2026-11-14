import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "jeopi-ai";
import type { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import type { LoadExtensionsResult } from "jeopi-cli/extensibility/extensions/types";
import { AgentProtocolHandler } from "jeopi-cli/internal-urls/agent-protocol";
import { registerArtifactsDir, resetRegisteredArtifactDirsForTests } from "jeopi-cli/internal-urls/registry-helpers";
import type { CreateAgentSessionResult } from "jeopi-cli/sdk";
import * as sdkModule from "jeopi-cli/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "jeopi-cli/session/agent-session";
import { TaskTool } from "jeopi-cli/task";
import * as discoveryModule from "jeopi-cli/task/discovery";
import * as executorModule from "jeopi-cli/task/executor";
import { runSubprocess } from "jeopi-cli/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "jeopi-cli/task/types";
import type { ToolSession } from "jeopi-cli/tools";
import { EventBus } from "jeopi-cli/utils/event-bus";
import { TempDir } from "jeopi-utils";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMockSession(
	onPrompt: (params: {
		text: string;
		options?: PromptOptions;
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		state: { messages: AssistantMessage[] };
	}) => void | Promise<void>,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	let promptIndex = 0;
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	return {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const idx = listeners.indexOf(listener);
				if (idx >= 0) listeners.splice(idx, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			await onPrompt({ text, options, promptIndex, emit, state });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

describe("task artifact write/readback durability", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-task-artifact-");
		resetRegisteredArtifactDirsForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetRegisteredArtifactDirsForTests();
		await tempDir.remove();
	});

	it("persists rawOutput durably, verifies readback, and resolves via agent://", async () => {
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });
		registerArtifactsDir(artifactsDir);

		const longPayload = Array.from({ length: 200 }, (_, i) => `subagent output line ${i} é`).join("\n");
		const fakeSession = createMockSession(({ emit, state }) => {
			const assistant = createAssistantStopMessage(longPayload);
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: { content: [{ type: "text", text: "ok" }], details: { status: "success", useLastTurn: true } },
				isError: false,
			});
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: fakeSession,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: tempDir.path(),
			agent: baseAgent,
			task: "produce output",
			index: 0,
			id: "Worker-1",
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir,
			settings: Settings.isolated({ "task.maxRuntimeMs": 0 }),
		});

		expect(result.exitCode).toBe(0);
		expect(result.outputPath).toBe(path.join(artifactsDir, "Worker-1.md"));
		expect(result.outputMeta).toEqual({
			lineCount: longPayload.split("\n").length,
			charCount: longPayload.length,
		});

		const resource = await new AgentProtocolHandler().resolve(new URL("agent://Worker-1") as never);
		expect(resource.content).toBe(longPayload);
	});

	it("clears outputPath and outputMeta when rawOutput write fails instead of leaving a dangling agent:// path", async () => {
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });
		const targetFile = path.join(artifactsDir, "Worker-FailWrite.md");

		const longPayload = Array.from({ length: 180 }, (_, i) => `line ${i}: ${"x".repeat(40)}`).join("\n");
		const fakeSession = createMockSession(({ emit, state }) => {
			const assistant = createAssistantStopMessage(longPayload);
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: { content: [{ type: "text", text: "ok" }], details: { status: "success", useLastTurn: true } },
				isError: false,
			});
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: fakeSession,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult);

		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(((dest: unknown, data: unknown, ...rest: unknown[]) => {
			if (dest === targetFile) {
				return Promise.reject(new Error("disk full"));
			}
			return (realWrite as (...args: unknown[]) => Promise<number>)(dest, data, ...rest);
		}) as typeof Bun.write);

		const result = await runSubprocess({
			cwd: tempDir.path(),
			agent: baseAgent,
			task: "produce output",
			index: 0,
			id: "Worker-FailWrite",
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir,
			settings: Settings.isolated({ "task.maxRuntimeMs": 0 }),
		});

		expect(result.exitCode).toBe(0);
		expect(result.outputPath).toBeUndefined();
		expect(result.outputMeta).toBeUndefined();
		expect(result.output).toContain("line 179:");
	});

	it("clears outputPath and outputMeta when artifact readback mismatches the written payload", async () => {
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });
		const targetFile = path.join(artifactsDir, "Worker-Corrupt.md");

		const longPayload = "expected payload ".repeat(400);
		const fakeSession = createMockSession(({ emit, state }) => {
			const assistant = createAssistantStopMessage(longPayload);
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: { content: [{ type: "text", text: "ok" }], details: { status: "success", useLastTurn: true } },
				isError: false,
			});
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: fakeSession,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult);

		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(((dest: unknown, data: unknown, ...rest: unknown[]) => {
			if (dest === targetFile) {
				return (realWrite as (...args: unknown[]) => Promise<number>)(dest, "CORRUPTED_READBACK", ...rest);
			}
			return (realWrite as (...args: unknown[]) => Promise<number>)(dest, data, ...rest);
		}) as typeof Bun.write);

		const result = await runSubprocess({
			cwd: tempDir.path(),
			agent: baseAgent,
			task: "produce output",
			index: 0,
			id: "Worker-Corrupt",
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir,
			settings: Settings.isolated({ "task.maxRuntimeMs": 0 }),
		});

		expect(result.outputPath).toBeUndefined();
		expect(result.outputMeta).toBeUndefined();
	});

	it("does not emit dangling agent:// preview or truncate away output when TaskTool has no durable outputPath", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [baseAgent],
			projectAgentsDir: null,
		});
		const fullOutput = Array.from({ length: 150 }, (_, i) => `row-${i}: ${"payload ".repeat(6)}`).join("\n");
		expect(fullOutput.length).toBeGreaterThan(5000);

		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => ({
			index: 0,
			id: options.id ?? "Task-NoArtifact",
			agent: "task",
			agentSource: "bundled",
			task: "work",
			assignment: "work",
			exitCode: 0,
			output: fullOutput,
			stderr: "",
			truncated: false,
			durationMs: 12,
			tokens: 100,
			requests: 1,
			outputPath: undefined,
			outputMeta: undefined,
		}));

		const tool = await TaskTool.create({
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated({ "async.enabled": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession);

		const result = await tool.execute("tc-task-no-artifact", {
			agent: "task",
			id: "Task-NoArtifact",
			description: "no artifact fallback",
			assignment: "work",
		} as TaskParams);

		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(result.details?.outputPaths).toBeUndefined();
		expect(text).not.toContain('full-output="agent://');
		expect(text).toContain("row-0:");
		expect(text).toContain("row-149:");
	});

	it("preserves aborted and errored subagent outputs when artifact persistence fails", async () => {
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });
		const targetFile = path.join(artifactsDir, "Worker-Aborted.md");

		const fakeSession = createMockSession(({ emit, state }) => {
			const assistant = createAssistantStopMessage("working");
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Task aborted: permission denied by policy" }],
					details: { status: "aborted", error: "permission denied by policy" },
				},
				isError: false,
			});
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: fakeSession,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult);

		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(((dest: unknown, data: unknown, ...rest: unknown[]) => {
			if (dest === targetFile) {
				return Promise.reject(new Error("disk full"));
			}
			return (realWrite as (...args: unknown[]) => Promise<number>)(dest, data, ...rest);
		}) as typeof Bun.write);

		const result: SingleResult = await runSubprocess({
			cwd: tempDir.path(),
			agent: baseAgent,
			task: "aborted work",
			index: 0,
			id: "Worker-Aborted",
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir,
			settings: Settings.isolated({ "task.maxRuntimeMs": 0 }),
		});

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("permission denied by policy");
		expect(result.outputPath).toBeUndefined();
		expect(result.output).toContain("permission denied by policy");
	});
});
