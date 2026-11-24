import * as path from "node:path";
import type { AgentMessage } from "jeopi-agent-core";
import type { Message, UserMessage } from "jeopi-ai";
import { logger } from "jeopi-utils";
import { SessionManager } from "../session/session-manager";
import { fingerprintMessage } from "./message-fingerprint";

/**
 * Reserved transcript stem for advisor session files. Chosen so it cannot
 * collide with a task subagent's `<id>.jsonl` (task ids are reserved against
 * this exact stem in {@link AgentOutputManager}).
 */
export const ADVISOR_TRANSCRIPT_STEM = "__advisor";
export const ADVISOR_TRANSCRIPT_FILENAME = `${ADVISOR_TRANSCRIPT_STEM}.jsonl`;

const JSONL_SUFFIX = ".jsonl";

/**
 * Transcript filename for an advisor: `__advisor.jsonl` for the legacy/default
 * advisor (empty slug), `__advisor.<slug>.jsonl` for a named advisor. The `.`
 * separator keeps named files out of the output manager's `-<n>` bump namespace.
 */
export function advisorTranscriptFilename(slug: string): string {
	return slug ? `${ADVISOR_TRANSCRIPT_STEM}.${slug}${JSONL_SUFFIX}` : ADVISOR_TRANSCRIPT_FILENAME;
}

/** Whether a filename is any advisor transcript (`__advisor.jsonl` or `__advisor.<slug>.jsonl`). */
export function isAdvisorTranscriptName(name: string): boolean {
	return (
		name === ADVISOR_TRANSCRIPT_FILENAME ||
		(name.startsWith(`${ADVISOR_TRANSCRIPT_STEM}.`) && name.endsWith(JSONL_SUFFIX))
	);
}

/**
 * Append-only persister for an advisor agent's transcript.
 *
 * Includes positional replay-window deduplication (`beginTurn` / `commitTurn` /
 * `abandonTurn`) so retrying an advisor turn after a transient failure or
 * quarantine never writes duplicate user/assistant records into `__advisor.jsonl`.
 */
export class AdvisorTranscriptRecorder {
	#manager: SessionManager | undefined;
	#file: string | undefined;
	#filename: string;
	/** Serializes the async open/close against synchronous appends so records land in order. */
	#queue: Promise<void>;
	/** Fingerprints written during the current in-flight advisor turn. */
	#turnFingerprints: string[] = [];
	/** Positional replay window from an abandoned turn: skips matching prefix on retry. */
	#replayWindow: string[] | undefined;
	#replayIndex = 0;

	constructor(
		private readonly resolveSessionFile: () => string | undefined,
		private readonly resolveCwd: () => string,
		filename: string = ADVISOR_TRANSCRIPT_FILENAME,
		after?: Promise<unknown>,
	) {
		this.#filename = filename;
		this.#queue = after
			? after.then(
					() => {},
					() => {},
				)
			: Promise.resolve();
	}

	/** Delay subsequent transcript writes behind an external barrier (e.g. session reset). */
	blockWritesUntil(barrier: Promise<unknown>): void {
		this.#enqueue(() =>
			barrier.then(
				() => {},
				() => {},
			),
		);
	}

	/** Mark the start of an advisor review attempt. */
	beginTurn(): void {
		this.#turnFingerprints = [];
		this.#replayIndex = 0;
	}

	/** Commit the current attempt and discard any prior replay dedupe window. */
	commitTurn(): void {
		this.#turnFingerprints = [];
		this.#replayWindow = undefined;
		this.#replayIndex = 0;
	}

	/**
	 * Abandon an incomplete/failed attempt, preserving its persisted message
	 * fingerprints as a positional replay window so an immediate retry skips
	 * re-writing already-recorded prefix messages.
	 */
	abandonTurn(): void {
		if (this.#turnFingerprints.length > 0) {
			this.#replayWindow = this.#turnFingerprints;
		}
		this.#turnFingerprints = [];
		this.#replayIndex = 0;
	}

	/**
	 * Persist one finalized advisor message. Assistant turns carry the usage the
	 * stats parser reads; tool results round out the Hub transcript; user deltas
	 * (the advisor's "session update" prompts) are persisted but flagged
	 * `synthetic`/agent-attributed so they never inflate user-message metrics.
	 * Non-conversational message kinds are skipped.
	 */
	record(message: AgentMessage): void {
		let persisted: Message;
		switch (message.role) {
			case "assistant":
			case "toolResult":
				persisted = message;
				break;
			case "user":
				persisted = { ...(message as UserMessage), synthetic: true, attribution: "agent" };
				break;
			default:
				return;
		}

		const fp = fingerprintMessage(persisted);
		if (this.#replayWindow && this.#replayIndex < this.#replayWindow.length) {
			if (this.#replayWindow[this.#replayIndex] === fp) {
				this.#replayIndex++;
				this.#turnFingerprints.push(fp);
				return;
			}
			// Diverged from prior abandoned attempt — exit replay suppression.
			this.#replayWindow = undefined;
			this.#replayIndex = 0;
		}
		this.#turnFingerprints.push(fp);

		const sessionFile = this.resolveSessionFile();
		if (!sessionFile?.endsWith(JSONL_SUFFIX)) return;
		const file = path.join(sessionFile.slice(0, -JSONL_SUFFIX.length), this.#filename);
		const cwd = this.resolveCwd();
		this.#enqueue(async () => {
			if (file !== this.#file) {
				await this.#closeManager();
				this.#manager = await SessionManager.open(file, undefined, undefined, {
					initialCwd: cwd,
					suppressBreadcrumb: true,
				});
				this.#file = file;
			}
			this.#manager?.appendMessage(persisted);
		});
	}

	/** Flush pending writes (best-effort). */
	flush(): Promise<void> {
		return this.#enqueueResult(async () => {
			if (this.#manager) await this.#manager.flush();
		});
	}

	/** Flush and close the writer, releasing the session file. */
	close(): Promise<void> {
		return this.#enqueueResult(() => this.#closeManager());
	}

	async #closeManager(): Promise<void> {
		const manager = this.#manager;
		this.#manager = undefined;
		this.#file = undefined;
		if (!manager) return;
		try {
			await manager.close();
		} catch (err) {
			logger.debug("advisor transcript close failed", { err: String(err) });
		}
	}

	#enqueue(work: () => Promise<void>): void {
		this.#queue = this.#queue.then(work, work).catch(err => {
			logger.debug("advisor transcript record failed", { err: String(err) });
		});
	}

	#enqueueResult(work: () => Promise<void>): Promise<void> {
		const next = this.#queue.then(work, work);
		this.#queue = next.catch(() => {});
		return next;
	}
}
