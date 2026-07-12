import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createAutoresearchExtension } from "jeopi-cli/autoresearch";
import {
	type AutoresearchStorage,
	closeAllAutoresearchStorages,
	openAutoresearchStorage,
	type SessionRow,
} from "jeopi-cli/autoresearch/storage";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionBranchEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
} from "jeopi-cli/extensibility/extensions";
import type { SessionEntry } from "jeopi-cli/session/session-entries";
import * as git from "jeopi-cli/utils/git";
import { TempDir } from "jeopi-utils";

// Cross-process auto-resume: a completed-but-never-logged run persisted by a
// prior process must fire the same "autoresearch-resume" nextTurn message that
// the in-process `agent_end` handler fires, but only when the caller says the
// event actually represents a session restart (`resumeEligible`), the mode is
// on for the branch we landed on, the pending run is still fresh, and nothing
// is already queued to run this turn.

const CURRENT_BRANCH = "autoresearch/test";

interface SentMessage {
	message: { customType: string; content: string; display: boolean; attribution: string };
	options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined;
}

interface CapturedHandlers {
	session_start?: ExtensionHandler<SessionStartEvent>;
	session_switch?: ExtensionHandler<SessionSwitchEvent>;
	session_branch?: ExtensionHandler<SessionBranchEvent>;
	session_tree?: ExtensionHandler<SessionTreeEvent>;
	agent_end?: ExtensionHandler<AgentEndEvent>;
}

function buildHarness(): { handlers: CapturedHandlers; sent: SentMessage[] } {
	const handlers: CapturedHandlers = {};
	const sent: SentMessage[] = [];
	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		on(event: string, handler: ExtensionHandler<unknown, unknown>): void {
			(handlers as Record<string, ExtensionHandler<unknown, unknown>>)[event] = handler;
		},
		registerCommand(): void {},
		registerShortcut(): void {},
		registerTool(): void {},
		getActiveTools: (): string[] => [],
		setActiveTools: async (): Promise<void> => {},
		sendUserMessage(): void {},
		sendMessage(message: SentMessage["message"], options: SentMessage["options"]): void {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);
	return { handlers, sent };
}

function makeCtx(
	cwd: string,
	opts: { mode?: "on" | "off"; hasPendingMessages?: boolean; sessionId?: string } = {},
): ExtensionContext {
	const entries: SessionEntry[] =
		opts.mode === undefined
			? []
			: [
					{
						type: "custom",
						customType: "autoresearch-control",
						id: "ctrl-1",
						parentId: null,
						timestamp: new Date(0).toISOString(),
						data: { mode: opts.mode, goal: "speed up the thing" },
					} as unknown as SessionEntry,
				];
	return {
		cwd,
		hasUI: false,
		hasPendingMessages: () => opts.hasPendingMessages ?? false,
		sessionManager: {
			getSessionId: () => opts.sessionId ?? "session-resume-test",
			getBranch: () => entries,
		},
	} as unknown as ExtensionContext;
}

// Opens a real session on CURRENT_BRANCH so `rehydrate`'s `onActiveBranch`
// check (session.branch === currentBranch) holds.
async function seedSession(cwd: string): Promise<{ storage: AutoresearchStorage; session: SessionRow }> {
	const storage = await openAutoresearchStorage(cwd);
	const session = storage.openSession({
		name: "speed",
		goal: "make x fast",
		primaryMetric: "runtime_ms",
		metricUnit: "ms",
		direction: "lower",
		preferredCommand: null,
		branch: CURRENT_BRANCH,
		baselineCommit: null,
		maxIterations: null,
		scopePaths: [],
		offLimits: [],
		constraints: [],
		secondaryMetrics: [],
	});
	return { storage, session };
}

// Inserts a completed-but-never-logged run with an explicit `completedAt`, so
// staleness-window tests can place it precisely relative to `Date.now()`.
function seedPendingRun(storage: AutoresearchStorage, session: SessionRow, completedAt: number): void {
	const run = storage.insertRun({
		sessionId: session.id,
		segment: session.currentSegment,
		command: "bash autoresearch.sh",
		startedAt: completedAt - 1,
		logPath: "/tmp/run.log",
		preRunDirtyPaths: [],
	});
	storage.markRunCompleted({
		runId: run.id,
		completedAt,
		durationMs: 1000,
		exitCode: 0,
		timedOut: false,
		parsedPrimary: 42,
		parsedMetrics: null,
		parsedAsi: null,
	});
}

