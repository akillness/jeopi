import * as logger from "jeopi-utils/logger";
import type { AgentEvent, AgentMessage, AsideMessage } from "./types";

/**
 * Core-integrated Telegram remote-control pipeline.
 *
 * The daemon is embedded in the Core Engine (`jeopi-agent-core`) rather than the
 * CLI layer so every plugin, subagent, and custom worker that holds an
 * {@link Agent} can wire remote control natively. It is a two-way event/callback
 * bridge:
 *
 * - **Outbound** — subscribe to the agent event bus and push notifications
 *   (run completion, tool failures) to a Telegram chat.
 * - **Inbound** — long-poll the Telegram Bot API for operator messages, filter
 *   them to the authorized chat, and surface them both to registered callbacks
 *   ({@link onInbound}) and to the agent's non-interrupting aside channel
 *   ({@link drainInbound}).
 *
 * The transport (`fetch`) is injectable so the pipeline is exercised in tests
 * without a live network or bot token.
 */

/** Telegram Bot API base host (no trailing slash). */
const DEFAULT_API_BASE = "https://api.telegram.org";
/** Default long-poll timeout in seconds passed to `getUpdates`. */
const DEFAULT_POLL_TIMEOUT_SEC = 30;
/** Telegram hard-caps a message at 4096 UTF-16 code units; stay safely under it. */
const MAX_MESSAGE_LENGTH = 3900;
/** Back-off after a failed poll round so a persistent outage does not hot-loop. */
const POLL_BACKOFF_MS = 1000;

export interface TelegramControlConfig {
	/** Bot token from @BotFather. */
	botToken: string;
	/** The single chat authorized to drive the agent. Messages from any other chat are dropped. */
	chatId: string | number;
	/** Override the API host (e.g. a local Bot API server). Defaults to {@link DEFAULT_API_BASE}. */
	apiBaseUrl?: string;
	/** Long-poll timeout (seconds) for `getUpdates`. Defaults to {@link DEFAULT_POLL_TIMEOUT_SEC}. */
	pollTimeoutSec?: number;
	/** Injectable transport for testing. Defaults to the global `fetch`. */
	fetch?: typeof fetch;
	/** Notify the chat when an agent run finishes. Defaults to `true`. */
	notifyOnComplete?: boolean;
	/** Notify the chat when a tool call fails. Defaults to `true`. */
	notifyOnToolError?: boolean;
}

/** A normalized inbound Telegram message from the authorized chat. */
export interface TelegramInbound {
	/** Telegram `update_id` (monotonic; drives the poll offset). */
	updateId: number;
	/** Originating chat id. */
	chatId: number;
	/** Message text. */
	text: string;
	/** Telegram message date in **seconds** since epoch. */
	date: number;
	/** Sender `@username`, when present. */
	from?: string;
}

/** Minimal structural view of the agent's event surface — avoids a hard class dependency. */
export interface AgentEventSource {
	subscribe(fn: (e: AgentEvent) => void): () => void;
	setAsideMessageProvider(fn: (() => AsideMessage[] | Promise<AsideMessage[]>) | undefined): void;
}

type InboundListener = (message: TelegramInbound) => void;

interface RawTelegramUpdate {
	update_id?: unknown;
	message?: {
		text?: unknown;
		date?: unknown;
		chat?: { id?: unknown };
		from?: { username?: unknown };
	};
}

export class TelegramControl {
	readonly #token: string;
	readonly #chatId: number;
	readonly #base: string;
	readonly #pollTimeoutSec: number;
	readonly #fetch: typeof fetch;
	readonly #notifyOnComplete: boolean;
	readonly #notifyOnToolError: boolean;

	readonly #inboundQueue: TelegramInbound[] = [];
	readonly #inboundListeners = new Set<InboundListener>();
	readonly #unsubscribers = new Set<() => void>();

	/** Next `getUpdates` offset = highest processed `update_id` + 1. */
	#offset = 0;
	#running = false;
	#loop: Promise<void> | null = null;

	constructor(config: TelegramControlConfig) {
		if (!config.botToken) throw new Error("TelegramControl requires a botToken");
		const chatId = Number(config.chatId);
		if (!Number.isFinite(chatId)) throw new Error(`TelegramControl requires a numeric chatId, got ${config.chatId}`);
		this.#token = config.botToken;
		this.#chatId = chatId;
		this.#base = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
		this.#pollTimeoutSec = config.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC;
		this.#fetch = config.fetch ?? fetch;
		this.#notifyOnComplete = config.notifyOnComplete ?? true;
		this.#notifyOnToolError = config.notifyOnToolError ?? true;
	}

	/** True while the long-poll loop is active. */
	get running(): boolean {
		return this.#running;
	}

