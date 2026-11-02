import { expect, test } from "bun:test";
import { createDiscordAdapter } from "jeopi-cli/messenger/discord";
import type { MessengerMessage, MessengerPlatformConfig } from "jeopi-cli/messenger/types";

const platform: MessengerPlatformConfig = { tokenEnv: "TEST_TOKEN", allowedUserIds: ["human"] };
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

test("removes a processing reaction that completes after cancellation and success", async () => {
	const started = Promise.withResolvers<void>();
	const finishProcessing = Promise.withResolvers<void>();
	const reactions = new Set<string>();
	const requests: string[] = [];
	const fetchImpl: typeof fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
			const path = new URL(request.url).pathname;
			const emoji = decodeURIComponent(path.split("/").at(-2)!);
			if (request.method === "PUT" && emoji === "⏳") {
				started.resolve();
				await finishProcessing.promise; // Discord may complete a request even after its signal is aborted.
			}
			requests.push(`${request.method} ${emoji}`);
			if (request.method === "PUT") reactions.add(emoji);
			if (request.method === "DELETE") reactions.delete(emoji);
			return new Response(null, { status: 204 });
		},
		{ preconnect: fetch.preconnect },
	);
	const adapter = createDiscordAdapter(platform, { TEST_TOKEN: "token" }, { fetch: fetchImpl });
	const controller = new AbortController();
	const processing = adapter.status!(message, "processing", controller.signal).catch(() => {});
	await started.promise;
	controller.abort();
	await adapter.status!(message, "success");
	finishProcessing.resolve();
	await processing;

	expect(requests).toEqual(["DELETE ⏳", "PUT ✅", "PUT ⏳", "DELETE ⏳"]);
	expect([...reactions]).toEqual(["✅"]);
});