describe("autoresearch cross-restart auto-resume", () => {
	let dbDir: TempDir;
	let cwdDir: TempDir;

	beforeEach(() => {
		dbDir = TempDir.createSync("@pi-autoresearch-resume-db-");
		process.env.JEOPI_AUTORESEARCH_DB_DIR = dbDir.path();
		cwdDir = TempDir.createSync("@pi-autoresearch-resume-cwd-");
		vi.spyOn(git.branch, "current").mockResolvedValue(CURRENT_BRANCH);
		vi.spyOn(git.repo, "root").mockResolvedValue(cwdDir.path());
	});

	afterEach(() => {
		delete process.env.JEOPI_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		cwdDir.removeSync();
		dbDir.removeSync();
		vi.restoreAllMocks();
	});

	it("fires the resume message on session_start when mode is on and a pending run completed 1 hour ago", async () => {
		const { session, storage } = await seedSession(cwdDir.path());
		seedPendingRun(storage, session, Date.now() - 1 * 3600_000);

		const { handlers, sent } = buildHarness();
		if (!handlers.session_start) throw new Error("session_start should be registered");

		const ctx = makeCtx(cwdDir.path(), { mode: "on" });
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("autoresearch-resume");
		expect(sent[0]?.message.display).toBe(false);
		expect(sent[0]?.message.attribution).toBe("agent");
		expect(sent[0]?.options?.deliverAs).toBe("nextTurn");
		expect(sent[0]?.options?.triggerTurn).toBe(true);
	});

	it("does not fire when the pending run completed 30 hours ago (past the 24h staleness window)", async () => {
		const { session, storage } = await seedSession(cwdDir.path());
		seedPendingRun(storage, session, Date.now() - 30 * 3600_000);

		const { handlers, sent } = buildHarness();
		if (!handlers.session_start) throw new Error("session_start should be registered");

		const ctx = makeCtx(cwdDir.path(), { mode: "on" });
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		expect(sent).toHaveLength(0);
	});

	it("does not fire when ctx.hasPendingMessages() is true, even with a fresh pending run", async () => {
		const { session, storage } = await seedSession(cwdDir.path());
		seedPendingRun(storage, session, Date.now() - 1 * 3600_000);

		const { handlers, sent } = buildHarness();
		if (!handlers.session_start) throw new Error("session_start should be registered");

		const ctx = makeCtx(cwdDir.path(), { mode: "on", hasPendingMessages: true });
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		expect(sent).toHaveLength(0);
	});

	it("does not fire when the session has no pending (unlogged) run", async () => {
		await seedSession(cwdDir.path());

		const { handlers, sent } = buildHarness();
		if (!handlers.session_start) throw new Error("session_start should be registered");

		const ctx = makeCtx(cwdDir.path(), { mode: "on" });
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		expect(sent).toHaveLength(0);
	});

	it("does not fire when autoresearch mode is off, regardless of a pending run in storage", async () => {
		const { session, storage } = await seedSession(cwdDir.path());
		seedPendingRun(storage, session, Date.now() - 1 * 3600_000);

		const { handlers, sent } = buildHarness();
		if (!handlers.session_start) throw new Error("session_start should be registered");

		const ctx = makeCtx(cwdDir.path(), { mode: "off" });
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		expect(sent).toHaveLength(0);
	});

	it("fires on session_switch when event.reason is 'resume'", async () => {
		const { session, storage } = await seedSession(cwdDir.path());
		seedPendingRun(storage, session, Date.now() - 1 * 3600_000);

		const { handlers, sent } = buildHarness();
		if (!handlers.session_switch) throw new Error("session_switch should be registered");

		const ctx = makeCtx(cwdDir.path(), { mode: "on" });
		await handlers.session_switch({ type: "session_switch", reason: "resume" } as SessionSwitchEvent, ctx);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("autoresearch-resume");
	});

	it("does not fire on session_switch when event.reason is 'new'", async () => {
		const { session, storage } = await seedSession(cwdDir.path());
		seedPendingRun(storage, session, Date.now() - 1 * 3600_000);

		const { handlers, sent } = buildHarness();
		if (!handlers.session_switch) throw new Error("session_switch should be registered");

		const ctx = makeCtx(cwdDir.path(), { mode: "on" });
		await handlers.session_switch({ type: "session_switch", reason: "new" } as SessionSwitchEvent, ctx);

		expect(sent).toHaveLength(0);
	});

	it("does not fire on session_branch even with an otherwise-eligible pending run", async () => {
		const { session, storage } = await seedSession(cwdDir.path());
		seedPendingRun(storage, session, Date.now() - 1 * 3600_000);

		const { handlers, sent } = buildHarness();
		if (!handlers.session_branch) throw new Error("session_branch should be registered");

		const ctx = makeCtx(cwdDir.path(), { mode: "on" });
		await handlers.session_branch(
			{ type: "session_branch", previousSessionFile: undefined } as SessionBranchEvent,
			ctx,
		);

		expect(sent).toHaveLength(0);
	});

	it("does not fire on session_tree even with an otherwise-eligible pending run", async () => {
		const { session, storage } = await seedSession(cwdDir.path());
		seedPendingRun(storage, session, Date.now() - 1 * 3600_000);

		const { handlers, sent } = buildHarness();
		if (!handlers.session_tree) throw new Error("session_tree should be registered");

		const ctx = makeCtx(cwdDir.path(), { mode: "on" });
		await handlers.session_tree({ type: "session_tree", newLeafId: "leaf-1" } as SessionTreeEvent, ctx);

		expect(sent).toHaveLength(0);
	});

	it("does not re-fire from agent_end for the same pending run already resumed on session_start", async () => {
		const { session, storage } = await seedSession(cwdDir.path());
		seedPendingRun(storage, session, Date.now() - 1 * 3600_000);

		const { handlers, sent } = buildHarness();
		if (!handlers.session_start || !handlers.agent_end) {
			throw new Error("session_start and agent_end should both be registered");
		}

		const ctx = makeCtx(cwdDir.path(), { mode: "on" });
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);
		expect(sent).toHaveLength(1);

		// Same in-process runtime (keyed by ctx.sessionManager.getSessionId()), same
		// still-pending run row (never logged) — `lastAutoResumePendingRunNumber`
		// set during the session_start resume must suppress a second nextTurn fire.
		await handlers.agent_end({ type: "agent_end", messages: [] } as AgentEndEvent, ctx);

		expect(sent).toHaveLength(1);
	});
});