	#url(method: string): string {
		return `${this.#base}/bot${this.#token}/${method}`;
	}

	/**
	 * Send a message to the authorized chat. Returns `true` on a Telegram `ok`
	 * response, `false` on any transport or API error (never throws — a failed
	 * notification must not break an agent run).
	 */
	async notify(text: string): Promise<boolean> {
		const trimmed = text.trim();
		if (!trimmed) return false;
		const body = JSON.stringify({
			chat_id: this.#chatId,
			text: trimmed.length > MAX_MESSAGE_LENGTH ? `${trimmed.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : trimmed,
		});
		try {
			const res = await this.#fetch(this.#url("sendMessage"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			if (!res.ok) {
				logger.warn("Telegram sendMessage failed", { status: res.status });
				return false;
			}
			const data = (await res.json()) as { ok?: unknown };
			return data?.ok === true;
		} catch (err) {
			logger.warn("Telegram sendMessage threw", { error: err instanceof Error ? err.message : String(err) });
			return false;
		}
	}

	/**
	 * Run one `getUpdates` round: fetch pending updates, advance the offset, drop
	 * anything not from the authorized chat, enqueue the rest, and fan them out to
	 * {@link onInbound} listeners. Returns the accepted inbound messages. Never
	 * throws — returns `[]` on any error.
	 */
	async poll(): Promise<TelegramInbound[]> {
		let updates: RawTelegramUpdate[];
		try {
			const url = `${this.#url("getUpdates")}?offset=${this.#offset}&timeout=${this.#pollTimeoutSec}`;
			const res = await this.#fetch(url);
			if (!res.ok) {
				logger.warn("Telegram getUpdates failed", { status: res.status });
				return [];
			}
			const data = (await res.json()) as { ok?: unknown; result?: unknown };
			if (data?.ok !== true || !Array.isArray(data.result)) return [];
			updates = data.result as RawTelegramUpdate[];
		} catch (err) {
			logger.warn("Telegram getUpdates threw", { error: err instanceof Error ? err.message : String(err) });
			return [];
		}

		const accepted: TelegramInbound[] = [];
		for (const update of updates) {
			const updateId = Number(update.update_id);
			if (!Number.isFinite(updateId)) continue;
			// Advance the offset for EVERY update (even rejected ones) so the poll
			// does not re-fetch messages from unauthorized chats forever.
			if (updateId >= this.#offset) this.#offset = updateId + 1;

			const message = update.message;
			const chatId = Number(message?.chat?.id);
			const text = typeof message?.text === "string" ? message.text : "";
			if (!text || chatId !== this.#chatId) continue;
			const inbound: TelegramInbound = {
				updateId,
				chatId,
				text,
				date: Number(message?.date) || Math.floor(Date.now() / 1000),
				from: typeof message?.from?.username === "string" ? message.from.username : undefined,
			};
			accepted.push(inbound);
			this.#inboundQueue.push(inbound);
			for (const listener of this.#inboundListeners) {
				try {
					listener(inbound);
				} catch (err) {
					logger.warn("Telegram inbound listener threw", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}
		return accepted;
	}

	/** Register an inbound-message callback. Returns an unsubscribe function. */
	onInbound(listener: InboundListener): () => void {
		this.#inboundListeners.add(listener);
		return () => this.#inboundListeners.delete(listener);
	}

	/**
	 * Drain queued inbound messages as agent user messages, clearing the queue.
	 * Intended for the agent's aside-message provider so operator commands enter
	 * the run at a safe step boundary without aborting an in-flight tool.
	 */
	drainInbound(): AgentMessage[] {
		if (this.#inboundQueue.length === 0) return [];
		const drained = this.#inboundQueue.splice(0, this.#inboundQueue.length);
		return drained.map(
			(inbound): AgentMessage => ({
				role: "user",
				content: inbound.text,
				timestamp: inbound.date * 1000,
			}),
		);
	}

	/**
	 * Wire the pipeline to an agent: forward selected agent events to the chat as
	 * notifications, and feed inbound Telegram messages into the agent's aside
	 * channel. Returns a detach function that removes both wirings.
	 */
	attach(agent: AgentEventSource): () => void {
		const unsubscribe = agent.subscribe(event => {
			void this.#onAgentEvent(event);
		});
		agent.setAsideMessageProvider(() => this.drainInbound());
		const detach = (): void => {
			unsubscribe();
			agent.setAsideMessageProvider(undefined);
			this.#unsubscribers.delete(detach);
		};
		this.#unsubscribers.add(detach);
		return detach;
	}

	async #onAgentEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_end" && this.#notifyOnComplete) {
			const summary = lastAssistantText(event.messages);
			await this.notify(summary ? `✅ Agent run complete\n\n${summary}` : "✅ Agent run complete");
			return;
		}
		if (event.type === "tool_execution_end" && event.isError && this.#notifyOnToolError) {
			await this.notify(`⚠️ Tool \`${event.toolName}\` failed`);
		}
	}

	/** Start the background long-poll loop. Idempotent. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#loop = this.#pollLoop();
	}

	/** Stop the long-poll loop and await its exit. Detaches any agent wirings. */
	async stop(): Promise<void> {
		this.#running = false;
		for (const detach of [...this.#unsubscribers]) detach();
		const loop = this.#loop;
		this.#loop = null;
		if (loop) await loop;
	}

	async #pollLoop(): Promise<void> {
		while (this.#running) {
			const accepted = await this.poll();
			// getUpdates already long-polls up to pollTimeoutSec, so an empty round
			// means the timeout elapsed — loop straight back. Only back off when a
			// round errored out (poll() returns [] on error too, but a genuine empty
			// long-poll is the common case, so a short back-off is acceptable and
			// keeps a hard outage from hot-looping).
			if (accepted.length === 0) await Bun.sleep(POLL_BACKOFF_MS);
		}
	}
}

/** Extract the last assistant text block from a run's messages, truncated for Telegram. */
function lastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const content: unknown = (message as { content?: unknown }).content;
		if (typeof content === "string") return content.trim();
		if (Array.isArray(content)) {
			let text = "";
			for (const part of content) {
				const record = part as { type?: unknown; text?: unknown };
				if (record?.type === "text" && typeof record.text === "string") text += record.text;
			}
			return text.trim();
		}
		return "";
	}
	return "";
}

/**
 * Build a {@link TelegramControl} from `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
 * environment variables, or `null` when either is unset — so a host can start the
 * daemon only when it is configured.
 */
export function telegramControlFromEnv(
	env: Record<string, string | undefined> = process.env,
	overrides: Partial<TelegramControlConfig> = {},
): TelegramControl | null {
	const botToken = env.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_CHAT_ID;
	if (!botToken || !chatId) return null;
	return new TelegramControl({ botToken, chatId, ...overrides });
}
