/**
 * Subagent tool — unified control surface for `task`-spawned background
 * subagents: list/inspect/await/cancel their AsyncJobManager job record, and
 * steer/pause/resume the live agent session behind them.
 *
 * This composes existing primitives instead of owning new state:
 *  - {@link AsyncJobManager} (`type: "task"` jobs) is the source of truth for
 *    a spawn's *original* run outcome — completed/failed/cancelled/queued.
 *  - {@link AgentRegistry} is the source of truth for whether the underlying
 *    AgentSession is currently working right now (`running`) and whether it
 *    is still resident and addressable for a follow-up (`idle`/`parked`).
 *    This matters beyond the first run: a `resume`d subagent processes its
 *    follow-up as a real turn on the *same* session without registering a
 *    new async job, so the registry — not the original job — is the only
 *    live signal once a subagent has been resumed at least once.
 *  - {@link IrcBus.send} is the single delivery path for steer/resume/pause:
 *    it already injects into a running agent as steering, wakes an idle one
 *    with a real turn, and revives a parked one (see `irc/bus.ts`).
 *
 * jeopi has no literal "frozen mid-run" agent state — a `task` job resolves
 * the moment the spawned agent's run stops (yields or runs out of work), and
 * its session then simply sits `idle`/`parked`, addressable for a follow-up.
 * So `pause` does not freeze anything: it delivers a steering message asking
 * the agent to wrap up at its next safe boundary, which makes that run
 * finish sooner than it otherwise would while leaving the session resident.
 * `#pausedIds` (session-local, per tool instance) tracks "a pause was
 * requested and nothing has re-engaged it yet" so `list`/`inspect` can report
 * a genuine `paused` status instead of overloading `completed`. It clears the
 * moment a `resume`/`steer` call successfully hands the subagent new work.
 *
 * Every operation is scoped to the calling agent's own spawns (`ownerId`),
 * matching the `job` and `irc` tools — cross-agent inspection is impossible
 * by design.
 */
