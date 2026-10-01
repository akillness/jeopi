import { logger } from "jeopi-utils";
import { MessengerHttpError, messengerFetchJson, splitMessengerText, waitForMessengerRetry } from "./http";
import type { MessengerAdapter, MessengerMessage, MessengerPlatformConfig, MessengerTransportDeps } from "./types";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_RECENT_MESSAGES = 2_000;
const PERMANENT_ERRORS: Record<string, true> = {
	invalid_auth: true,
	not_authed: true,
	account_inactive: true,
	token_expired: true,
	token_revoked: true,
	missing_scope: true,
	missing_args: true,
	not_allowed_token_type: true,
	no_permission: true,
	access_denied: true,
	accesslimited: true,
	forbidden_team: true,
	team_access_not_granted: true,
	enterprise_is_restricted: true,
	two_factor_setup_required: true,
};

class SlackConfigurationError extends Error {}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function requiredToken(value: string | undefined, prefix: string): string {
	if (!value?.startsWith(prefix) || value.length === prefix.length || /\s/.test(value)) {
		throw new SlackConfigurationError("Slack token configuration is invalid");
	}
	return value;
}

async function slackRequest(
	method: "auth.test" | "apps.connections.open" | "chat.postMessage",
	token: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>> {
	let response: unknown;
	try {
		response = await messengerFetchJson(
			`https://slack.com/api/${method}`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
				body: JSON.stringify(body),
			},
			signal,
			fetchImpl,
		);
	} catch (error) {
		if (error instanceof MessengerHttpError && error.status === 429) throw error;
		if (error instanceof MessengerHttpError && (error.status === 401 || error.status === 403)) {
			throw new SlackConfigurationError("Slack authentication or permission failed");
		}
		throw new Error("Slack API request failed");
	}
	const data = object(response);
	if (data?.ok !== true) {
		if (typeof data?.error === "string" && Object.hasOwn(PERMANENT_ERRORS, data.error)) {
			throw new SlackConfigurationError("Slack authentication or permission failed");
		}
		throw new Error("Slack API request failed");
	}
	return data;
}

function socketUrl(value: unknown): string {
	let url: URL;
	try {
		if (typeof value !== "string") throw new Error();
		url = new URL(value);
	} catch {
		throw new SlackConfigurationError("Slack returned an invalid Socket Mode endpoint");
	}
	if (
		url.protocol !== "wss:" ||
		!(url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) ||
		(url.port !== "" && url.port !== "443") ||
		url.username ||
		url.password ||
		url.hash
	) {
		throw new SlackConfigurationError("Slack returned an invalid Socket Mode endpoint");
	}
	return url.href;
}

function messageFromEnvelope(
	envelope: Record<string, unknown>,
	teamId: string,
	botUserId: string,
): MessengerMessage | undefined {
	if (envelope.type !== "events_api") return undefined;
	const payload = object(envelope.payload);
	if (payload?.team_id !== teamId) return undefined;
	const event = object(payload.event);
	if (
		!event ||
		(event.type !== "message" && event.type !== "app_mention") ||
		event.bot_id !== undefined ||
		event.bot_profile !== undefined ||
		event.subtype !== undefined ||
		event.edited !== undefined ||
		event.hidden === true ||
		typeof event.user !== "string" ||
		!event.user ||
		event.user === botUserId ||
		typeof event.channel !== "string" ||
		!event.channel ||
		typeof event.ts !== "string" ||
		!event.ts ||
		typeof event.text !== "string"
	) {
		return undefined;
	}
	let mentioned = false;
	const text = event.text
		.replace(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g, (mention: string, user: string) => {
			if (user !== botUserId) return mention;
			mentioned = true;
			return "";
		})
		.trim();
	const direct = event.channel_type === "im" || (event.channel_type === undefined && event.channel.startsWith("D"));
	const threadId =
		typeof event.thread_ts === "string" && event.thread_ts ? event.thread_ts : direct ? undefined : event.ts;
	return {
		platform: "slack",
		accountId: teamId,
		channelId: event.channel,
		senderId: event.user,
		// message and app_mention have different event IDs for the same message.
		messageId: event.ts,
		text,
		threadId,
		direct,
		mentioned,
	};
}

