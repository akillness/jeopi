import { logger } from "jeopi-utils";
import { createMessengerSessionBridge, type MessengerSessionBridge } from "./session";
import type { MessengerConfig, MessengerMessage } from "./types";

/** Gateway pool → session process. */
export type MessengerSessionInbound =
	| { type: "ping"; id: string }
	| { type: "init"; id: string; config: MessengerConfig }
	| { type: "turn"; id: string; message: MessengerMessage }
	| { type: "abort"; id: string }
	| { type: "close"; id: string };

/** Session process → gateway pool. Failures carry no detail: tool output and provider errors stay here. */
export type MessengerSessionOutbound =
	| { type: "pong"; id: string }
	| { type: "activity"; id: string; text: string }
	| { type: "reply"; id: string; text: string }
	| { type: "failed"; id: string }
	| { type: "closed"; id: string };

export interface MessengerSessionTransport {
	send(message: MessengerSessionOutbound): void;
	onMessage(handler: (message: MessengerSessionInbound) => void): () => void;
}

/**
 * Serve one conversation's isolated AgentSession inside its own session process. The pool serializes turns, so
 * the bridge sees one turn at a time and keeps its tool isolation and persisted history unchanged.
 */
export function startMessengerSessionWorker(
	transport: MessengerSessionTransport,
	createBridge: typeof createMessengerSessionBridge = createMessengerSessionBridge,
): void {
	let bridge: MessengerSessionBridge | undefined;
	const turns = new Map<string, AbortController>();
	transport.onMessage(message => {
		switch (message.type) {
			case "ping":
				transport.send({ type: "pong", id: message.id });
				return;
			case "init":
				if (bridge) return;
				try {
					bridge = createBridge(message.config);
				} catch {
					logger.warn("Messenger session process could not create its session");
				}
				return;
			case "turn": {
				const current = bridge;
				if (!current) {
					transport.send({ type: "failed", id: message.id });
					return;
				}
				const controller = new AbortController();
				turns.set(message.id, controller);
				void current
					.reply(message.message, controller.signal, text =>
						transport.send({ type: "activity", id: message.id, text }),
					)
					.then(
						text => transport.send({ type: "reply", id: message.id, text }),
						() => transport.send({ type: "failed", id: message.id }),
					)
					.finally(() => turns.delete(message.id));
				return;
			}
			case "abort":
				turns.get(message.id)?.abort();
				return;
			case "close":
				for (const controller of turns.values()) controller.abort();
				void (bridge?.close() ?? Promise.resolve())
					.catch(() => logger.warn("Messenger session process shutdown failed"))
					.finally(() => transport.send({ type: "closed", id: message.id }));
				return;
		}
	});
}
