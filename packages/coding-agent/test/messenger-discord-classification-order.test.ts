import { describe, expect, test } from "bun:test";
import { createDiscordAdapter, type DiscordClock } from "jeopi-cli/messenger/discord";
import type { MessengerMessage, MessengerPlatformConfig } from "jeopi-cli/messenger/types";

describe("Discord adapter classification ordering", () => {
	test("forwards a parent before its thread follow-up when the parent lookup is delayed", async () => {
		const opened = Promise.withResolvers<FixtureSocket>();
		const parentLookup = Promise.withResolvers<void>();
		const releaseParent = Promise.withResolvers<void>();
		const markerReceived = Promise.withResolvers<void>();
		const bothReceived = Promise.withResolvers<void>();
		const received: MessengerMessage[] = [];

		class FixtureSocket extends EventTarget {
			constructor(_url: string | URL) {
				super();
				opened.resolve(this);
			}
			send(_data: string) {}
			close() {}
			packet(packet: unknown) {
				this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) }));
			}
		}
		const clock: DiscordClock = { random: () => 0, schedule: () => () => {} };
		const fetchImpl = Object.assign(
			async (input: string | URL | Request) => {
				const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
				if (path.endsWith("/users/@me")) return Response.json({ id: "bot", bot: true });
				if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
				if (path.endsWith("/channels/parent")) {
					parentLookup.resolve();
					await releaseParent.promise;
					return Response.json({ type: 0 });
				}
				if (path.endsWith("/channels/original")) {
					return Response.json({ type: 11, parent_id: "parent", owner_id: "bot" });
				}
				throw new Error(`Unexpected Discord request: ${path}`);
			},
			{ preconnect: fetch.preconnect },
		);
		const config: MessengerPlatformConfig = { tokenEnv: "TEST_TOKEN", allowedUserIds: ["human"] };
		const adapter = createDiscordAdapter(
			config,
			{ TEST_TOKEN: "token" },
			{
				fetch: fetchImpl,
				WebSocket: FixtureSocket as unknown as typeof WebSocket,
				clock,
			},
		);
		const controller = new AbortController();
		const run = adapter.start(async message => {
			if (message.messageId === "marker") markerReceived.resolve();
			else {
				received.push(message);
				if (received.length === 2) bothReceived.resolve();
			}
		}, controller.signal);
		try {
			const socket = await opened.promise;
			socket.packet({ op: 10, d: { heartbeat_interval: 60_000 } });
			socket.packet({
				op: 0,
				t: "READY",
				s: 1,
				d: { session_id: "s", resume_gateway_url: "wss://gateway.discord.gg" },
			});
			const base = { guild_id: "guild", author: { id: "human" }, mentions: [{ id: "bot" }] };
			socket.packet({
				op: 0,
				t: "MESSAGE_CREATE",
				s: 2,
				d: { ...base, id: "original", channel_id: "parent", content: "first" },
			});
			await parentLookup.promise;
			socket.packet({
				op: 0,
				t: "MESSAGE_CREATE",
				s: 3,
				d: { ...base, id: "followup", channel_id: "original", content: "second" },
			});
			socket.packet({
				op: 0,
				t: "MESSAGE_CREATE",
				s: 4,
				d: { id: "marker", channel_id: "dm", author: { id: "human" }, content: "barrier" },
			});
			await markerReceived.promise;
			await new Promise<void>(resolve => setImmediate(resolve));
			releaseParent.resolve();
			await bothReceived.promise;
			expect(received.map(message => message.messageId)).toEqual(["original", "followup"]);
			expect(received[1]?.threadId).toBe("original");
			expect(received[1]?.parentChannelId).toBe("parent");
		} finally {
			releaseParent.resolve();
			controller.abort();
			await run;
		}
	});
});
