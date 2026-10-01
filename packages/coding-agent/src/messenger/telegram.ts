import { logger } from "jeopi-utils";
import { MessengerHttpError, messengerFetchJson, splitMessengerText, waitForMessengerRetry } from "./http";
import type { MessengerAdapter, MessengerMessage, MessengerPlatformConfig, MessengerTransportDeps } from "./types";

interface TelegramIdentity {
	id: number;
	username: string;
}

class TelegramApiError extends Error {
	constructor(
		readonly status: number,
		readonly retryAfterMs = 0,
	) {
		super("Telegram API request failed");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function isPositiveId(value: unknown): value is number {
	return isInteger(value) && value > 0;
}

function parseIdentity(value: unknown): TelegramIdentity {
	if (
		!isRecord(value) ||
		!isPositiveId(value.id) ||
		value.is_bot !== true ||
		typeof value.username !== "string" ||
		!/^[a-zA-Z0-9_]{1,32}$/.test(value.username)
	) {
		throw new TelegramApiError(400);
	}
	return { id: value.id, username: value.username };
}

function stripMention(
	text: string,
	entities: unknown,
	identity: TelegramIdentity,
): { text: string; mentioned: boolean } {
	const mention = `@${identity.username.toLowerCase()}`;
	const ranges: { start: number; end: number }[] = [];
	if (Array.isArray(entities)) {
		for (const entity of entities) {
			if (
				!isRecord(entity) ||
				!isInteger(entity.offset) ||
				!isPositiveId(entity.length) ||
				entity.offset < 0 ||
				entity.offset + entity.length > text.length
			) {
				continue;
			}
			const start = entity.offset;
			const end = start + entity.length;
			const value = text.slice(start, end).toLowerCase();
			if (
				(entity.type === "mention" && value === mention) ||
				(entity.type === "text_mention" && isRecord(entity.user) && entity.user.id === identity.id)
			) {
				ranges.push({ start, end });
			} else if (
				entity.type === "bot_command" &&
				/^\/[a-z0-9_]+@[a-z0-9_]+$/.test(value) &&
				value.endsWith(mention)
			) {
				ranges.push({ start: end - mention.length, end });
			}
		}
	} else if (entities === undefined) {
		// Username is validated before interpolation; reject email/name substrings.
		const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_@])@${identity.username}(?![\\p{L}\\p{N}_])`, "giu");
		for (const match of text.matchAll(pattern)) {
			const start = match.index + match[1].length;
			ranges.push({ start, end: start + mention.length });
		}
	}
	if (ranges.length === 0) return { text, mentioned: false };
	ranges.sort((left, right) => left.start - right.start);
	let cursor = 0;
	let stripped = "";
	for (const range of ranges) {
		if (range.start < cursor) continue;
		stripped += text.slice(cursor, range.start);
		cursor = range.end;
	}
	return { text: (stripped + text.slice(cursor)).trim(), mentioned: true };
}

function parseMessage(value: unknown, identity: TelegramIdentity): MessengerMessage | undefined {
	if (
		!isRecord(value) ||
		!isPositiveId(value.message_id) ||
		typeof value.text !== "string" ||
		!isRecord(value.from) ||
		!isPositiveId(value.from.id) ||
		value.from.is_bot !== false ||
		!isRecord(value.chat) ||
		!isInteger(value.chat.id) ||
		value.chat.id === 0 ||
		(value.chat.type !== "private" && value.chat.type !== "group" && value.chat.type !== "supergroup") ||
		(value.message_thread_id !== undefined && !isPositiveId(value.message_thread_id)) ||
		value.edit_date !== undefined ||
		value.sender_chat !== undefined
	) {
		return undefined;
	}
	const content = stripMention(value.text, value.entities, identity);
	const direct = value.chat.type === "private";
	if (!content.text.trim()) return undefined;
	return {
		platform: "telegram",
		accountId: String(identity.id),
		channelId: String(value.chat.id),
		senderId: String(value.from.id),
		messageId: String(value.message_id),
		text: content.text,
		...(value.message_thread_id === undefined ? {} : { threadId: String(value.message_thread_id) }),
		direct,
		mentioned: content.mentioned,
	};
}

function isPermanent(error: unknown): boolean {
	if (!(error instanceof TelegramApiError || error instanceof MessengerHttpError)) return false;
	return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

export function createTelegramAdapter(
	config: MessengerPlatformConfig,
	env: Record<string, string | undefined> = process.env,
	deps: MessengerTransportDeps = {},
): MessengerAdapter {
	const token = env[config.tokenEnv];
	if (!token?.trim()) throw new Error("Telegram bot token is missing");
	const baseUrl = `https://api.telegram.org/bot${encodeURIComponent(token).replaceAll("%3A", ":")}/`;
	let running = false;
	let offset = 0;

	async function request(method: string, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const response = await messengerFetchJson(
			`${baseUrl}${method}`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parameters) },
			signal,
			deps.fetch,
		);
		if (!isRecord(response) || typeof response.ok !== "boolean") throw new TelegramApiError(400);
		if (!response.ok) {
			const status = isInteger(response.error_code) ? response.error_code : 400;
			const retryAfter = isRecord(response.parameters) ? response.parameters.retry_after : undefined;
			throw new TelegramApiError(status, isPositiveId(retryAfter) ? Math.min(retryAfter, 300) * 1_000 : 0);
		}
		if (!("result" in response)) throw new TelegramApiError(400);
		return response.result;
	}

	return {
		platform: "telegram",
		async start(onMessage, signal) {
			if (signal.aborted) return;
			if (running) throw new Error("Telegram adapter is already running");
			running = true;
			const stopped = Promise.withResolvers<void>();
			const onAbort = () => stopped.resolve();
			signal.addEventListener("abort", onAbort, { once: true });
			let identity: TelegramIdentity | undefined;
			let retryMs = 1_000;
			try {
				while (!signal.aborted) {
					try {
						identity ??= parseIdentity(await request("getMe", {}, signal));
						if (signal.aborted) break;
						const updates = await request(
							"getUpdates",
							{ offset, timeout: 25, allowed_updates: ["message"] },
							signal,
						);
						if (!Array.isArray(updates)) throw new TelegramApiError(400);
						retryMs = 1_000;
						for (const update of updates) {
							if (signal.aborted) break;
							if (
								!isRecord(update) ||
								!isInteger(update.update_id) ||
								update.update_id < 0 ||
								update.update_id === Number.MAX_SAFE_INTEGER
							) {
								throw new TelegramApiError(400);
							}
							if (update.update_id < offset) continue;
							// Acknowledge even ignored/failed callbacks: replaying can duplicate replies.
							offset = update.update_id + 1;
							const message = parseMessage(update.message, identity);
							if (!message) continue;
							const processing = Promise.resolve()
								.then(() => onMessage(message))
								.catch(() => {
									logger.warn("Telegram message handler failed");
								});
							await Promise.race([processing, stopped.promise]);
						}
					} catch (error) {
						if (signal.aborted) break;
						if (isPermanent(error)) throw new Error("Telegram authentication or polling configuration failed");
						const delay =
							error instanceof TelegramApiError || error instanceof MessengerHttpError
								? Math.max(retryMs, error.retryAfterMs ?? 0)
								: retryMs;
						await waitForMessengerRetry(delay, signal);
						retryMs = Math.min(retryMs * 2, 30_000);
					}
				}
			} finally {
				signal.removeEventListener("abort", onAbort);
				running = false;
			}
		},
		async send(message, text, signal) {
			const threadId = message.threadId === undefined ? undefined : Number(message.threadId);
			if (threadId !== undefined && !isPositiveId(threadId)) throw new Error("Telegram topic identifier is invalid");
			for (const chunk of splitMessengerText(text, 4_096)) {
				// Never retry an ambiguous send failure: Telegram may already have delivered it.
				const result = await request(
					"sendMessage",
					{
						chat_id: message.channelId,
						text: chunk,
						...(threadId === undefined ? {} : { message_thread_id: threadId }),
					},
					signal,
				);
				if (!isRecord(result) || !isPositiveId(result.message_id)) throw new TelegramApiError(400);
			}
		},
	};
}
