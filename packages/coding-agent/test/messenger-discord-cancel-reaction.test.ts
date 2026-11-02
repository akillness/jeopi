import { describe, expect, test } from "bun:test";
import { createDiscordAdapter } from "jeopi-cli/messenger/discord";
import { createMessengerGateway } from "jeopi-cli/messenger/gateway";
import type { MessengerConfig, MessengerMessage, MessengerPlatformConfig } from "jeopi-cli/messenger/types";

const platform: MessengerPlatformConfig = { tokenEnv: "TEST_TOKEN", allowedUserIds: ["human"] };
const config: MessengerConfig = { cwd: "/tmp", sessionDir: "/tmp", toolNames: [], platforms: { discord: platform } };
const message: MessengerMessage = {
	platform: "discord",
	accountId: "bot",
	channelId: "123",
	senderId: "human",
	messageId: "456",
	text: "hello",
	direct: true,
	mentioned: false,
};

describe("Discord cancelled request", () => {
	test("removes an already-created processing reaction without a terminal reaction", async () => {
		const requests: string[] = [];
		const processingComplete = Promise.withResolvers<void>();
		const turnStarted = Promise.withResolvers<void>();
		const finishTurn = Promise.withResolvers<void>();
		const fetchImpl: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
				requests.push(`${request.method} ${decodeURIComponent(new URL(request.url).pathname)}`);
				return new Response(null, { status: 204 });
			},
			{ preconnect: fetch.preconnect },
		);
		const adapter = createDiscordAdapter(platform, { TEST_TOKEN: "token" }, { fetch: fetchImpl });
		const discordStatus = adapter.status!;
		adapter.status = async (destination, state, signal) => {
			await discordStatus(destination, state, signal);
			if (state === "processing") processingComplete.resolve();
		};
		const gateway = createMessengerGateway(config, [adapter], async () => {
			turnStarted.resolve();
			await finishTurn.promise;
			return "done";
		});
		const controller = new AbortController();
		const handling = gateway.handle(message, controller.signal);
		await Promise.all([processingComplete.promise, turnStarted.promise]);
		expect(requests).toEqual(["PUT /api/v10/channels/123/messages/456/reactions/⏳/@me"]);

		controller.abort();
		finishTurn.resolve();
		await handling;

		expect(requests).toEqual([
			"PUT /api/v10/channels/123/messages/456/reactions/⏳/@me",
			"DELETE /api/v10/channels/123/messages/456/reactions/⏳/@me",
		]);
	});
});
