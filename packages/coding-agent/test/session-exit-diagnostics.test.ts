import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "jeopi-agent-core";
import type { AssistantMessage } from "jeopi-ai";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { createSessionTeardown } from "jeopi-cli/modes/session-teardown";
import { AgentSession } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import {
	type AssistantModelMetadata,
	collectPendingToolCalls,
	createInterruptedTurnAbortMessage,
	describePendingToolCalls,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "jeopi-cli/session/exit-diagnostics";
import { convertToLlm } from "jeopi-cli/session/messages";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { postmortem, TempDir } from "jeopi-utils";

const pendingAssistant: AssistantMessage = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "toolu_repro",
			name: "bash",
			arguments: { command: "bun run check:ts" },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
};

/** Terminal assistant turn: text content, no unanswered tool call. */
const completedAssistant: AssistantMessage = {
	...pendingAssistant,
	content: [{ type: "text", text: "done" }],
	stopReason: "stop",
};

const RECORDED_AT = "2026-07-11T02:20:08.800Z";

const fallbackModel: AssistantModelMetadata = {
	api: "openai-completions",
	provider: "openai",
	model: "fallback-model",
};

const INTERRUPTED_TURN_ERROR = "Previous jeopi process exited before completing the turn.";

function userMessage(text: string): Parameters<SessionManager["appendMessage"]>[0] {
	return { role: "user", content: text, timestamp: Date.now() };
}

