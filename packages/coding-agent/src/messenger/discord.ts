import { isRecord, logger } from "jeopi-utils";
import { MessengerHttpError, messengerFetchJson, splitMessengerText } from "./http";
import type { MessengerAdapter, MessengerMessage, MessengerPlatformConfig, MessengerTransportDeps } from "./types";

// Protocol: https://docs.discord.com/developers/events/gateway
// Close codes: https://docs.discord.com/developers/topics/opcodes-and-status-codes
// REST messages: https://docs.discord.com/developers/resources/message#create-message
const API = "https://discord.com/api/v10";
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
const PERMANENT_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

class DiscordConfigurationError extends Error {}

export interface DiscordClock {
	/** Schedule once and return an idempotent cancellation function. */
	schedule(callback: () => void, delayMs: number): () => void;
	random(): number;
}

export interface DiscordTransportDeps extends MessengerTransportDeps {
	clock?: DiscordClock;
}

const defaultClock: DiscordClock = {
	schedule(callback, delayMs) {
		const timer = setTimeout(callback, delayMs);
		return () => clearTimeout(timer);
	},
	random: Math.random,
};

function waitForReconnect(delayMs: number, signal: AbortSignal, clock: DiscordClock): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	const result = Promise.withResolvers<void>();
	const finish = (): void => {
		cancel();
		signal.removeEventListener("abort", finish);
		result.resolve();
	};
	const cancel = clock.schedule(finish, delayMs);
	signal.addEventListener("abort", finish, { once: true });
	if (signal.aborted) finish();
	return result.promise;
}

interface DiscordSession {
	id?: string;
	url?: string;
	sequence: number | null;
}

function gatewayUrl(value: unknown): string {
	let url: URL;
	try {
		if (typeof value !== "string") throw new Error();
		url = new URL(value);
	} catch {
		throw new DiscordConfigurationError("Discord returned an invalid Gateway URL");
	}
	if (
		url.protocol !== "wss:" ||
		!/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname) ||
		url.username ||
		url.password ||
		url.port ||
		url.hash ||
		url.pathname !== "/"
	) {
		throw new DiscordConfigurationError("Discord returned an untrusted Gateway URL");
	}
	url.search = "?v=10&encoding=json";
	return url.href;
}

function clearSession(session: DiscordSession): void {
	session.id = undefined;
	session.url = undefined;
	session.sequence = null;
}

function normalizeMessage(value: unknown, accountId: string): MessengerMessage | undefined {
	if (!isRecord(value) || !isRecord(value.author)) return;
	if (value.author.bot || value.webhook_id || value.author.id === accountId) return;
	if (
		typeof value.id !== "string" ||
		!value.id ||
		typeof value.channel_id !== "string" ||
		!value.channel_id ||
		typeof value.author.id !== "string" ||
		!value.author.id ||
		typeof value.content !== "string" ||
		!value.content.trim() ||
		(value.type !== undefined && value.type !== 0 && value.type !== 19)
	)
		return;
	const mentioned =
		Array.isArray(value.mentions) && value.mentions.some(user => isRecord(user) && user.id === accountId);
	const text = value.content.replaceAll(`<@${accountId}>`, "").replaceAll(`<@!${accountId}>`, "").trim();
	if (!text) return;
	return {
		platform: "discord",
		accountId,
		channelId: value.channel_id,
		senderId: value.author.id,
		messageId: value.id,
		text,
		direct: value.guild_id === undefined,
		mentioned,
	};
}

