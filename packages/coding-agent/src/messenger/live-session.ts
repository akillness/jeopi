import type { AssistantMessage, UserMessage } from "jeopi-ai";
import type { InteractiveModeContext } from "../modes/types";
import { loadMessengerConfig, validateMessengerEnvironment } from "./config";
import { createDiscordAdapter, type DiscordTransportDeps } from "./discord";
import { createMessengerGateway, isMessengerMessageAllowed, type MessengerGateway } from "./gateway";
import type { MessengerAdapter, MessengerConfig, MessengerReply } from "./types";

const DEFAULT_POLL_INTERVAL_MS = 250;
const LIVE_HOST_ABORT_TIMEOUT_MS = 1000;
const LIVE_BUSY_MESSAGE = "The live session is busy. Please try again when it is idle.";
const LIVE_UNAVAILABLE_MESSAGE = "The live Discord bridge is no longer attached to this session.";

export interface LiveDiscordBridgeDependencies {
	createAdapter?: typeof createDiscordAdapter;
	createGateway?: typeof createMessengerGateway;
	env?: Record<string, string | undefined>;
	transport?: DiscordTransportDeps;
	pollIntervalMs?: number;
}

export interface LiveDiscordBridge {
	readonly gateway: MessengerGateway;
	readonly active: boolean;
	run(signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
}

interface TurnCapture {
	readonly promptText: string;
	promptSeen: boolean;
	dispatched: boolean;
	hostSettled: boolean;
	conflicted: boolean;
}

export interface LiveDiscordBridgeOptions {
	/** Explicit acknowledgement that Discord requests may use this host session's tools. */
	acknowledgeFullControl?: boolean;
}

function userMessageText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}
function assistantMessageText(message: AssistantMessage): string {
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function sameSession(
	ctx: InteractiveModeContext,
	attachedSession: InteractiveModeContext["session"],
	sessionId: string,
	sessionFile: string | undefined,
): boolean {
	return (
		ctx.session === attachedSession &&
		!attachedSession.isDisposed &&
		ctx.sessionManager.getSessionId() === sessionId &&
		ctx.sessionManager.getSessionFile() === sessionFile &&
		!ctx.shutdownRequested &&
		!ctx.isShuttingDown
	);
}

function isCompetingMessage(message: { role: string; attribution?: string }): boolean {
	if (message.role === "user") return true;
	const attribution = message.attribution ?? "agent";
	return (
		(message.role === "custom" || message.role === "developer" || message.role === "hookMessage") &&
		attribution !== "agent"
	);
}

async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) throw new Error(LIVE_UNAVAILABLE_MESSAGE);
	const cancellation = Promise.withResolvers<never>();
	const onAbort = () => cancellation.reject(new Error(LIVE_UNAVAILABLE_MESSAGE));
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		return await Promise.race([operation, cancellation.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function awaitHostAbort(operation: Promise<void>): Promise<void> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => timeout.reject(new Error("Live Discord host abort timed out")),
		LIVE_HOST_ABORT_TIMEOUT_MS,
	);
	try {
		await Promise.race([operation, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

function liveConfig(config: MessengerConfig): MessengerConfig {
	const discord = config.platforms.discord;
	if (!discord) throw new Error("Live Discord requires a discord platform configuration");
	if (discord.allowedChannelIds === undefined || discord.allowedChannelIds.length === 0) {
		throw new Error("Live Discord requires an explicit nonempty allowedChannelIds list");
	}
	return { ...config, platforms: { discord } };
}

/**
 * Attach an authorized Discord transport to the already-running interactive session.
 * This never creates, switches, or disposes an AgentSession. The caller owns activation
 * and must retain the returned bridge to close it when the TUI shuts down.
 */
export function createLiveDiscordBridge(
	ctx: InteractiveModeContext,
	config: MessengerConfig,
	dependencies: LiveDiscordBridgeDependencies = {},
	options: LiveDiscordBridgeOptions = {},
): LiveDiscordBridge {
	if (!options.acknowledgeFullControl) {
		throw new Error(
			"Live Discord requires explicit full-control acknowledgement (--allow-full-control); " +
				"Discord requests run in the active session with its tools and approval policy",
		);
	}
	const scopedConfig = liveConfig(config);
	validateMessengerEnvironment(scopedConfig, dependencies.env);
	const attachedSession = ctx.session;
	const sessionId = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionId) throw new Error("Live Discord requires a persisted session identity");

	const lifetime = new AbortController();
	let closed = false;
	let runPromise: Promise<void> | undefined;
	let currentTurn: TurnCapture | undefined;
	let pollTimer: NodeJS.Timeout;
	let bridgeRef: LiveDiscordBridge | undefined;
	let close: () => Promise<void>;
	const reply: MessengerReply = async (message, signal) => {
		if (closed || signal?.aborted) throw new Error(LIVE_UNAVAILABLE_MESSAGE);
		if (!sameSession(ctx, attachedSession, sessionId, sessionFile)) throw new Error(LIVE_UNAVAILABLE_MESSAGE);
		if (!isMessengerMessageAllowed(message, scopedConfig)) throw new Error(LIVE_UNAVAILABLE_MESSAGE);
		if (
			attachedSession.isStreaming ||
			attachedSession.isCompacting ||
			attachedSession.isGeneratingHandoff ||
			attachedSession.isRetrying ||
			attachedSession.isBashRunning ||
			attachedSession.isEvalRunning ||
			attachedSession.hasPostPromptWork ||
			currentTurn
		)
			return LIVE_BUSY_MESSAGE;
		const promptText = `[Discord:${message.messageId} sender:${message.senderId} channel:${message.channelId}] ${message.text}`;
		const capture: TurnCapture = {
			promptText,
			promptSeen: false,
			dispatched: false,
			hostSettled: false,
			conflicted: false,
		};
		currentTurn = capture;

		try {
			ctx.showStatus(`Discord request from ${message.senderId}`);
		} catch {}
		const operationSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
		const unsubscribe = attachedSession.subscribe(event => {
			if (event.type !== "message_end") return;
			if (event.message.role === "user") {
				const text = userMessageText(event.message);
				if (!capture.promptSeen && text === capture.promptText) {
					capture.promptSeen = true;
				} else if (capture.promptSeen) {
					capture.conflicted = true;
				}
				return;
			}
			if (capture.promptSeen && isCompetingMessage(event.message)) capture.conflicted = true;
		});
		try {
			if (closed || operationSignal.aborted || !sameSession(ctx, attachedSession, sessionId, sessionFile))
				throw new Error(LIVE_UNAVAILABLE_MESSAGE);
			const promptPromise = attachedSession.prompt(promptText, {
				expandPromptTemplates: false,
				attribution: "user",
			});
			capture.dispatched = true;
			const dispatched = await awaitWithAbort(promptPromise, operationSignal);
			capture.dispatched = dispatched;
			await awaitWithAbort(attachedSession.waitForIdle(), operationSignal);
			capture.hostSettled = true;
			const turnMessages = attachedSession.messages;
			const promptIndices = turnMessages.flatMap((turnMessage, index) =>
				turnMessage.role === "user" && userMessageText(turnMessage) === promptText ? [index] : [],
			);
			capture.promptSeen = capture.promptSeen || promptIndices.length === 1;
			if (
				closed ||
				!dispatched ||
				!sameSession(ctx, attachedSession, sessionId, sessionFile) ||
				capture.conflicted ||
				promptIndices.length !== 1
			)
				throw new Error(LIVE_UNAVAILABLE_MESSAGE);
			const promptIndex = promptIndices[0]!;
			const messagesAfterPrompt = turnMessages.slice(promptIndex + 1);
			if (messagesAfterPrompt.some(isCompetingMessage)) throw new Error(LIVE_UNAVAILABLE_MESSAGE);
			const finalAssistant = messagesAfterPrompt.findLast(
				(turnMessage): turnMessage is AssistantMessage => turnMessage.role === "assistant",
			);
			if (finalAssistant?.stopReason !== "stop") throw new Error("Live Discord response unavailable");
			const response = assistantMessageText(finalAssistant);
			if (!response.trim()) throw new Error("Live Discord response unavailable");
			return response;
		} finally {
			unsubscribe();
			if (currentTurn === capture) currentTurn = undefined;
		}
	};

	const discordConfig = scopedConfig.platforms.discord;
	if (!discordConfig) throw new Error("Live Discord configuration unavailable");
	const adapterFactory = dependencies.createAdapter ?? createDiscordAdapter;
	const gatewayFactory = dependencies.createGateway ?? createMessengerGateway;
	const adapter = adapterFactory(discordConfig, dependencies.env, dependencies.transport);
	const guardedAdapter: MessengerAdapter = {
		...adapter,
		send: async (message, text, signal) => {
			if (closed || !sameSession(ctx, attachedSession, sessionId, sessionFile)) {
				throw new Error(LIVE_UNAVAILABLE_MESSAGE);
			}
			const sendSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
			if (sendSignal.aborted || !sameSession(ctx, attachedSession, sessionId, sessionFile)) {
				throw new Error(LIVE_UNAVAILABLE_MESSAGE);
			}
			await adapter.send(message, text, sendSignal);
		},
	};
	const gateway = gatewayFactory(scopedConfig, [guardedAdapter], reply);
	close = async (): Promise<void> => {
		if (closed) {
			await runPromise?.catch(() => {});
			return;
		}
		closed = true;
		clearInterval(pollTimer);
		lifetime.abort();
		const turn = currentTurn;
		if (turn && sameSession(ctx, attachedSession, sessionId, sessionFile)) {
			if (turn.dispatched && !turn.hostSettled && !turn.conflicted) {
				try {
					await awaitHostAbort(attachedSession.abort({ reason: "Discord live bridge revoked" }));
				} catch {
					try {
						ctx.showWarning("Discord live turn could not be interrupted; press Esc to interrupt it.");
					} catch {}
				}
			} else if (!turn.hostSettled) {
				try {
					ctx.showWarning("A Discord-initiated turn is still running; press Esc to interrupt.");
				} catch {}
			}
		}
		await runPromise?.catch(() => {});
	};

	const run = (signal?: AbortSignal): Promise<void> => {
		if (runPromise) return runPromise;
		const effectiveSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
		runPromise = gateway
			.run(effectiveSignal)
			.then(() => {
				if (ctx.liveDiscordBridge !== bridgeRef) return;
				ctx.liveDiscordBridge = undefined;
				if (!sameSession(ctx, attachedSession, sessionId, sessionFile)) {
					ctx.showStatus("Discord live bridge detached: session changed");
				}
			})
			.finally(() => {
				closed = true;
				clearInterval(pollTimer);
			});
		return runPromise;
	};

	const pollInterval = Math.max(50, Math.trunc(dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
	pollTimer = setInterval(() => {
		if (!closed && !sameSession(ctx, attachedSession, sessionId, sessionFile)) void close().catch(() => {});
	}, pollInterval);
	pollTimer.unref?.();

	const bridge: LiveDiscordBridge = {
		gateway,
		get active() {
			return !closed;
		},
		run,
		close,
	};
	bridgeRef = bridge;
	return bridge;
}

export async function loadAndCreateLiveDiscordBridge(
	ctx: InteractiveModeContext,
	configPath: string,
	dependencies: LiveDiscordBridgeDependencies = {},
	options: LiveDiscordBridgeOptions = {},
): Promise<LiveDiscordBridge> {
	const config = await loadMessengerConfig(configPath);
	return createLiveDiscordBridge(ctx, config, dependencies, options);
}
