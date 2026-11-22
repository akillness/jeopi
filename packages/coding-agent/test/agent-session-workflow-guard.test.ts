import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "arktype";
import { Agent, type AgentTool } from "jeopi-agent-core";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, ThinkingContent } from "jeopi-ai";
import { createMockModel } from "jeopi-ai/providers/mock";
import { AssistantMessageEventStream } from "jeopi-ai/utils/event-stream";
import { GEMINI_HEADER_RUNAWAY_THRESHOLD } from "jeopi-ai/utils/thinking-loop";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { loadExtensions } from "jeopi-cli/extensibility/extensions/loader";
import { ExtensionRunner } from "jeopi-cli/extensibility/extensions/runner";
import { AgentSession } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { convertToLlm } from "jeopi-cli/session/messages";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { getProjectAgentDir, TempDir } from "jeopi-utils";

const emptySchema = type({});

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function headerRunawayStream(model: Model<Api>, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const thinking: ThinkingContent = { type: "thinking", thinking: "" };
	const partial: AssistantMessage = {
		role: "assistant",
		content: [thinking],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	let aborted = false;
	options?.signal?.addEventListener(
		"abort",
		() => {
			if (aborted) return;
			aborted = true;
			stream.push({
				type: "error",
				reason: "aborted",
				error: { ...partial, content: [{ ...thinking }], stopReason: "aborted" },
			});
		},
		{ once: true },
	);

	void (async () => {
		stream.push({ type: "start", partial });
		stream.push({ type: "thinking_start", contentIndex: 0, partial });
		for (let i = 0; i < GEMINI_HEADER_RUNAWAY_THRESHOLD + 2; i++) {
			if (aborted) return;
			const delta = `**Refining Stage ${i}**\n\nReworking module_${i} so handler_${i} routes Stage${i}Result through render_${i}.\n\n`;
			thinking.thinking += delta;
			stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial });
			await Bun.sleep(0);
		}
		if (aborted) return;
		stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial });
		stream.push({ type: "done", reason: "stop", message: partial });
	})();

	return stream;
}