function connectGateway(
	url: string,
	token: string,
	accountId: string,
	session: DiscordSession,
	onMessage: (message: MessengerMessage) => Promise<void>,
	signal: AbortSignal,
	WebSocketImpl: typeof WebSocket,
	clock: DiscordClock,
): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	const result = Promise.withResolvers<void>();
	let socket: WebSocket;
	try {
		socket = new WebSocketImpl(url);
	} catch {
		clearSession(session);
		return Promise.resolve();
	}
	let finished = false;
	let hello = false;
	let established = false;
	let acknowledged = true;
	let cancelHeartbeat: (() => void) | undefined;
	let cancelHandshake: (() => void) | undefined;

	const finish = (error?: Error): void => {
		if (finished) return;
		finished = true;
		// A failed resume handshake must fall back to the initial Gateway.
		if (!established) clearSession(session);
		cancelHeartbeat?.();
		cancelHandshake?.();
		signal.removeEventListener("abort", abort);
		socket.removeEventListener("message", receive);
		socket.removeEventListener("close", close);
		socket.removeEventListener("error", failed);
		try {
			// Normal shutdown invalidates the session; reconnects must preserve it.
			socket.close(signal.aborted ? 1000 : 4000);
		} catch {
			// A failed handshake can already have closed the underlying socket.
		}
		if (error) result.reject(error);
		else result.resolve();
	};
	const abort = (): void => finish();
	const failed = (): void => finish();
	const send = (op: number, d: unknown): void => {
		if (finished) return;
		try {
			socket.send(JSON.stringify({ op, d }));
		} catch {
			finish();
		}
	};
	const heartbeat = (): void => {
		acknowledged = false;
		send(1, session.sequence);
	};
	const close = (event: CloseEvent): void => {
		if (PERMANENT_CLOSE_CODES.has(event.code)) {
			const reason =
				event.code === 4004
					? "authentication failed"
					: event.code === 4013 || event.code === 4014
						? "message intents are invalid or not enabled"
						: "Gateway configuration is unsupported";
			finish(new DiscordConfigurationError(`Discord ${reason} (Gateway ${event.code})`));
			return;
		}
		if ([1000, 1001, 4003, 4007, 4009].includes(event.code)) clearSession(session);
		finish();
	};
	const receive = (event: MessageEvent): void => {
		if (finished || signal.aborted) return;
		let packet: unknown;
		try {
			if (typeof event.data !== "string") return;
			packet = JSON.parse(event.data);
		} catch {
			finish();
			return;
		}
		if (!isRecord(packet)) return;
		if (packet.op === 10) {
			if (hello) return;
			if (
				!isRecord(packet.d) ||
				typeof packet.d.heartbeat_interval !== "number" ||
				!Number.isFinite(packet.d.heartbeat_interval) ||
				packet.d.heartbeat_interval <= 0 ||
				packet.d.heartbeat_interval > 300_000
			) {
				finish(new DiscordConfigurationError("Discord returned an invalid heartbeat interval"));
				return;
			}
			hello = true;
			const interval = packet.d.heartbeat_interval;
			const tick = (): void => {
				if (finished) return;
				if (!acknowledged) {
					finish();
					return;
				}
				heartbeat();
				if (!finished) cancelHeartbeat = clock.schedule(tick, interval);
			};
			cancelHeartbeat = clock.schedule(tick, clock.random() * interval);
			if (session.id && session.sequence !== null) {
				send(6, { token, session_id: session.id, seq: session.sequence });
			} else {
				send(2, {
					token,
					intents: INTENTS,
					properties: { os: process.platform, browser: "jeopi", device: "jeopi" },
				});
			}
		} else if (packet.op === 11) {
			acknowledged = true;
		} else if (packet.op === 1) {
			// Unsolicited requests must not shorten the scheduled ACK deadline.
			send(1, session.sequence);
		} else if (packet.op === 7 || packet.op === 9) {
			if (packet.op === 9 && packet.d !== true) clearSession(session);
			finish();
		} else if (packet.op === 0) {
			if (typeof packet.s === "number" && Number.isSafeInteger(packet.s)) session.sequence = packet.s;
			if (packet.t === "READY") {
				if (!isRecord(packet.d) || typeof packet.d.session_id !== "string" || !packet.d.session_id) {
					finish(new DiscordConfigurationError("Discord returned an invalid Gateway session"));
					return;
				}
				try {
					session.url = gatewayUrl(packet.d.resume_gateway_url);
				} catch {
					finish(new DiscordConfigurationError("Discord returned an untrusted resume Gateway URL"));
					return;
				}
				session.id = packet.d.session_id;
				established = true;
				cancelHandshake?.();
			} else if (packet.t === "RESUMED") {
				established = true;
				cancelHandshake?.();
			} else if (packet.t === "MESSAGE_CREATE") {
				const message = normalizeMessage(packet.d, accountId);
				if (message) {
					// The gateway owns authorization, deduplication and its bounded work queue.
					void Promise.resolve()
						.then(() => {
							if (!signal.aborted) return onMessage(message);
						})
						.catch(() => logger.warn("Discord message handler failed"));
				}
			}
		}
	};
	socket.addEventListener("message", receive);
	socket.addEventListener("close", close);
	socket.addEventListener("error", failed);
	signal.addEventListener("abort", abort, { once: true });
	cancelHandshake = clock.schedule(() => finish(), 35_000);
	if (signal.aborted) finish();
	return result.promise;
}

