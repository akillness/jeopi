import { logger } from "jeopi-utils";
import { MessengerHttpError } from "./http";
import type {
	MessengerActivityReporter,
	MessengerAdapter,
	MessengerConfig,
	MessengerMessage,
	MessengerReply,
} from "./types";
import { MessengerFatalError } from "./types";

const MAX_MESSAGE_LENGTH = 32_000;
const MAX_QUEUED_MESSAGES = 100;
const MAX_SEEN_MESSAGES = 10_000;
const STATUS_TIMEOUT_MS = 1000;
const MAX_STATUS_IN_FLIGHT = 8;
const MAX_ACTIVITY_LENGTH = 120;
// Status edits are cosmetic: keep them sparse so they never compete with reply delivery for rate limits.
const ACTIVITY_INTERVAL_MS = 2_000;
const ACTIVITY_TIMEOUT_MS = 3_000;

/** Collapse to one bounded line: drop invisible format characters, fold control and whitespace runs. */
function activityLine(text: string): string {
	const line = text
		.replace(/\p{Cf}/gu, "")
		.replace(/[\p{Cc}\p{Z}\s]+/gu, " ")
		.trim();
	if (line.length <= MAX_ACTIVITY_LENGTH) return line;
	let end = MAX_ACTIVITY_LENGTH - 1;
	const last = line.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return `${line.slice(0, end).trimEnd()}…`;
}

interface ActivityReporter {
	report: MessengerActivityReporter;
	/** Stop updates and remove any shown line; idempotent and never rejects. */
	close(): Promise<void>;
}

const NO_ACTIVITY: ActivityReporter = { report() {}, close: () => Promise.resolve() };

/**
 * Bound a cosmetic adapter call: a stalled provider request must not hold up the request queue. A timeout
 * rejects so callers can retry; cancellation through `signal` resolves because the request is ending.
 */
async function boundedActivity(run: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<void> {
	const timeout = new AbortController();
	const callSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
	const stopped = Promise.withResolvers<void>();
	const onStop = (): void => {
		if (timeout.signal.aborted) stopped.reject(new Error("Messenger activity update timed out"));
		else stopped.resolve();
	};
	callSignal.addEventListener("abort", onStop, { once: true });
	const timer = setTimeout(() => timeout.abort(), ACTIVITY_TIMEOUT_MS);
	try {
		await Promise.race([Promise.resolve().then(() => run(callSignal)), stopped.promise]);
	} finally {
		clearTimeout(timer);
		callSignal.removeEventListener("abort", onStop);
	}
}

/**
 * Coalesce a request's activity into one status line: show the first report at once, then at most the
 * latest line per interval. Removal skips the request signal so an aborted request still retires its line.
 */
function createActivityReporter(
	adapter: MessengerAdapter,
	destination: MessengerMessage,
	signal: AbortSignal,
	intervalMs: number,
): ActivityReporter {
	const activity = adapter.activity;
	if (!activity) return NO_ACTIVITY;
	let latest: string | undefined;
	let sent: string | undefined;
	let shown = false;
	let closed = false;
	let pumping = false;
	let pump = Promise.resolve();
	let nextAt = 0;
	let wake: (() => void) | undefined;
	let closing: Promise<void> | undefined;
	const update = (text: string | undefined, callSignal?: AbortSignal): Promise<void> =>
		boundedActivity(bounded => activity.call(adapter, destination, text, bounded), callSignal);
	const pause = async (ms: number): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, ms);
		wake = () => {
			clearTimeout(timer);
			resolve();
		};
		try {
			await promise;
		} finally {
			wake = undefined;
		}
	};
	const run = async (): Promise<void> => {
		try {
			while (!closed && !signal.aborted && latest !== sent) {
				const delay = nextAt - Date.now();
				if (delay > 0) {
					await pause(delay);
					continue;
				}
				const text = latest;
				sent = text;
				shown = true;
				let spacing = intervalMs;
				try {
					await update(text, signal);
				} catch (error) {
					if (error instanceof MessengerHttpError && error.status === 429) {
						// Keep the line pending: a rate-limited update is retried unless a newer line replaces it.
						sent = undefined;
						spacing = Math.max(spacing, error.retryAfterMs ?? 1_000);
					} else if (!signal.aborted) {
						logger.warn("Messenger activity update failed", { platform: destination.platform });
					}
				}
				nextAt = Date.now() + spacing;
			}
		} finally {
			pumping = false;
		}
	};
	return {
		report(text) {
			if (closed || signal.aborted) return;
			const line = activityLine(text);
			if (!line) return;
			latest = line;
			if (pumping) return;
			pumping = true;
			pump = run();
		},
		close() {
			closing ??= (async () => {
				closed = true;
				wake?.();
				await pump;
				if (!shown) return;
				for (let attempt = 0; ; attempt++) {
					try {
						await update(undefined);
						return;
					} catch (error) {
						const wait =
							error instanceof MessengerHttpError && error.status === 429
								? (error.retryAfterMs ?? 1_000)
								: 1_000;
						// One bounded retry: removal holds the request queue.
						if (attempt > 0 || wait > ACTIVITY_TIMEOUT_MS) {
							logger.warn("Messenger activity removal failed", { platform: destination.platform });
							return;
						}
						await Bun.sleep(wait);
					}
				}
			})();
			return closing;
		},
	};
}

