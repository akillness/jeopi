import { logger } from "jeopi-utils";
import type { MessengerAdapter, MessengerConfig, MessengerMessage, MessengerReply } from "./types";
import { MessengerFatalError } from "./types";

const MAX_MESSAGE_LENGTH = 32_000;
const MAX_QUEUED_MESSAGES = 100;
const MAX_SEEN_MESSAGES = 10_000;

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

export function isMessengerMessageAllowed(message: MessengerMessage, config: MessengerConfig): boolean {
	const platform = config.platforms[message.platform];
	return Boolean(
		platform &&
			message.accountId &&
			message.channelId &&
			message.senderId &&
			message.messageId &&
			message.text.trim() &&
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
}

export interface MessengerGateway {
	run(signal: AbortSignal): Promise<void>;
	handle(message: MessengerMessage, signal?: AbortSignal): Promise<void>;
}

export function createMessengerGateway(
	config: MessengerConfig,
	adapters: MessengerAdapter[],
	reply: MessengerReply,
): MessengerGateway {
	const byPlatform = new Map(adapters.map(adapter => [adapter.platform, adapter]));
	if (byPlatform.size !== adapters.length) throw new Error("Duplicate messenger adapter");
	for (const platform of Object.keys(config.platforms)) {
		if (!adapters.some(adapter => adapter.platform === platform))
			throw new Error("Missing configured messenger adapter");
	}
	const seen = new Set<string>();
	const queue: PendingMessage[] = [];
	const lifetime = new AbortController();
	let draining: Promise<void> | undefined;
	let workerActive = false;
	let running = false;
	let fatalError: MessengerFatalError | undefined;

	async function drain(): Promise<void> {
		while (queue.length > 0) {
			const pending = queue.shift();
			if (!pending) break;
			const { message, adapter, signal, resolve } = pending;
			let failed = false;
			const status = async (state: "processing" | "success" | "failure"): Promise<void> => {
				try {
					await adapter.status?.(message, state, signal);
				} catch {
					if (!signal.aborted) logger.warn("Messenger status update failed", { platform: message.platform });
				}
			};
			try {
				if (signal.aborted) continue;
				await status("processing");
				const destination = (await adapter.prepare?.(message, signal)) ?? message;
				let text: string;
				try {
					text = await reply(destination, signal);
				} catch (error) {
					failed = true;
					if (error instanceof MessengerFatalError) {
						fatalError = error;
						await status("failure");
						lifetime.abort();
						continue;
					}
					if (signal.aborted) continue;
					logger.warn("Messenger agent turn failed", { platform: message.platform });
					text = "The request could not be completed. Please try again.";
				}
				if (!signal.aborted && text.trim()) {
					// A failed send may already have delivered a chunk: never retry the entire reply.
					await adapter.send(destination, text, signal);
				}
				if (!signal.aborted) await status(failed ? "failure" : "success");
			} catch {
				if (!signal.aborted) {
					logger.warn("Messenger reply delivery failed", { platform: message.platform });
					await status("failure");
				}
			} finally {
				resolve();
			}
		}
		workerActive = false;
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
		queue.push({ message, adapter, signal: effectiveSignal, resolve });
		if (!workerActive) {
			workerActive = true;
			draining = drain();
		}
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
				await draining;
				signal.removeEventListener("abort", abort);
			}
		},
	};
}