describe("AgentSession workflow loop guard and bounded re-entry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-session-workflow-guard-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("google", "test-key");
		authStorage.setRuntimeApiKey("mock", "test-key");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
			session = undefined;
		} finally {
			authStorage.close();
			await tempDir.remove();
			vi.restoreAllMocks();
		}
	});

	it("suppresses todo reminders and emits a loop-guard warning when WorkflowLoopGuard stops a failing run", async () => {
		const failingBash: AgentTool<typeof emptySchema, Record<string, never>> = {
			name: "bash",
			label: "Bash",
			description: "Run bash command",
			parameters: emptySchema,
			async execute() {
				throw new Error("boom");
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] },
				{ content: ["should not run after guard stop"] },
			],
		});
		const modelRegistry = new ModelRegistry(authStorage);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock.model,
				systemPrompt: ["Test"],
				tools: [failingBash],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		agent.setWorkflowGuard({ maxConsecutiveFailures: 1, maxSteps: 10 });

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": true,
			}),
			modelRegistry,
		});
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Finish task", status: "in_progress" }] }]);

		const notices: Array<{ level: string; message: string; source?: string }> = [];
		const todoReminders: unknown[] = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push({ level: event.level, message: event.message, source: event.source });
			}
			if (event.type === "todo_reminder") {
				todoReminders.push(event);
			}
		});

		await session.prompt("run failing command");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(todoReminders).toHaveLength(0);
		const guardNotice = notices.find(n => n.source === "loop-guard" && n.message.includes("consecutive_failure"));
		expect(guardNotice).toBeDefined();
		expect(guardNotice?.level).toBe("warning");
	});

	it("preserves continuation counters across synthetic prompts while resetting on genuine user prompts", async () => {
		// Each empty assistant turn consumes one empty-stop retry (cap = 2 retries -> 3 calls on first user prompt).
		const mock = createMockModel({
			responses: Array.from({ length: 12 }, () => ({ content: [""] })),
		});
		const modelRegistry = new ModelRegistry(authStorage);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock.model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": true,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 10,
				"todo.enabled": false,
			}),
			modelRegistry,
		});

		await session.prompt("first user prompt");
		await session.waitForIdle();
		const callsAfterUser1 = mock.calls.length;
		// Initial attempt + EMPTY_STOP_MAX_RETRIES (3) = 4 calls.
		expect(callsAfterUser1).toBe(4);

		// A synthetic prompt must NOT reset the exhausted empty-stop budget.
		await session.prompt("auto continue", { synthetic: true });
		await session.waitForIdle();
		expect(mock.calls.length).toBe(callsAfterUser1 + 1);

		// A fresh genuine user prompt DOES reset the budget (1 attempt + 3 retries = 4 calls).
		await session.prompt("second genuine user prompt");
		await session.waitForIdle();
		expect(mock.calls.length).toBe(callsAfterUser1 + 1 + 4);
	});

	it("caps Gemini planning-header runaway interrupts per user prompt instead of looping forever", async () => {
		authStorage.setRuntimeApiKey("openrouter", "test-key");
		const model = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" }).model;
		let streamCalls = 0;
		const modelRegistry = new ModelRegistry(authStorage);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: (requestedModel, _context, options) => {
				streamCalls++;
				return headerRunawayStream(requestedModel, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"advisor.enabled": false,
				"model.loopGuard.enabled": true,
				"model.loopGuard.toolCallReminder": true,
			}),
			modelRegistry,
		});

		const notices: Array<{ level: string; message: string; source?: string }> = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push({ level: event.level, message: event.message, source: event.source });
			}
		});

		await session.prompt("trigger repeated planning-header runaways");
		await session.waitForIdle();

		// 3 allowed interrupts + 1 final aborted attempt that hits the cap = 4 stream calls max.
		expect(streamCalls).toBe(4);
		expect(
			notices.some(n => n.source === "loop-guard" && n.message.includes("repeated planning-header runaways")),
		).toBe(true);
	});

	async function createCompactionShortCircuitSession(): Promise<AgentSession> {
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => ({',
				"\t\tcompaction: {",
				'\t\t\tsummary: "compacted",',
				"\t\t\tshortSummary: undefined,",
				"\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\tdetails: {},",
				"\t\t},",
				"\t}));",
				"}",
			].join("\n"),
		);

		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5-20250929");
		if (!model) throw new Error("Expected bundled anthropic model");

		const agent = new Agent({
			initialState: {
				model: { ...model, contextWindow: 200000, maxTokens: 64000 },
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		return new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": true,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
			extensionRunner,
		});
	}

	it("blocks agent-attributed queued messages from overriding a no-progress compaction pause", async () => {
		session = await createCompactionShortCircuitSession();

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });

		// Queue an agent-attributed message; it must NOT override a no-progress compaction pause.
		session.agent.followUp({
			role: "custom",
			customType: "synthetic-nudge",
			content: [{ type: "text", text: "Keep working" }],
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const highUsageAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5-20250929",
			stopReason: "stop",
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: highUsageAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [highUsageAssistant] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("caps length-compaction retries per user prompt and emits a warning notice", async () => {
		session = await createCompactionShortCircuitSession();

		vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 200000, percent: 0.5 });

		let lengthCompactionStarts = 0;
		let resolveCompactionEnd: (() => void) | undefined;
		const notices: Array<{ message: string; source?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_start" && event.reason === "incomplete") {
				lengthCompactionStarts++;
			}
			if (event.type === "auto_compaction_end") {
				resolveCompactionEnd?.();
				resolveCompactionEnd = undefined;
			}
			if (event.type === "notice") {
				notices.push({ message: event.message, source: event.source });
			}
		});

		for (let i = 0; i < 3; i++) {
			const endWaiter = i < 2 ? Promise.withResolvers<void>() : undefined;
			if (endWaiter) resolveCompactionEnd = endWaiter.resolve;
			const truncated: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: `cut off ${i}` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5-20250929",
				stopReason: "length",
				usage: emptyUsage(),
				timestamp: Date.now() + 1000 + i,
			};
			session.agent.emitExternalEvent({ type: "message_end", message: truncated });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [truncated] });
			if (endWaiter) {
				await endWaiter.promise;
			} else {
				await Bun.sleep(25);
			}
			await session.waitForIdle();
		}

		expect(lengthCompactionStarts).toBe(2);
		expect(notices.some(n => n.source === "compaction" && n.message.includes("output token limit repeatedly"))).toBe(
			true,
		);
	});
});