export function createDiscordAdapter(
	config: MessengerPlatformConfig,
	env: Record<string, string | undefined> = process.env,
	deps: DiscordTransportDeps = {},
): MessengerAdapter {
	const token = env[config.tokenEnv]?.trim();
	const clock = deps.clock ?? defaultClock;
	const headers = (): Record<string, string> => {
		if (!token) throw new DiscordConfigurationError("Discord bot token is missing");
		return { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
	};
	return {
		platform: "discord",
		async start(onMessage, signal) {
			const session: DiscordSession = { sequence: null };
			let accountId: string | undefined;
			let initialUrl: string | undefined;
			let delay = 5_000;
			while (!signal.aborted) {
				let retryDelay = delay;
				try {
					if (!accountId) {
						const user = await messengerFetchJson(`${API}/users/@me`, { headers: headers() }, signal, deps.fetch);
						if (signal.aborted) return;
						if (!isRecord(user) || typeof user.id !== "string" || !user.id || user.bot !== true) {
							throw new DiscordConfigurationError("Discord credentials must identify a bot account");
						}
						accountId = user.id;
					}
					if (!initialUrl) {
						const gateway = await messengerFetchJson(
							`${API}/gateway/bot`,
							{ headers: headers() },
							signal,
							deps.fetch,
						);
						if (!isRecord(gateway))
							throw new DiscordConfigurationError("Discord returned invalid Gateway discovery");
						if (isRecord(gateway.session_start_limit) && gateway.session_start_limit.remaining === 0) {
							throw new DiscordConfigurationError("Discord Gateway session start limit is exhausted");
						}
						initialUrl = gatewayUrl(gateway.url);
					}
					await connectGateway(
						session.url ?? initialUrl,
						token!,
						accountId,
						session,
						onMessage,
						signal,
						deps.WebSocket ?? WebSocket,
						clock,
					);
				} catch (error) {
					if (signal.aborted) return;
					if (error instanceof DiscordConfigurationError) throw error;
					if (
						error instanceof MessengerHttpError &&
						error.status >= 400 &&
						error.status < 500 &&
						error.status !== 429
					) {
						throw new DiscordConfigurationError(
							`Discord authentication or configuration failed (HTTP ${error.status})`,
						);
					}
					if (error instanceof MessengerHttpError && error.retryAfterMs !== undefined) {
						retryDelay = Math.max(retryDelay, error.retryAfterMs);
					}
					logger.warn("Discord connection failed; retrying");
				}
				if (signal.aborted) return;
				try {
					await waitForReconnect(retryDelay, signal, clock);
				} catch {
					if (signal.aborted) return;
					throw new Error("Discord reconnect wait failed");
				}
				delay = Math.min(delay * 2, 30_000);
			}
		},
		async send(message, text, signal) {
			const chunks = splitMessengerText(text, 2_000);
			for (let index = 0; index < chunks.length; index++) {
				await messengerFetchJson(
					`${API}/channels/${encodeURIComponent(message.channelId)}/messages`,
					{
						method: "POST",
						headers: headers(),
						body: JSON.stringify({
							content: chunks[index],
							allowed_mentions: { parse: [], replied_user: false },
							...(index === 0
								? { message_reference: { message_id: message.messageId, fail_if_not_exists: false } }
								: {}),
						}),
					},
					signal,
					deps.fetch,
				);
			}
		},
	};
}
