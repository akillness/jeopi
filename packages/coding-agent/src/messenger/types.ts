export type MessengerPlatform = "discord" | "telegram" | "slack";

export interface MessengerMessage {
	platform: MessengerPlatform;
	accountId: string;
	channelId: string;
	senderId: string;
	messageId: string;
	text: string;
	threadId?: string;
	direct: boolean;
	mentioned: boolean;
}

export interface MessengerAdapter {
	platform: MessengerPlatform;
	start(onMessage: (message: MessengerMessage) => Promise<void>, signal: AbortSignal): Promise<void>;
	send(message: MessengerMessage, text: string, signal?: AbortSignal): Promise<void>;
}

export interface MessengerPlatformConfig {
	tokenEnv: string;
	appTokenEnv?: string;
	allowedUserIds: string[];
	allowedChannelIds?: string[];
}

export interface MessengerConfig {
	cwd: string;
	sessionDir: string;
	toolNames: string[];
	platforms: Partial<Record<MessengerPlatform, MessengerPlatformConfig>>;
}

export interface MessengerTransportDeps {
	fetch?: typeof fetch;
	WebSocket?: typeof WebSocket;
}

export type MessengerReply = (message: MessengerMessage, signal: AbortSignal) => Promise<string>;
/** A partially initialized SDK must not be retried inside a live gateway. */
export class MessengerFatalError extends Error {
	constructor() {
		super("Messenger session initialization failed; restart required");
		this.name = "MessengerFatalError";
	}
}
