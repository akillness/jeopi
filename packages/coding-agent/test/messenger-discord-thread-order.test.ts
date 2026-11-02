import { describe, expect, test } from "bun:test";
import { createMessengerGateway } from "../src/messenger/gateway";
import type { MessengerAdapter, MessengerConfig, MessengerMessage } from "../src/messenger/types";

describe("Discord thread ordering", () => {
	test("keeps a follow-up behind delayed thread creation while another thread proceeds", async () => {
		const config: MessengerConfig = {
			cwd: "/tmp",
			sessionDir: "/tmp",
			toolNames: [],
			platforms: { discord: { tokenEnv: "TEST_TOKEN", allowedUserIds: ["alice"] } },
		};
		const original: MessengerMessage = {
			platform: "discord",
			accountId: "account",
			channelId: "parent",
			senderId: "alice",
			messageId: "original",
			text: "First question",
			direct: false,
			mentioned: true,
		};
		const followup: MessengerMessage = {
			...original,
			channelId: "original",
			parentChannelId: "parent",
			threadId: "original",
			messageId: "followup",
			text: "Second question",
			mentioned: false,
		};
		const unrelated: MessengerMessage = {
			...followup,
			channelId: "other-thread",
			threadId: "other-thread",
			messageId: "other",
		};
		const prepareEntered = Promise.withResolvers<void>();
		const releasePrepare = Promise.withResolvers<void>();
		const events: string[] = [];
		const adapter: MessengerAdapter = {
			platform: "discord",
			async start() {},
			async prepare(message) {
				if (message.messageId !== "original") return message;
				prepareEntered.resolve();
				await releasePrepare.promise;
				return {
					...message,
					channelId: message.messageId,
					parentChannelId: message.channelId,
					threadId: message.messageId,
				};
			},
			async send(message, text) {
				events.push(`sent:${message.messageId}:${text}`);
			},
		};
		const gateway = createMessengerGateway(
			config,
			[adapter],
			async message => {
				events.push(`reply:${message.messageId}`);
				return `answer ${message.messageId}`;
			},
			{ concurrency: 2 },
		);

		const first = gateway.handle(original);
		await prepareEntered.promise;
		const second = gateway.handle(followup);
		const other = gateway.handle(unrelated);
		try {
			await other;
			expect(events).toEqual(["reply:other", "sent:other:answer other"]);
		} finally {
			releasePrepare.resolve();
		}
		await Promise.all([first, second]);
		expect(events).toEqual([
			"reply:other",
			"sent:other:answer other",
			"reply:original",
			"sent:original:answer original",
			"reply:followup",
			"sent:followup:answer followup",
		]);
	});
});