/** Include the sender even in shared threads: remote histories must not cross users. */
export function messengerConversationKey(message: MessengerMessage): string {
	return JSON.stringify([
		message.platform,
		message.accountId,
		message.parentChannelId ?? message.channelId,
		message.threadId ?? "",
		message.senderId,
	]);
}

/** Stable per-conversation route shared by the persisted session file and its session process. */
export function messengerSessionRoute(cwd: string, message: MessengerMessage): string {
	return new Bun.CryptoHasher("sha256").update(JSON.stringify([cwd, messengerConversationKey(message)])).digest("hex");
}

/**
 * Scheduling heuristic, refined after `prepare`: a top-level server message on a prepare-capable adapter
 * (Discord) starts its own reply thread, so it is never held behind queued work; every other message waits for
 * earlier requests in its conversation. A follow-up arriving in that new thread is ordered behind the request
 * that created it by the prepared-conversation lock in `processRequest`.
 */
function schedulingKey(message: MessengerMessage, adapter: MessengerAdapter): string {
	if (adapter.prepare && !message.direct && !message.threadId && !message.parentChannelId) {
		return JSON.stringify([message.platform, message.accountId, message.channelId, message.messageId]);
	}
	return messengerConversationKey(message);
}

export function isMessengerMessageAllowed(message: MessengerMessage, config: MessengerConfig): boolean {
	const platform = config.platforms[message.platform];
	return Boolean(
		platform &&
			message.accountId &&
			message.channelId &&
			message.senderId &&
			message.messageId &&
			(message.text.trim() ||
				(message.platform === "discord" && config.platforms.discord?.artifactDir && message.attachments?.length)) &&
			message.text.length <= MAX_MESSAGE_LENGTH &&
			platform.allowedUserIds.includes(message.senderId) &&
			(!platform.allowedChannelIds ||
				platform.allowedChannelIds.includes(message.channelId) ||
				(Boolean(message.parentChannelId) && platform.allowedChannelIds.includes(message.parentChannelId!))) &&
			(message.direct || message.mentioned || (message.platform === "discord" && Boolean(message.parentChannelId))),
	);
}

interface PendingMessage {
	message: MessengerMessage;
	adapter: MessengerAdapter;
	signal: AbortSignal;
	resolve: () => void;
	/** Requests sharing a key never run at the same time. */
	key: string;
}

export interface MessengerGateway {
	run(signal: AbortSignal): Promise<void>;
	handle(message: MessengerMessage, signal?: AbortSignal): Promise<void>;
}

export interface MessengerGatewayOptions {
	/** Minimum spacing between in-place activity edits for one request. */
	activityIntervalMs?: number;
	/**
	 * Requests processed at once (default 1). Requests of one prepared conversation still answer and deliver in
	 * order; above 1 the reply implementation must accept concurrent turns for different conversations.
	 */
	concurrency?: number;
}