import { type } from "arktype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "jeopi-agent-core";
import { formatDuration, prompt } from "jeopi-utils";
import type { AsyncJob, AsyncJobManager } from "../async";
import { IrcBus, type IrcDeliveryReceipt } from "../irc/bus";
import subagentDescription from "../prompts/tools/subagent.md" with { type: "text" };
import type { AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "./index";
import { isIrcEnabled } from "./irc";
import { ToolError } from "./tool-errors";

/** Same audience as `irc`: a subagent always has peers; a top-level session has peers only if it can still spawn via `task`. */
export const isSubagentToolEnabled = isIrcEnabled;

const subagentSchema = type({
	action: type("'list' | 'inspect' | 'await' | 'cancel' | 'pause' | 'resume' | 'steer'").describe(
		"subagent control action",
	),
	"id?": type("string").describe("single target subagent id (preferred for steer/resume/pause)"),
	"ids?": type("string[]").describe(
		"target subagent ids (list/inspect/await/cancel); omit to target every running spawn of this agent",
	),
	"limit?": type("number").describe("list/inspect: maximum subagents to return (default 10, max 50)"),
	"verbosity?": type("'receipt' | 'preview' | 'full'").describe(
		'output verbosity: receipt (default, <=280-char preview), preview (<=2000 chars), or full (<=12000 chars; requires explicit ids, not valid with action="list")',
	),
	"message?": type("string").describe("message to deliver (steer/resume)"),
	"pause?": type("boolean").describe("steer: also request a pause after delivering the message"),
	"timeout_ms?": type("number").describe("await timeout in milliseconds (0 waits indefinitely)"),
});

type SubagentParams = typeof subagentSchema.infer;
type Verbosity = "receipt" | "preview" | "full";

const DEFAULT_AWAIT_TIMEOUT_MS = 30_000;
const MAX_AWAIT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 50;
const DEFAULT_VERBOSITY: Verbosity = "receipt";
const RECEIPT_PREVIEW_CHARS = 280;
const PREVIEW_CHARS = 2_000;
const FULL_PREVIEW_CHARS = 12_000;
const DEFAULT_PAUSE_DIRECTIVE =
	"Stop at the next safe boundary and yield. You can be resumed later with more instructions.";

export type SubagentStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "not_found";

export interface SubagentSnapshot {
	id: string;
	status: SubagentStatus;
	/** True when the underlying agent session is still resident (idle/parked) and addressable via a follow-up `resume`/`steer`. */
	resumable: boolean;
	label: string;
	durationMs: number;
	displayName?: string;
	activity?: string;
	resultText?: string;
	errorText?: string;
}

export interface SubagentToolDetails {
	action: SubagentParams["action"];
	subagents: SubagentSnapshot[];
	/** Present when `limit` truncated the result set. */
	truncated?: number;
	cancelled?: { id: string; status: "cancelled" | "not_found" | "already_completed" }[];
	receipt?: { to: string; outcome: "injected" | "woken" | "revived" | "failed"; error?: string };
}

function isResumable(ref: AgentRef | undefined): boolean {
	return !!ref && (ref.status === "idle" || ref.status === "parked");
}

function errorResult(text: string, action: SubagentParams["action"]): AgentToolResult<SubagentToolDetails> {
	return { content: [{ type: "text", text }], details: { action, subagents: [] }, isError: true };
}

export class SubagentTool implements AgentTool<typeof subagentSchema, SubagentToolDetails> {
	readonly name = "subagent";
	readonly approval = "read" as const;
	readonly label = "Subagent";
	readonly summary = "List, inspect, await, cancel, pause, resume, and steer background task subagents";
	readonly description: string;
	readonly parameters = subagentSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly loadMode = "discoverable";

	/** Ids with an outstanding `pause` request that no `resume`/`steer`/live-run has cleared yet. Session-local. */
	readonly #pausedIds = new Set<string>();

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(subagentDescription);
	}

	static createIf(session: ToolSession): SubagentTool | null {
		if (!isSubagentToolEnabled(session.settings, session.taskDepth ?? 0)) return null;
		if (!session.agentRegistry || !session.getAgentId) return null;
		return new SubagentTool(session);
	}

	async execute(
		_toolCallId: string,
		params: SubagentParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<SubagentToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SubagentToolDetails>> {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? null;
		if (!registry || !senderId) {
			return errorResult("Subagent control is unavailable in this session.", params.action);
		}
		const verbosity = params.verbosity ?? DEFAULT_VERBOSITY;
		if (verbosity === "full" && (params.action === "list" || !(params.ids?.length || params.id))) {
			throw new ToolError(
				'`verbosity="full"` cannot be used with `list` and requires explicit `id`/`ids` so broad inspection cannot inline retained subagent output.',
			);
		}
		const manager = this.session.asyncJobManager;
		const ownerId = senderId;

		switch (params.action) {
			case "list":
				return this.#list(manager, registry, ownerId, params);
			case "inspect":
				return this.#inspect(manager, registry, ownerId, params);
			case "await":
				return this.#await(manager, registry, ownerId, params, signal, onUpdate);
			case "cancel":
				return this.#cancel(manager, registry, ownerId, params);
			case "steer":
				return this.#steer(registry, senderId, params);
			case "resume":
				return this.#resume(manager, registry, senderId, params);
			case "pause":
				return this.#pause(manager, registry, senderId, params);
			default:
				return errorResult("Unknown subagent action.", params.action);
		}
	}

	#taskJobs(manager: AsyncJobManager | undefined, ownerId: string): AsyncJob[] {
		if (!manager) return [];
		return manager.getAllJobs({ ownerId }).filter(job => job.type === "task");
	}

	#targetIds(params: SubagentParams): string[] | undefined {
		if (params.ids?.length) return params.ids;
		if (params.id) return [params.id];
		return undefined;
	}

	#visibleJob(manager: AsyncJobManager | undefined, ownerId: string, id: string): AsyncJob | undefined {
		const job = manager?.getJob(id);
		if (job?.type !== "task" || job.ownerId !== ownerId) return undefined;
		return job;
	}

	/**
	 * Live status combines the registry (authoritative for "is it working
	 * right now", including turns started by a `resume` that never touch
	 * AsyncJobManager) with the original job record (authoritative for the
	 * first run's terminal outcome) and the local pause bookkeeping.
	 */
	#status(job: AsyncJob | undefined, ref: AgentRef | undefined, id: string): SubagentStatus {
		if (!job && !ref) return "not_found";
		if (job?.queued) return "queued";
		// `pause` is advisory and does not itself flip the registry — the ref
		// only reaches `running` again once a later `resume`/`steer` actually
		// engages the subagent, and those already clear `#pausedIds` on success.
		// So a still-`running` ref never means "the pause was a no-op"; it just
		// means the pause hasn't taken effect yet.
		if (ref?.status === "running") return "running";
		if (this.#pausedIds.has(id)) return "paused";
		if (job) return job.status;
		return ref?.status === "aborted" ? "cancelled" : "completed";
	}

	#snapshot(job: AsyncJob | undefined, ref: AgentRef | undefined, id: string, verbosity: Verbosity): SubagentSnapshot {
		const now = Date.now();
		const width =
			verbosity === "full" ? FULL_PREVIEW_CHARS : verbosity === "preview" ? PREVIEW_CHARS : RECEIPT_PREVIEW_CHARS;
		return {
			id,
			status: this.#status(job, ref, id),
			resumable: isResumable(ref),
			label: job?.label ?? ref?.displayName ?? id,
			durationMs: job ? Math.max(0, now - job.startTime) : 0,
			...(ref?.displayName ? { displayName: ref.displayName } : {}),
			...(ref?.activity ? { activity: ref.activity } : {}),
			...(job?.resultText ? { resultText: job.resultText.slice(0, width) } : {}),
			...(job?.errorText ? { errorText: job.errorText.slice(0, width) } : {}),
		};
	}

	#snapshotLine(s: SubagentSnapshot, verbosity: Verbosity): string {
		if (verbosity === "receipt") return `- ${s.id} [${s.status}]`;
		const extras = [s.resumable ? "resumable" : undefined, formatDuration(s.durationMs)].filter(Boolean);
		return `- ${s.id} [${s.status}] — ${extras.join(", ")}`;
	}

	/** Applies a resolved (already clamped) `limit` (most recently started first) and reports how many were hidden. */
	#applyLimit<T extends SubagentSnapshot>(subagents: T[], limit: number): { kept: T[]; truncated?: number } {
		if (subagents.length <= limit) return { kept: subagents };
		const sorted = [...subagents].sort((a, b) => b.durationMs - a.durationMs);
		return { kept: sorted.slice(0, limit), truncated: subagents.length - limit };
	}

	#clampLimit(value: number | undefined, fallback: number): number {
		return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(value ?? fallback)));
	}

	#list(
		manager: AsyncJobManager | undefined,
		registry: AgentRegistry,
		ownerId: string,
		params: SubagentParams,
	): AgentToolResult<SubagentToolDetails> {
		const verbosity = params.verbosity ?? DEFAULT_VERBOSITY;
		const limit = this.#clampLimit(params.limit, DEFAULT_LIST_LIMIT);
		const jobs = this.#taskJobs(manager, ownerId);
		const all = jobs.map(job => this.#snapshot(job, registry.get(job.id), job.id, verbosity));
		const { kept: subagents, truncated } = this.#applyLimit(all, limit);
		const lines =
			subagents.length === 0
				? ["No subagents spawned yet."]
				: [`${all.length} subagent(s):`, ...subagents.map(s => this.#snapshotLine(s, verbosity))];
		if (truncated) lines.push(`… ${truncated} more (raise \`limit\`, max ${MAX_LIST_LIMIT}, to see them)`);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action: "list", subagents, ...(truncated ? { truncated } : {}) },
		};
	}

	#inspect(
		manager: AsyncJobManager | undefined,
		registry: AgentRegistry,
		ownerId: string,
		params: SubagentParams,
	): AgentToolResult<SubagentToolDetails> {
		const verbosity = params.verbosity ?? DEFAULT_VERBOSITY;
		const ids = this.#targetIds(params);
		const jobs = ids
			? ids.map(id => this.#visibleJob(manager, ownerId, id)).filter((j): j is AsyncJob => j != null)
			: this.#taskJobs(manager, ownerId).filter(job => job.status === "running");
		if (ids && jobs.length === 0) {
			return errorResult(`No matching subagents found for: ${ids.join(", ")}`, "inspect");
		}
		const all = jobs.map(job => this.#snapshot(job, registry.get(job.id), job.id, verbosity));
		// Explicit ids are never truncated — the caller already bounded the set.
		// Omitting ids falls back to every running spawn, capped at MAX_LIST_LIMIT.
		const { kept: subagents, truncated } = ids
			? { kept: all, truncated: undefined }
			: this.#applyLimit(all, MAX_LIST_LIMIT);
		const lines = subagents.map(s => {
			const parts = [this.#snapshotLine(s, verbosity)];
			if (s.resultText) parts.push(`  ${s.resultText}`);
			if (s.errorText) parts.push(`  error: ${s.errorText}`);
			return parts.join("\n");
		});
		if (truncated) lines.push(`… ${truncated} more running (max ${MAX_LIST_LIMIT} shown)`);
		return {
			content: [{ type: "text", text: lines.length ? lines.join("\n") : "No running subagents." }],
			details: { action: "inspect", subagents, ...(truncated ? { truncated } : {}) },
			useless: subagents.length === 0,
		};
	}

	async #await(
		manager: AsyncJobManager | undefined,
		registry: AgentRegistry,
		ownerId: string,
		params: SubagentParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
	): Promise<AgentToolResult<SubagentToolDetails>> {
		if (!manager) return errorResult("Async execution is disabled; no background subagents to await.", "await");
		const verbosity = params.verbosity ?? DEFAULT_VERBOSITY;
		const ids = this.#targetIds(params);
		const watched = ids
			? ids.map(id => this.#visibleJob(manager, ownerId, id)).filter((j): j is AsyncJob => j != null)
			: manager
					.getRunningJobs({ ownerId })
					.filter(job => job.type === "task")
					.slice(0, MAX_LIST_LIMIT);
		if (watched.length === 0) {
			const text = ids?.length
				? `No matching subagents found for: ${ids.join(", ")}`
				: "No running subagents to await.";
			return { content: [{ type: "text", text }], details: { action: "await", subagents: [] }, useless: true };
		}

		const snapshotAll = () =>
			watched.map(job => this.#snapshot(manager.getJob(job.id) ?? job, registry.get(job.id), job.id, verbosity));

		const running = watched.filter(job => job.status === "running");
		if (running.length === 0) {
			const subagents = snapshotAll();
			return {
				content: [{ type: "text", text: subagents.map(s => this.#snapshotLine(s, verbosity)).join("\n") }],
				details: { action: "await", subagents },
			};
		}

		const timeoutMs = Math.min(
			MAX_AWAIT_TIMEOUT_MS,
			Math.max(0, Math.floor(params.timeout_ms ?? DEFAULT_AWAIT_TIMEOUT_MS)),
		);
		const racePromises: Promise<unknown>[] = running.map(job => job.promise);
		const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
		const timeoutHandle = timeoutMs > 0 ? setTimeout(() => timeoutResolve(), timeoutMs) : undefined;
		if (timeoutMs > 0) racePromises.push(timeoutPromise);

		const watchedIds = running.map(job => job.id);
		manager.watchJobs(watchedIds);

		const PROGRESS_INTERVAL_MS = 500;
		const emitProgress = () => {
			if (!onUpdate) return;
			onUpdate({ content: [{ type: "text", text: "" }], details: { action: "await", subagents: snapshotAll() } });
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();

		try {
			if (signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					await Promise.race([...racePromises, abortPromise]);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else {
				await Promise.race(racePromises);
			}
		} finally {
			manager.unwatchJobs(watchedIds);
			clearTimeout(timeoutHandle);
			if (progressTimer) clearInterval(progressTimer);
		}

		const subagents = snapshotAll();
		return {
			content: [{ type: "text", text: subagents.map(s => this.#snapshotLine(s, verbosity)).join("\n") }],
			details: { action: "await", subagents },
		};
	}

	#cancel(
		manager: AsyncJobManager | undefined,
		registry: AgentRegistry,
		ownerId: string,
		params: SubagentParams,
	): AgentToolResult<SubagentToolDetails> {
		const ids = this.#targetIds(params);
		if (!ids?.length) {
			throw new ToolError('`id` or `ids` is required for action="cancel".');
		}

		const cancelled: SubagentToolDetails["cancelled"] = [];
		const resolved: { id: string; ref: AgentRef | undefined; job: AsyncJob | undefined }[] = [];
		for (const id of ids) {
			const ref = registry.get(id);
			const job = this.#visibleJob(manager, ownerId, id);
			resolved.push({ id, ref, job });
			this.#pausedIds.delete(id);
			if (!job && !ref) {
				cancelled.push({ id, status: "not_found" });
				continue;
			}
			// A job still tracked as running (first run in flight) cancels through
			// AsyncJobManager. A live turn started by a later `resume`/`steer` has
			// no job to cancel — abort the session directly instead. Either path
			// mutates the same `job`/`ref` object in place, so the snapshot below
			// reuses these references instead of re-querying the manager/registry.
			if (job?.status === "running" && manager) {
				cancelled.push({ id, status: manager.cancel(id, { ownerId }) ? "cancelled" : "already_completed" });
			} else if (ref?.status === "running" && ref.session) {
				ref.session.abort({ reason: "Cancelled via subagent tool" }).catch(() => {});
				cancelled.push({ id, status: "cancelled" });
			} else {
				cancelled.push({ id, status: "already_completed" });
			}
		}
		const verbosity = params.verbosity ?? DEFAULT_VERBOSITY;
		const subagents = resolved.map(({ id, job, ref }) => this.#snapshot(job, ref, id, verbosity));
		const lines = cancelled.map(c => `- ${c.id}: ${c.status}`);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action: "cancel", subagents, cancelled },
		};
	}

	/**
	 * Shared `IrcBus.send` + snapshot + result-shaping tail for steer/resume/pause,
	 * which otherwise differ only in the delivered body, the success wording, and
	 * how `#pausedIds` reacts to a successful delivery.
	 */
	async #deliver(
		manager: AsyncJobManager | undefined,
		registry: AgentRegistry,
		senderId: string,
		id: string,
		body: string,
		action: SubagentParams["action"],
		verbosity: Verbosity,
		successText: (outcome: IrcDeliveryReceipt["outcome"]) => string,
		onDelivered?: (outcome: IrcDeliveryReceipt["outcome"]) => void,
	): Promise<AgentToolResult<SubagentToolDetails>> {
		const receipt = await IrcBus.global().send({ from: senderId, to: id, body });
		onDelivered?.(receipt.outcome);
		const subagents = [this.#snapshot(manager?.getJob(id), registry.get(id), id, verbosity)];
		const text =
			receipt.outcome === "failed"
				? `Failed to ${action} ${id}: ${receipt.error ?? "unknown error"}`
				: successText(receipt.outcome);
		return {
			content: [{ type: "text", text }],
			details: { action, subagents, receipt },
			isError: receipt.outcome === "failed",
		};
	}

	/** Appends the `[pause requested]` directive to an optional message body, used by both `steer ... pause: true` and `pause`. */
	#withPauseDirective(message?: string): string {
		return message
			? `${message}\n\n[pause requested] ${DEFAULT_PAUSE_DIRECTIVE}`
			: `[pause requested] ${DEFAULT_PAUSE_DIRECTIVE}`;
	}

	async #steer(
		registry: AgentRegistry,
		senderId: string,
		params: SubagentParams,
	): Promise<AgentToolResult<SubagentToolDetails>> {
		const id = params.id;
		const message = params.message?.trim();
		if (!id) throw new ToolError('`id` is required for action="steer".');
		if (!message) throw new ToolError('`message` is required for action="steer".');
		if (id === senderId) throw new ToolError("Cannot steer yourself.");

		const body = params.pause ? this.#withPauseDirective(message) : message;
		return this.#deliver(
			this.session.asyncJobManager,
			registry,
			senderId,
			id,
			body,
			"steer",
			params.verbosity ?? DEFAULT_VERBOSITY,
			outcome => `Steered ${id} (${outcome}).`,
			outcome => {
				if (outcome === "failed") return;
				if (params.pause) this.#pausedIds.add(id);
				else this.#pausedIds.delete(id);
			},
		);
	}

	async #resume(
		manager: AsyncJobManager | undefined,
		registry: AgentRegistry,
		senderId: string,
		params: SubagentParams,
	): Promise<AgentToolResult<SubagentToolDetails>> {
		const id = params.id;
		if (!id) throw new ToolError('`id` is required for action="resume".');
		if (id === senderId) throw new ToolError("Cannot resume yourself.");
		const verbosity = params.verbosity ?? DEFAULT_VERBOSITY;

		const ref = registry.get(id);
		const job = this.#visibleJob(manager, senderId, id);
		if (!ref && !job) return errorResult(`Unknown subagent "${id}".`, "resume");

		if (ref?.status === "running") {
			return {
				content: [{ type: "text", text: `${id} is already running; nothing to resume.` }],
				details: { action: "resume", subagents: [this.#snapshot(job, ref, id, verbosity)] },
			};
		}
		if (job?.queued) {
			return {
				content: [{ type: "text", text: `${id} is queued, already waiting for a spawn slot.` }],
				details: { action: "resume", subagents: [this.#snapshot(job, ref, id, verbosity)] },
			};
		}

		const message = params.message?.trim();
		if (!message) {
			throw new ToolError(
				`\`message\` is required to resume "${id}" — it has no pending work to continue on its own.`,
			);
		}
		return this.#deliver(
			manager,
			registry,
			senderId,
			id,
			message,
			"resume",
			verbosity,
			outcome => `Resumed ${id} (${outcome}).`,
			outcome => {
				if (outcome !== "failed") this.#pausedIds.delete(id);
			},
		);
	}

	async #pause(
		manager: AsyncJobManager | undefined,
		registry: AgentRegistry,
		senderId: string,
		params: SubagentParams,
	): Promise<AgentToolResult<SubagentToolDetails>> {
		const id = params.id;
		if (!id) throw new ToolError('`id` is required for action="pause".');
		if (id === senderId) throw new ToolError("Cannot pause yourself.");
		const verbosity = params.verbosity ?? DEFAULT_VERBOSITY;

		const ref = registry.get(id);
		const job = this.#visibleJob(manager, senderId, id);
		if (ref?.status !== "running") {
			return {
				content: [{ type: "text", text: `${id} is not running; nothing to pause.` }],
				details: { action: "pause", subagents: [this.#snapshot(job, ref, id, verbosity)] },
			};
		}

		const directive = this.#withPauseDirective(params.message?.trim());
		return this.#deliver(
			manager,
			registry,
			senderId,
			id,
			directive,
			"pause",
			verbosity,
			outcome =>
				`Requested a pause on ${id} (${outcome}). It will finish its current step and go idle — resume it later with a message.`,
			outcome => {
				if (outcome !== "failed") this.#pausedIds.add(id);
			},
		);
	}
}
