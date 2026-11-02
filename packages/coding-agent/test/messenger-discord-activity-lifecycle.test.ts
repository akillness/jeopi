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

describe("Discord activity lifecycle", () => {
	test("a permanently rejected cleanup does not retain the status for later activity", async () => {
		const requests: string[] = [];
		const posted = Promise.withResolvers<void>();
		let posts = 0;
		const fetchImpl: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
				const path = new URL(request.url).pathname;
				if (path.includes("/reactions/")) return new Response(null, { status: 204 });
				if (request.method === "POST") {
					const body = (await request.json()) as { content: string; flags?: number };
					if (body.flags === undefined) return Response.json({ id: "reply" });
					requests.push(`POST ${body.content}`);
					posted.resolve();
					return Response.json({ id: `status-${++posts}` });
				}
				requests.push(`${request.method} ${path}`);
				if (request.method === "DELETE") return Response.json({ retry_after: 4 }, { status: 429 });
				return Response.json({ id: "status-1" });
			},
			{ preconnect: fetch.preconnect },
		);
		const adapter = createDiscordAdapter(platform, { TEST_TOKEN: "token" }, { fetch: fetchImpl });
		const gateway = createMessengerGateway(
			config,
			[adapter],
			async (_message, _signal, report) => {
				report?.("working");
				await posted.promise;
				return "done";
			},
			{ activityIntervalMs: 0 },
		);
		await gateway.handle(message);
		await adapter.activity!(message, "new work");
		expect(requests).toEqual([
			"POST ⏳ working",
			"DELETE /api/v10/channels/123/messages/status-1",
			"POST ⏳ new work",
		]);
	});

	test("a POST completing after cancellation removes the late status rather than retaining it", async () => {
		const postStarted = Promise.withResolvers<void>();
		const postResponse = Promise.withResolvers<Response>();
		const requests: string[] = [];
		const fetchImpl: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
				requests.push(`${request.method} ${new URL(request.url).pathname}`);
				if (request.method === "POST") {
					postStarted.resolve();
					return postResponse.promise;
				}
				return new Response(null, { status: 204 });
			},
			{ preconnect: fetch.preconnect },
		);
		const adapter = createDiscordAdapter(platform, { TEST_TOKEN: "token" }, { fetch: fetchImpl });
		const controller = new AbortController();
		const creating = adapter.activity!(message, "working", controller.signal).catch(() => {});
		await postStarted.promise;
		controller.abort();
		await adapter.activity!(message, undefined);
		postResponse.resolve(Response.json({ id: "late-status" }));
		await creating;
		expect(requests).toEqual([
			"POST /api/v10/channels/123/messages",
			"DELETE /api/v10/channels/123/messages/late-status",
		]);
		await adapter.activity!(message, undefined);
		expect(requests).toEqual([
			"POST /api/v10/channels/123/messages",
			"DELETE /api/v10/channels/123/messages/late-status",
		]);
	});
});