export function createMessengerGateway(
	config: MessengerConfig,
	adapters: MessengerAdapter[],
	reply: MessengerReply,
	options: MessengerGatewayOptions = {},
): MessengerGateway {
	const activityIntervalMs = Math.max(0, options.activityIntervalMs ?? ACTIVITY_INTERVAL_MS);
	const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
	const byPlatform = new Map(adapters.map(adapter => [adapter.platform, adapter]));
	if (byPlatform.size !== adapters.length) throw new Error("Duplicate messenger adapter");
	for (const platform of Object.keys(config.platforms)) {
		if (!adapters.some(adapter => adapter.platform === platform))
			throw new Error("Missing configured messenger adapter");
	}
	const seen = new Set<string>();
	const queue: PendingMessage[] = [];
	const activeKeys = new Set<string>();
	const turns = new Set<Promise<void>>();
	/** Settles when the latest request of a prepared conversation has delivered its reply. */
	const conversationTails = new Map<string, Promise<void>>();
	const lifetime = new AbortController();
	let running = false;
	let fatalError: MessengerFatalError | undefined;
	let statusInFlight = 0;

	async function processRequest(pending: PendingMessage): Promise<void> {
		const { message, adapter, signal, resolve } = pending;
		let failed = false;
		let activity = NO_ACTIVITY;
		let release = (): void => {};
		let tail: Promise<void> | undefined;
		let conversation = "";
		let statusChain = Promise.resolve();
		const status = (state: "processing" | "success" | "failure"): void => {
			if (!adapter.status) return;
			statusChain = statusChain.then(async () => {
				if (signal.aborted || statusInFlight >= MAX_STATUS_IN_FLIGHT) return;
				const timeout = new AbortController();
				const statusSignal = AbortSignal.any([signal, timeout.signal]);
				const stopped = Promise.withResolvers<void>();
				const onAbort = (): void => stopped.resolve();
				statusSignal.addEventListener("abort", onAbort, { once: true });
				statusInFlight++;
				const operation = Promise.resolve().then(() => adapter.status!(message, state, statusSignal));
				void operation.then(
					() => {
						statusInFlight--;
					},
					() => {
						statusInFlight--;
					},
				);
				const timer = setTimeout(() => timeout.abort(), STATUS_TIMEOUT_MS);
				try {
					await Promise.race([operation, stopped.promise]);
				} catch {
					if (!signal.aborted) logger.warn("Messenger status update failed", { platform: message.platform });
				} finally {
					clearTimeout(timer);
					statusSignal.removeEventListener("abort", onAbort);
				}
			});
		};
		try {
			if (signal.aborted) return;
			status("processing");
			const destination = (await adapter.prepare?.(message, signal)) ?? message;
			// Answer and deliver in arrival order per prepared conversation, so a follow-up in a new thread can
			// neither overtake nor interleave with the reply of the request that created it.
			conversation = messengerConversationKey(destination);
			const previous = conversationTails.get(conversation);
			const done = Promise.withResolvers<void>();
			release = done.resolve;
			tail = done.promise;
			conversationTails.set(conversation, tail);
			await previous;
			activity = createActivityReporter(adapter, destination, signal, activityIntervalMs);
			let text: string;
			try {
				text = await reply(destination, signal, activity.report);
			} catch (error) {
				failed = true;
				if (error instanceof MessengerFatalError) {
					fatalError = error;
					status("failure");
					lifetime.abort();
					return;
				}
				if (signal.aborted) return;
				logger.warn("Messenger agent turn failed", { platform: message.platform });
				text = "The request could not be completed. Please try again.";
			} finally {
				// Retire the status line alongside reply delivery rather than delaying the reply on it.
				void activity.close();
			}
			if (!signal.aborted && text.trim()) {
				// A failed send may already have delivered a chunk: never retry the entire reply.
				await adapter.send(destination, text, signal);
			}
			if (!signal.aborted) status(failed ? "failure" : "success");
		} catch {
			if (!signal.aborted) {
				logger.warn("Messenger reply delivery failed", { platform: message.platform });
				status("failure");
			}
		} finally {
			await activity.close();
			release();
			if (tail && conversationTails.get(conversation) === tail) conversationTails.delete(conversation);
			resolve();
		}
	}

	/** Start queued requests in arrival order while capacity allows, skipping conversations already running. */
	function schedule(): void {
		for (let index = 0; index < queue.length && turns.size < concurrency; ) {
			const pending = queue[index]!;
			if (activeKeys.has(pending.key)) {
				index++;
				continue;
			}
			queue.splice(index, 1);
			activeKeys.add(pending.key);
			const turn = processRequest(pending).finally(() => {
				activeKeys.delete(pending.key);
				turns.delete(turn);
				schedule();
			});
			turns.add(turn);
		}
	}

	function handle(message: MessengerMessage, signal?: AbortSignal): Promise<void> {
		const adapter = byPlatform.get(message.platform);
		const effectiveSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
		if (effectiveSignal.aborted || !adapter || !isMessengerMessageAllowed(message, config)) return Promise.resolve();
		const id = JSON.stringify([message.platform, message.accountId, message.channelId, message.messageId]);
		if (seen.has(id) || queue.length >= MAX_QUEUED_MESSAGES) return Promise.resolve();
		seen.add(id);
		if (seen.size > MAX_SEEN_MESSAGES) {
			const oldest = seen.values().next().value;
			if (oldest !== undefined) seen.delete(oldest);
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		queue.push({ message, adapter, signal: effectiveSignal, resolve, key: schedulingKey(message, adapter) });
		schedule();
		return promise;
	}

	return {
		handle,
		async run(signal) {
			if (running || lifetime.signal.aborted) throw new Error("Messenger gateway cannot be restarted");
			running = true;
			const abort = (): void => lifetime.abort();
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			const starts: Promise<void>[] = [];
			try {
				if (lifetime.signal.aborted) return;
				for (const adapter of adapters) {
					starts.push(
						Promise.resolve().then(async () => {
							await adapter.start(message => handle(message), lifetime.signal);
							if (!lifetime.signal.aborted) throw new Error("Messenger transport stopped unexpectedly");
						}),
					);
				}
				await Promise.all(starts);
				if (fatalError) throw fatalError;
			} catch {
				if (fatalError) throw fatalError;
				if (!signal.aborted)
					throw new Error("Messenger connection failed; check provider credentials, permissions and connectivity");
			} finally {
				lifetime.abort();
				await Promise.allSettled(starts);
				while (turns.size > 0) await Promise.allSettled(turns);
				signal.removeEventListener("abort", abort);
			}
		},
	};
}