function toolResult(text: string, isError = false): Parameters<SessionManager["appendMessage"]>[0] {
	return {
		role: "toolResult",
		toolCallId: "toolu_repro",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

describe("session exit diagnostics", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
		vi.restoreAllMocks();
	});

	it("records a durable tool start marker and shutdown diagnostic before a pending result exists", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
		await Promise.resolve();
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});
		await Promise.resolve();

		const marker = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE);
		if (marker?.type !== "custom") throw new Error("Expected tool execution start marker");
		expect(marker.data).toMatchObject({
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});

		const pending = collectPendingToolCalls(sessionManager.getBranch());
		expect(pending).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
			},
		]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toContain("bun run check:ts");

		await session.dispose();
		session = undefined;
		const exitEntry = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		if (exitEntry?.type !== "custom") throw new Error("Expected session exit marker");
		expect(exitEntry.data).toMatchObject({
			reason: "dispose",
			kind: "normal",
			pendingToolCalls: [
				{
					toolCallId: "toolu_repro",
					toolName: "bash",
					args: { command: "bun run check:ts" },
				},
			],
		});
	});

	it("signal teardown persists the postmortem reason, not the generic dispose", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-signal-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const activeSession = session;

		// The assistant message persists through an async queue; the tool start
		// marker is appended synchronously and is what makes the session durable
		// enough for #recordSessionExit to write the exit entry (same setup as
		// the plain-dispose test above).
		agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
		await Promise.resolve();
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});
		await Promise.resolve();

		// Mirror InteractiveMode.init(): the postmortem "session-teardown"
		// callback runs FIRST on SIGTERM/SIGHUP/uncaughtException (reverse
		// registration order) and calls dispose(). Without reason threading,
		// #doDispose would persist the generic "dispose"/"normal" and cancel the
		// reason-specific agent-session recorder — losing the real trigger.
		const teardown = createSessionTeardown({
			getDraftText: () => "",
			beginDispose: () => activeSession.beginDispose(),
			saveDraft: async () => {},
			disposeSession: reason => activeSession.dispose({ reason }),
		});

		await teardown(postmortem.Reason.SIGTERM);
		session = undefined;

		const exitEntry = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		if (exitEntry?.type !== "custom") throw new Error("Expected session exit marker");
		expect(exitEntry.data).toMatchObject({
			reason: "sigterm",
			kind: "signal",
		});
	});

	it("does not materialize an empty session just to write an exit marker", async () => {
		tempDir = TempDir.createSync("@pi-empty-session-exit-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file path");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		await session.dispose();
		session = undefined;

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(
			sessionManager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE),
		).toBe(false);
	});

	it("treats assistant tool calls as pending even when stopReason is not toolUse", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "stop" });

		expect(collectPendingToolCalls(sessionManager.getBranch())).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
			},
		]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toContain("bun run check:ts");
	});

	it("clears the pending warning once the matching tool result is recorded", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
			startedAt: new Date().toISOString(),
		} satisfies ToolExecutionStartData);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		});

		expect(collectPendingToolCalls(sessionManager.getBranch())).toEqual([]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toBeUndefined();
	});

	describe("createInterruptedTurnAbortMessage", () => {
		/**
		 * Builds a branch ending in an unanswered tool call plus an abnormal exit
		 * marker — the canonical "process died mid-turn" transcript.
		 */
		function interruptedBranch(
			exit: Record<string, unknown> = { reason: "exit", kind: "process_exit", recordedAt: RECORDED_AT },
		): SessionManager {
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage(userMessage("inspect the file"));
			sessionManager.appendMessage(pendingAssistant);
			sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, exit);
			return sessionManager;
		}

		it("reconstructs the full terminal record from the abnormal exit marker", () => {
			const sessionManager = interruptedBranch();

			// Every field is load-bearing: content/usage must be empty so the
			// synthetic turn cannot inflate context or cost accounting, the
			// timestamp must come from the recorded exit rather than replay time,
			// and the errorMessage is what the transcript renders to the user.
			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toEqual({
				role: "assistant",
				content: [],
				api: pendingAssistant.api,
				provider: pendingAssistant.provider,
				model: pendingAssistant.model,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				errorMessage: INTERRUPTED_TURN_ERROR,
				timestamp: Date.parse(RECORDED_AT),
			});
		});

		for (const kind of ["signal", "fatal", "process_exit"] as const) {
			it(`treats a ${kind} exit as an unfinished turn`, () => {
				const sessionManager = interruptedBranch({ reason: kind, kind, recordedAt: RECORDED_AT });

				expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
					role: "assistant",
					stopReason: "aborted",
				});
			});
		}

		it("treats a normal exit that recorded pending tool calls as an unfinished turn", () => {
			const sessionManager = interruptedBranch({
				reason: "manual exit",
				kind: "normal",
				recordedAt: RECORDED_AT,
				pendingToolCalls: [{ toolCallId: "toolu_repro", toolName: "bash" }],
			});

			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
				role: "assistant",
				stopReason: "aborted",
			});
		});

		it("recovers a tool-result tail while preserving the partial result in context", () => {
			// Exit markers can trail a partial tool result: the turn still never
			// produced a closing assistant message, so the partial result must
			// survive alongside the appended terminal record.
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage(userMessage("inspect the file"));
			sessionManager.appendMessage(pendingAssistant);
			sessionManager.appendMessage(toolResult("partial result stays in history"));
			sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
				reason: "exit",
				kind: "process_exit",
				recordedAt: RECORDED_AT,
			});

			const recovered = createInterruptedTurnAbortMessage(sessionManager.getBranch());
			expect(recovered).toMatchObject({ role: "assistant", content: [], stopReason: "aborted" });

			sessionManager.appendMessage(recovered!);
			const messages = sessionManager.buildSessionContext().messages;
			expect(
				messages.some(
					message =>
						message.role === "toolResult" &&
						message.content.some(part => part.type === "text" && part.text === "partial result stays in history"),
				),
			).toBe(true);
			expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		});

		it("is idempotent: appending the recovered record closes the turn for good", () => {
			const sessionManager = interruptedBranch();

			const first = createInterruptedTurnAbortMessage(sessionManager.getBranch());
			expect(first).toBeDefined();
			sessionManager.appendMessage(first!);

			// The in-process double call (sdk.ts invokes the helper twice per
			// startup) must not stack another aborted turn.
			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
			expect(
				sessionManager
					.getBranch()
					.filter(
						entry =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.stopReason === "aborted",
					),
			).toHaveLength(1);
		});

		it("stays idempotent across a second crash that records a newer exit marker", () => {
			// A later crash writes a fresh exit marker AFTER the recovered record,
			// so the tail no longer postdates the exit. Only the terminal-tail
			// check stops the next startup from stacking a second aborted turn.
			const sessionManager = interruptedBranch();
			sessionManager.appendMessage(createInterruptedTurnAbortMessage(sessionManager.getBranch())!);
			sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
				reason: "exit",
				kind: "process_exit",
				recordedAt: "2026-07-12T03:30:00.000Z",
			});

			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch(), fallbackModel)).toBeUndefined();
		});

		it("copies model metadata from the nearest preceding assistant over the fallback", () => {
			const sessionManager = interruptedBranch();

			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch(), fallbackModel)).toMatchObject({
				api: pendingAssistant.api,
				provider: pendingAssistant.provider,
				model: pendingAssistant.model,
			});
		});

		it("uses the fallback model for a first-turn user tail with no prior assistant", () => {
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage(userMessage("inspect the file"));
			sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
				reason: "exit",
				kind: "process_exit",
				recordedAt: RECORDED_AT,
			});

			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch(), fallbackModel)).toMatchObject({
				role: "assistant",
				api: fallbackModel.api,
				provider: fallbackModel.provider,
				model: fallbackModel.model,
				stopReason: "aborted",
			});
		});

		it("declines to recover a user tail when no model metadata is available", () => {
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage(userMessage("inspect the file"));
			sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
				reason: "exit",
				kind: "process_exit",
				recordedAt: RECORDED_AT,
			});

			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
		});

		it("falls back to the current clock when the recorded exit time is unparseable", () => {
			const now = 1_800_000_000_000;
			vi.spyOn(Date, "now").mockReturnValue(now);
			const sessionManager = interruptedBranch({
				reason: "exit",
				kind: "process_exit",
				recordedAt: "not-a-timestamp",
			});

			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())?.timestamp).toBe(now);
		});

		it("honors the newest exit marker, so a clean restart does not replay an older crash", () => {
			const sessionManager = interruptedBranch();
			sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
				reason: "dispose",
				kind: "normal",
				recordedAt: RECORDED_AT,
			});

			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
		});

		it("skips recovery when no exit marker was ever persisted", () => {
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage(userMessage("inspect the file"));
			sessionManager.appendMessage(pendingAssistant);

			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch(), fallbackModel)).toBeUndefined();
		});

		it("skips recovery after a clean shutdown with no pending tool calls", () => {
			const sessionManager = interruptedBranch({ reason: "dispose", kind: "normal", recordedAt: RECORDED_AT });

			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch(), fallbackModel)).toBeUndefined();
		});

		it("skips recovery when the newest message postdates the exit marker", () => {
			const sessionManager = interruptedBranch();
			sessionManager.appendMessage(userMessage("new turn after restart"));

			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch(), fallbackModel)).toBeUndefined();
		});

		it("skips recovery when the tail assistant turn already completed", () => {
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage(userMessage("inspect the file"));
			sessionManager.appendMessage(completedAssistant);
			sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
				reason: "exit",
				kind: "process_exit",
				recordedAt: RECORDED_AT,
			});

			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch(), fallbackModel)).toBeUndefined();
		});

		for (const stopReason of ["error", "aborted"] as const) {
			it(`skips a tool-result tail already closed by a ${stopReason} assistant turn`, () => {
				const sessionManager = SessionManager.inMemory();
				sessionManager.appendMessage(userMessage("inspect the file"));
				sessionManager.appendMessage({ ...pendingAssistant, stopReason });
				sessionManager.appendMessage(toolResult("Tool execution stopped after model failure.", true));
				sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
					reason: "exit",
					kind: "process_exit",
					recordedAt: RECORDED_AT,
				});

				expect(createInterruptedTurnAbortMessage(sessionManager.getBranch(), fallbackModel)).toBeUndefined();
			});
		}

		const malformedExits: Array<[string, Record<string, unknown>]> = [
			["a non-string reason", { reason: 7, kind: "process_exit", recordedAt: RECORDED_AT }],
			["an unknown kind", { reason: "exit", kind: "meltdown", recordedAt: RECORDED_AT }],
			["a non-string recordedAt", { reason: "exit", kind: "process_exit", recordedAt: 1_800_000_000_000 }],
		];
		for (const [label, exit] of malformedExits) {
			it(`ignores an exit marker with ${label}`, () => {
				const sessionManager = interruptedBranch(exit);

				expect(createInterruptedTurnAbortMessage(sessionManager.getBranch(), fallbackModel)).toBeUndefined();
			});
		}

		it("ignores malformed pending tool diagnostics on an otherwise clean exit", () => {
			const sessionManager = interruptedBranch({
				reason: "manual exit",
				kind: "normal",
				recordedAt: RECORDED_AT,
				pendingToolCalls: "not an array",
			});

			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch(), fallbackModel)).toBeUndefined();
		});
	});
});