async function receiveSocket(
	url: string,
	teamId: string,
	botUserId: string,
	recent: Set<string>,
	onMessage: (message: MessengerMessage) => Promise<void>,
	signal: AbortSignal,
	Socket: typeof WebSocket,
): Promise<void> {
	if (signal.aborted) return;
	let socket: WebSocket;
	try {
		socket = new Socket(url);
	} catch {
		throw new Error("Slack Socket Mode connection failed");
	}
	const completion = Promise.withResolvers<void>();
	let settled = false;
	const timer = setTimeout(() => finish(), CONNECT_TIMEOUT_MS);
	function finish(error?: SlackConfigurationError): void {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		signal.removeEventListener("abort", stop);
		socket.removeEventListener("message", message);
		socket.removeEventListener("close", stop);
		socket.removeEventListener("error", stop);
		try {
			socket.close();
		} catch {
			// Closing an already failed connection must not prevent cancellation.
		}
		if (error) completion.reject(error);
		else completion.resolve();
	}
	function stop(): void {
		finish();
	}
	function message(incoming: MessageEvent): void {
		if (settled || signal.aborted || typeof incoming.data !== "string") return;
		let envelope: Record<string, unknown> | undefined;
		try {
			envelope = object(JSON.parse(incoming.data));
		} catch {
			return;
		}
		if (!envelope) return;
		if (typeof envelope.envelope_id === "string") {
			try {
				// ACK precedes filtering and callback work, including unsupported envelopes.
				socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
			} catch {
				finish();
				return;
			}
		}
		if (envelope.type === "hello") {
			clearTimeout(timer);
			return;
		}
		if (envelope.type === "disconnect") {
			finish(
				envelope.reason === "link_disabled"
					? new SlackConfigurationError("Slack Socket Mode is disabled")
					: undefined,
			);
			return;
		}
		const parsed = messageFromEnvelope(envelope, teamId, botUserId);
		if (!parsed) return;
		const key = JSON.stringify([parsed.accountId, parsed.channelId, parsed.messageId]);
		if (recent.has(key)) return;
		recent.add(key);
		if (recent.size > MAX_RECENT_MESSAGES) {
			const oldest = recent.values().next().value;
			if (oldest !== undefined) recent.delete(oldest);
		}
		void Promise.resolve()
			.then(() => {
				if (!signal.aborted) return onMessage(parsed);
			})
			.catch(() => logger.warn("Slack incoming message handler failed"));
	}
	socket.addEventListener("message", message);
	socket.addEventListener("close", stop);
	socket.addEventListener("error", stop);
	signal.addEventListener("abort", stop, { once: true });
	if (signal.aborted) finish();
	await completion.promise;
}

export function createSlackAdapter(
	config: MessengerPlatformConfig,
	env: Record<string, string | undefined> = process.env,
	deps: MessengerTransportDeps = {},
): MessengerAdapter {
	let teamId: string | undefined;
	let running = false;
	return {
		platform: "slack",
		async start(onMessage, signal) {
			if (signal.aborted) return;
			if (running) throw new SlackConfigurationError("Slack adapter is already running");
			const botToken = requiredToken(env[config.tokenEnv], "xoxb-");
			const appToken = requiredToken(env[config.appTokenEnv ?? "JEOPI_SLACK_APP_TOKEN"], "xapp-");
			const recent = new Set<string>();
			let botUserId: string | undefined;
			let backoff = BACKOFF_BASE_MS;
			running = true;
			try {
				while (!signal.aborted) {
					const startedAt = Date.now();
					let retryAfterMs = 0;
					try {
						if (!botUserId || !teamId) {
							const identity = await slackRequest("auth.test", botToken, {}, signal, deps.fetch);
							if (
								typeof identity.team_id !== "string" ||
								!identity.team_id ||
								typeof identity.user_id !== "string" ||
								!identity.user_id
							) {
								throw new SlackConfigurationError("Slack returned an invalid bot identity");
							}
							teamId = identity.team_id;
							botUserId = identity.user_id;
						}
						const connection = await slackRequest("apps.connections.open", appToken, {}, signal, deps.fetch);
						await receiveSocket(
							socketUrl(connection.url),
							teamId,
							botUserId,
							recent,
							onMessage,
							signal,
							deps.WebSocket ?? WebSocket,
						);
					} catch (error) {
						if (signal.aborted) break;
						if (error instanceof SlackConfigurationError) throw error;
						if (error instanceof MessengerHttpError) retryAfterMs = error.retryAfterMs ?? 0;
						logger.warn("Slack transport disconnected; retrying");
					}
					if (signal.aborted) break;
					if (Date.now() - startedAt >= BACKOFF_MAX_MS) backoff = BACKOFF_BASE_MS;
					await waitForMessengerRetry(Math.max(backoff, retryAfterMs), signal);
					backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
				}
			} finally {
				running = false;
			}
		},
		async send(message, text, signal) {
			if (message.platform !== "slack" || (teamId !== undefined && message.accountId !== teamId)) {
				throw new SlackConfigurationError("Slack reply account does not match");
			}
			const token = requiredToken(env[config.tokenEnv], "xoxb-");
			const chunks = splitMessengerText(text, 4_000);
			const sendSignal = signal ?? new AbortController().signal;
			for (const [index, chunk] of chunks.entries()) {
				if (index > 0) await waitForMessengerRetry(1_000, sendSignal);
				if (sendSignal.aborted) throw new Error("Slack send cancelled");
				await slackRequest(
					"chat.postMessage",
					token,
					{
						channel: message.channelId,
						text: chunk,
						thread_ts: message.threadId ?? (message.direct ? undefined : message.messageId),
						mrkdwn: false,
						parse: "none",
						link_names: false,
						unfurl_links: false,
						unfurl_media: false,
					},
					sendSignal,
					deps.fetch,
				);
			}
		},
	};
}
