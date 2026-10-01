import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createDiscordAdapter, type DiscordClock } from "jeopi-cli/messenger/discord";
import { createSlackAdapter } from "jeopi-cli/messenger/slack";
import { createTelegramAdapter } from "jeopi-cli/messenger/telegram";
import type {
	MessengerAdapter,
	MessengerMessage,
	MessengerPlatformConfig,
	MessengerTransportDeps,
} from "jeopi-cli/messenger/types";
import { isRecord } from "jeopi-utils";

const config: MessengerPlatformConfig = {
	tokenEnv: "TEST_BOT_TOKEN",
	appTokenEnv: "TEST_APP_TOKEN",
	allowedUserIds: ["human"],
};
const env = { TEST_BOT_TOKEN: "xoxb-fixture-secret-bot", TEST_APP_TOKEN: "xapp-fixture-secret-app" };
let transportDeps: MessengerTransportDeps = {};
const controllers: AbortController[] = [];
const runs: Promise<unknown>[] = [];
const servers: Bun.Server<undefined>[] = [];
let restoreFetch: (() => void) | undefined;
let escapedRequests: number;

beforeEach(() => {
	escapedRequests = 0;
	const blockedFetch = Object.assign(
		async () => {
			escapedRequests++;
			throw new Error("Test attempted an uninjected network request");
		},
		{ preconnect: fetch.preconnect },
	);
	const spy = spyOn(globalThis, "fetch").mockImplementation(blockedFetch);
	restoreFetch = () => spy.mockRestore();
});

function interceptFetch(handler: (request: Request) => Response | Promise<Response>): void {
	transportDeps.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
			return handler(request);
		},
		{ preconnect: fetch.preconnect },
	);
}

async function payload(request: Request): Promise<Record<string, unknown>> {
	const value: unknown = await request.json();
	if (!isRecord(value)) throw new Error("Expected a JSON object request");
	return value;
}

function mailbox<T>() {
	const values: T[] = [];
	const waiters: ((value: T) => void)[] = [];
	return {
		push(value: T) {
			const waiter = waiters.shift();
			if (waiter) waiter(value);
			else values.push(value);
		},
		next(): Promise<T> {
			if (values.length) return Promise.resolve(values.shift()!);
			const pending = Promise.withResolvers<T>();
			waiters.push(pending.resolve);
			return pending.promise;
		},
	};
}

function socketFixture(hello: unknown, acknowledgeHeartbeats = true) {
	const opened = Promise.withResolvers<Bun.ServerWebSocket<undefined>>();
	const closed = Promise.withResolvers<number>();
	const packets = mailbox<Record<string, unknown>>();
	const connections = mailbox<Bun.ServerWebSocket<undefined>>();
	const closes = mailbox<number>();
	const urls: string[] = [];
	const server = Bun.serve<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("WebSocket required", { status: 400 });
		},
		websocket: {
			open(socket) {
				opened.resolve(socket);
				connections.push(socket);
				socket.send(JSON.stringify(hello));
			},
			message(socket, data) {
				const packet = JSON.parse(String(data));
				packets.push(packet);
				if (acknowledgeHeartbeats && packet.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
			},
			close(_socket, code) {
				closed.resolve(code);
				closes.push(code);
			},
		},
	});
	servers.push(server);
	const NativeWebSocket = globalThis.WebSocket;
	transportDeps.WebSocket = class extends NativeWebSocket {
		constructor(_url: string | URL, _options?: string | string[] | Bun.WebSocketOptions) {
			super(`ws://127.0.0.1:${server.port}`);
			urls.push(String(_url));
		}
	};
	return { opened: opened.promise, closed: closed.promise, packets, connections, closes, urls };
}

function abortableRequest(request: Request, aborted: () => void): Promise<Response> {
	const pending = Promise.withResolvers<Response>();
	const abort = () => {
		aborted();
		pending.reject(new DOMException("Cancelled", "AbortError"));
	};
	if (request.signal.aborted) abort();
	else request.signal.addEventListener("abort", abort, { once: true });
	return pending.promise;
}

function message(platform: MessengerMessage["platform"]): MessengerMessage {
	return {
		platform,
		accountId: "account",
		channelId: "123",
		senderId: "human",
		messageId: "456",
		threadId: "789",
		direct: false,
		mentioned: true,
		text: "question",
	};
}

function start(adapter: MessengerAdapter, receive: (message: MessengerMessage) => Promise<void>) {
	const controller = new AbortController();
	controllers.push(controller);
	const run = adapter.start(receive, controller.signal);
	runs.push(run);
	void run.catch(() => {});
	return { controller, run };
}

afterEach(async () => {
	for (const controller of controllers.splice(0)) controller.abort();
	for (const server of servers.splice(0)) server.stop(true);
	await Promise.allSettled(runs.splice(0));
	transportDeps = {};
	restoreFetch?.();
	expect(escapedRequests).toBe(0);
});

describe("messenger transport authentication", () => {
	for (const [platform, create] of [
		["telegram", createTelegramAdapter],
		["discord", createDiscordAdapter],
		["slack", createSlackAdapter],
	] as const) {
		it(`${platform} rejects invalid credentials without retrying or exposing secrets`, async () => {
			const requests: string[] = [];
			interceptFetch(request => {
				requests.push(new URL(request.url).pathname);
				return Response.json(
					{ ok: false, error: "invalid_auth", description: env.TEST_BOT_TOKEN },
					{ status: 401 },
				);
			});
			const { run } = start(create(config, env, transportDeps), async () => {});
			const error = await run.then(
				() => undefined,
				failure => failure,
			);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).not.toContain(env.TEST_BOT_TOKEN);
			expect(String(error)).not.toContain(env.TEST_APP_TOKEN);
			expect(requests).toHaveLength(1);
		});
	}
});

// Fixtures follow core.telegram.org/bots/api#update and #messageentity.
describe("Telegram transport", () => {
	it("advances polling past ignored updates, preserves topics and cancels an outstanding poll", async () => {
		const polling = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const requests: Record<string, unknown>[] = [];
		const received: MessengerMessage[] = [];
		const human = { id: 7, is_bot: false, first_name: "Human" };
		const base = { message_id: 10, date: 1, chat: { id: -100, type: "supergroup" }, from: human };
		interceptFetch(async request => {
			if (request.url.endsWith("/getMe"))
				return Response.json({
					ok: true,
					result: { id: 42, is_bot: true, username: "TestBot", first_name: "Test" },
				});
			expect(new URL(request.url).pathname.endsWith("/getUpdates")).toBe(true);
			requests.push(await payload(request));
			if (requests.length === 1)
				return Response.json({
					ok: true,
					result: [
						{
							update_id: 20,
							message: {
								...base,
								text: "@TestBot topic",
								message_thread_id: 90,
								entities: [{ type: "mention", offset: 0, length: 8 }],
							},
						},
						{
							update_id: 21,
							message: { ...base, message_id: 11, text: "private", chat: { id: 7, type: "private" } },
						},
						{
							update_id: 22,
							message: { ...base, message_id: 12, text: "@TestBot bot", from: { ...human, is_bot: true } },
						},
						{ update_id: 23, edited_message: { ...base, text: "@TestBot edited" } },
					],
				});
			polling.resolve();
			return abortableRequest(request, aborted.resolve);
		});
		const { controller, run } = start(createTelegramAdapter(config, env, transportDeps), async value => {
			received.push(value);
		});
		await polling.promise;
		expect(requests[1]?.offset).toBe(24);
		expect(Number(requests[0]?.timeout)).toBeGreaterThan(0);
		expect(
			received.map(value => ({
				id: value.messageId,
				account: value.accountId,
				channel: value.channelId,
				sender: value.senderId,
				thread: value.threadId,
				direct: value.direct,
				mentioned: value.mentioned,
			})),
		).toEqual([
			{ id: "10", account: "42", channel: "-100", sender: "7", thread: "90", direct: false, mentioned: true },
			{ id: "11", account: "42", channel: "7", sender: "7", thread: undefined, direct: true, mentioned: false },
		]);
		controller.abort();
		await aborted.promise;
		await run;
		expect(requests).toHaveLength(2);
	});

	it("matches mention entities by UTF16 offsets and rejects username substrings", async () => {
		const drained = Promise.withResolvers<void>();
		const received: MessengerMessage[] = [];
		const cases = [
			{ text: "\u{1F680} @tEsTbOt hello", entities: [{ type: "mention", offset: 3, length: 8 }], mentioned: true },
			{ text: "@TestBotOther hello", entities: [{ type: "mention", offset: 0, length: 13 }], mentioned: false },
			{ text: "mail@TestBot.example", mentioned: false },
			{ text: "@OtherBot hello", entities: [{ type: "mention", offset: 0, length: 9 }], mentioned: false },
			{
				text: "Test hello",
				entities: [
					{ type: "text_mention", offset: 0, length: 4, user: { id: 42, is_bot: true, first_name: "Test" } },
				],
				mentioned: true,
			},
		];
		let polled = false;
		interceptFetch(request => {
			if (request.url.endsWith("/getMe"))
				return Response.json({ ok: true, result: { id: 42, is_bot: true, username: "TestBot" } });
			if (polled) {
				drained.resolve();
				return abortableRequest(request, () => {});
			}
			polled = true;
			return Response.json({
				ok: true,
				result: cases.map((value, index) => ({
					update_id: index + 1,
					message: {
						message_id: index + 1,
						date: 1,
						from: { id: 7, is_bot: false },
						chat: { id: -100, type: "supergroup" },
						text: value.text,
						entities: value.entities,
					},
				})),
			});
		});
		const { controller, run } = start(createTelegramAdapter(config, env, transportDeps), async value => {
			received.push(value);
		});
		await drained.promise;
		expect(received.map(value => value.mentioned)).toEqual(cases.map(value => value.mentioned));
		expect(received.map(value => value.text)).toEqual([
			"\u{1F680}  hello",
			"@TestBotOther hello",
			"mail@TestBot.example",
			"@OtherBot hello",
			"hello",
		]);
		controller.abort();
		await run;
	});
});

describe("messenger outbound payloads", () => {
	for (const [platform, create, limit] of [
		["telegram", createTelegramAdapter, 4096],
		["discord", createDiscordAdapter, 2000],
		["slack", createSlackAdapter, 4000],
	] as const) {
		it(`${platform} delivers all text in bounded chunks without losing routing or enabling rich mentions`, async () => {
			const sent: { url: URL; body: Record<string, unknown> }[] = [];
			interceptFetch(async request => {
				sent.push({ url: new URL(request.url), body: await payload(request) });
				return Response.json({ ok: true, result: { message_id: 1 }, id: "sent", ts: "1.0" });
			});
			const text = `${"a".repeat(limit - 1)}\u{1F680}<@123> *literal* & text`;
			await create(config, env, transportDeps).send(message(platform), text);
			const key = platform === "discord" ? "content" : "text";
			const chunks = sent.map(value => String(value.body[key]));
			expect(chunks.join("")).toBe(text);
			expect(chunks).toHaveLength(2);
			for (const chunk of chunks) {
				expect(chunk.length).toBeLessThanOrEqual(limit);
				expect(chunk.isWellFormed()).toBe(true);
			}
			for (const { url, body } of sent) {
				if (platform === "telegram") {
					expect(url.pathname).toEndWith("/sendMessage");
					expect(String(body.chat_id)).toBe("123");
					expect(String(body.message_thread_id)).toBe("789");
					expect(body.parse_mode).toBeUndefined();
				} else if (platform === "discord") {
					expect(url.pathname).toEndWith("/channels/123/messages");
					expect(body.allowed_mentions).toMatchObject({ parse: [], replied_user: false });
				} else {
					expect(url.pathname).toBe("/api/chat.postMessage");
					expect(body).toMatchObject({
						channel: "123",
						thread_ts: "789",
						mrkdwn: false,
						unfurl_links: false,
						unfurl_media: false,
					});
				}
			}
			if (platform === "discord")
				expect(sent[0]?.body.message_reference).toMatchObject({ message_id: "456", fail_if_not_exists: false });
		});
	}
});

// Discord opcodes/payloads: docs.discord.com/developers/events/gateway-events.
describe("Discord Gateway transport", () => {
	function discordNetwork() {
		interceptFetch(request => {
			const path = new URL(request.url).pathname;
			if (path.endsWith("/users/@me")) return Response.json({ id: "42", bot: true, username: "TestBot" });
			if (path.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.discord.gg" });
			throw new Error("Unexpected Discord fixture endpoint");
		});
		return socketFixture({ op: 10, d: { heartbeat_interval: 60_000 } });
	}

	it("identifies for required message intents, filters nonhuman events, strips only own mentions and heartbeats latest sequence", async () => {
		const fixture = discordNetwork();
		const received: MessengerMessage[] = [];
		const sentinel = Promise.withResolvers<void>();
		const { controller, run } = start(createDiscordAdapter(config, env, transportDeps), async value => {
			received.push(value);
			if (value.messageId === "last") sentinel.resolve();
		});
		const socket = await fixture.opened;
		let identify = await fixture.packets.next();
		while (identify.op !== 2) identify = await fixture.packets.next();
		expect(identify).toMatchObject({ op: 2, d: { token: env.TEST_BOT_TOKEN, intents: 512 | 4096 | 32768 } });
		socket.send(
			JSON.stringify({
				op: 0,
				t: "READY",
				s: 1,
				d: { user: { id: "42" }, session_id: "fixture-session", resume_gateway_url: "wss://gateway.discord.gg" },
			}),
		);
		const base = {
			id: "first",
			channel_id: "thread-channel",
			guild_id: "guild",
			author: { id: "7", bot: false },
			content: "<@42> ask <@99>",
			mentions: [{ id: "42" }, { id: "99" }],
		};
		for (const [index, data] of [
			base,
			{ ...base, id: "bot", author: { id: "8", bot: true } },
			{ ...base, id: "webhook", webhook_id: "hook" },
			{ ...base, id: "other", content: "ask <@99>", mentions: [{ id: "99" }] },
			{ ...base, id: "last", guild_id: undefined, channel_id: "dm-channel", content: "private", mentions: [] },
		].entries())
			socket.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: index + 2, d: data }));
		await sentinel.promise;
		expect(
			received.map(value => ({
				id: value.messageId,
				channel: value.channelId,
				text: value.text,
				mentioned: value.mentioned,
				direct: value.direct,
				account: value.accountId,
				sender: value.senderId,
			})),
		).toEqual([
			{
				id: "first",
				channel: "thread-channel",
				text: "ask <@99>",
				mentioned: true,
				direct: false,
				account: "42",
				sender: "7",
			},
			{
				id: "other",
				channel: "thread-channel",
				text: "ask <@99>",
				mentioned: false,
				direct: false,
				account: "42",
				sender: "7",
			},
			{
				id: "last",
				channel: "dm-channel",
				text: "private",
				mentioned: false,
				direct: true,
				account: "42",
				sender: "7",
			},
		]);
		socket.send(JSON.stringify({ op: 1, d: null }));
		let heartbeat = await fixture.packets.next();
		while (heartbeat.op !== 1 || heartbeat.d !== 6) heartbeat = await fixture.packets.next();
		expect(heartbeat).toEqual({ op: 1, d: 6 });
		controller.abort();
		await fixture.closed;
		await run;
	});

	it("rejects a permanent Gateway authentication close instead of reconnecting", async () => {
		const fixture = discordNetwork();
		const { run } = start(createDiscordAdapter(config, env, transportDeps), async () => {});
		const socket = await fixture.opened;
		socket.close(4004, env.TEST_BOT_TOKEN);
		const error = await run.then(
			() => undefined,
			failure => failure,
		);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain(env.TEST_BOT_TOKEN);
	});
});

// Slack envelope and ACK contract: docs.slack.dev/apis/events-api/using-socket-mode/.
describe("Slack Socket Mode transport", () => {
	it("ACKs before blocked application work, deduplicates message/mention delivery and preserves channel and DM threads", async () => {
		interceptFetch(request => {
			const path = new URL(request.url).pathname;
			if (path === "/api/auth.test")
				return Response.json({ ok: true, team_id: "T1", user_id: "U42", bot_id: "B42" });
			if (path === "/api/apps.connections.open")
				return Response.json({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=fixture" });
			throw new Error("Unexpected Slack fixture endpoint");
		});
		const fixture = socketFixture({ type: "hello", connection_info: { app_id: "A1" } });
		const received: MessengerMessage[] = [];
		const blocked = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const sentinel = Promise.withResolvers<void>();
		const { controller, run } = start(createSlackAdapter(config, env, transportDeps), async value => {
			received.push(value);
			if (value.messageId === "1.0") {
				entered.resolve();
				await blocked.promise;
			}
			if (value.messageId === "9.0") sentinel.resolve();
		});
		const socket = await fixture.opened;
		const send = (id: string, event: Record<string, unknown>) =>
			socket.send(
				JSON.stringify({
					type: "events_api",
					envelope_id: id,
					accepts_response_payload: false,
					payload: { type: "event_callback", team_id: "T1", event_id: `event-${id}`, event },
				}),
			);
		const base = { type: "app_mention", user: "U7", channel: "C1", text: "<@U42> ask <@U99>", ts: "1.0" };
		send("envelope-1", base);
		await entered.promise;
		expect(await fixture.packets.next()).toMatchObject({ envelope_id: "envelope-1" });
		blocked.resolve();
		const events = [
			{ ...base, type: "message" },
			{ ...base, ts: "2.0", type: "message", bot_id: "B2" },
			{ ...base, ts: "3.0", type: "message", subtype: "message_changed" },
			{ ...base, ts: "4.0", type: "message", user: "U42" },
			{ ...base, ts: "5.0", thread_ts: "0.0", text: "<@U42> threaded" },
			{ ...base, ts: "9.0", type: "message", channel: "D1", channel_type: "im", thread_ts: "8.0", text: "private" },
		];
		for (const [index, event] of events.entries()) send(`envelope-${index + 2}`, event);
		for (let index = 0; index < events.length; index++)
			expect(await fixture.packets.next()).toMatchObject({ envelope_id: `envelope-${index + 2}` });
		await sentinel.promise;
		expect(
			received.map(value => ({
				id: value.messageId,
				account: value.accountId,
				channel: value.channelId,
				thread: value.threadId,
				sender: value.senderId,
				text: value.text,
				direct: value.direct,
				mentioned: value.mentioned,
			})),
		).toEqual([
			{
				id: "1.0",
				account: "T1",
				channel: "C1",
				thread: "1.0",
				sender: "U7",
				text: "ask <@U99>",
				direct: false,
				mentioned: true,
			},
			{
				id: "5.0",
				account: "T1",
				channel: "C1",
				thread: "0.0",
				sender: "U7",
				text: "threaded",
				direct: false,
				mentioned: true,
			},
			{
				id: "9.0",
				account: "T1",
				channel: "D1",
				thread: "8.0",
				sender: "U7",
				text: "private",
				direct: true,
				mentioned: false,
			},
		]);
		controller.abort();
		await fixture.closed;
		await run;
	});

	it("rejects Slack ok:false authentication responses even with HTTP 200", async () => {
		let requests = 0;
		interceptFetch(() => {
			requests++;
			return Response.json({ ok: false, error: "invalid_auth", detail: env.TEST_APP_TOKEN });
		});
		const { run } = start(createSlackAdapter(config, env, transportDeps), async () => {});
		const error = await run.then(
			() => undefined,
			failure => failure,
		);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain(env.TEST_APP_TOKEN);
		expect(requests).toBe(1);
	});
});

describe("messenger send failures", () => {
	for (const [platform, create] of [
		["telegram", createTelegramAdapter],
		["discord", createDiscordAdapter],
		["slack", createSlackAdapter],
	] as const) {
		it(`${platform} surfaces delivery failure without retrying a potentially delivered chunk`, async () => {
			let requests = 0;
			interceptFetch(() => {
				requests++;
				return Response.json({ error: env.TEST_BOT_TOKEN, ok: false }, { status: 503 });
			});
			const failure = await create(config, env, transportDeps)
				.send(message(platform), "answer")
				.then(
					() => undefined,
					error => error,
				);
			expect(failure).toBeInstanceOf(Error);
			expect(String(failure)).not.toContain(env.TEST_BOT_TOKEN);
			expect(requests).toBe(1);
		});

		it(`${platform} aborts an in-flight delivery and does not send subsequent chunks`, async () => {
			const entered = Promise.withResolvers<void>();
			const aborted = Promise.withResolvers<void>();
			const controller = new AbortController();
			controllers.push(controller);
			let requests = 0;
			interceptFetch(request => {
				requests++;
				entered.resolve();
				return abortableRequest(request, aborted.resolve);
			});
			const sending = create(config, env, transportDeps).send(
				message(platform),
				"a".repeat(9000),
				controller.signal,
			);
			const failure = sending.then(
				() => undefined,
				error => error,
			);
			await entered.promise;
			controller.abort();
			await aborted.promise;
			expect(await failure).toBeInstanceOf(Error);
			expect(requests).toBe(1);
		});
	}
});

describe("messenger discovery trust", () => {
	for (const [platform, create] of [
		["discord", createDiscordAdapter],
		["slack", createSlackAdapter],
	] as const) {
		for (const url of [
			"ws://gateway.discord.gg/",
			"wss://attacker.invalid/",
			"wss://fixture-secret@wss-primary.slack.com/",
		]) {
			it(`${platform} rejects untrusted discovery ${url} before sending credentials to a socket`, async () => {
				interceptFetch(request => {
					const path = new URL(request.url).pathname;
					if (path.endsWith("/users/@me")) return Response.json({ id: "42", bot: true });
					if (path.endsWith("/auth.test")) return Response.json({ ok: true, team_id: "T1", user_id: "U42" });
					return Response.json({ ok: true, url });
				});
				let connections = 0;
				transportDeps.WebSocket = class extends WebSocket {
					constructor() {
						connections++;
						super("invalid:fixture");
					}
				};
				const { run } = start(create(config, env, transportDeps), async () => {});
				const failure = await run.then(
					() => undefined,
					error => error,
				);
				expect(failure).toBeInstanceOf(Error);
				expect(String(failure)).not.toContain("fixture-secret");
				expect(connections).toBe(0);
			});
		}
	}
});

describe("Telegram polling cursor safety", () => {
	for (const updateId of [undefined, 1.5, Number.MAX_SAFE_INTEGER]) {
		it(`rejects an unusable update cursor ${String(updateId)} instead of polling it again`, async () => {
			const controller = new AbortController();
			controllers.push(controller);
			let polls = 0;
			interceptFetch(request => {
				if (request.url.endsWith("/getMe"))
					return Response.json({ ok: true, result: { id: 42, is_bot: true, username: "TestBot" } });
				polls++;
				if (polls > 1) controller.abort();
				return Response.json({ ok: true, result: [{ update_id: updateId }] });
			});
			const run = createTelegramAdapter(config, env, transportDeps).start(async () => {}, controller.signal);
			runs.push(run);
			const failure = await run.then(
				() => undefined,
				error => error,
			);
			expect(failure).toBeInstanceOf(Error);
			expect(polls).toBe(1);
		});
	}
});

describe("Telegram failure lifecycle", () => {
	function telegramUpdates(updates: unknown[]) {
		interceptFetch(request => {
			if (request.url.endsWith("/getMe"))
				return Response.json({ ok: true, result: { id: 42, is_bot: true, username: "TestBot" } });
			return Response.json({ ok: true, result: updates });
		});
	}

	it("continues after a rejected handler without replaying the failed message", async () => {
		telegramUpdates(
			[1, 2].map(id => ({
				update_id: id,
				message: {
					message_id: id,
					from: { id: 7, is_bot: false },
					chat: { id: 7, type: "private" },
					text: `message ${id}`,
				},
			})),
		);
		const controller = new AbortController();
		controllers.push(controller);
		const seen: string[] = [];
		const run = createTelegramAdapter(config, env, transportDeps).start(async value => {
			seen.push(value.text);
			if (value.messageId === "1") throw new Error("Fixture handler rejection");
			controller.abort();
		}, controller.signal);
		runs.push(run);
		await run;
		expect(seen).toEqual(["message 1", "message 2"]);
	});

	it("stops while an application callback is unresolved without delivering later updates", async () => {
		telegramUpdates(
			[1, 2].map(id => ({
				update_id: id,
				message: {
					message_id: id,
					from: { id: 7, is_bot: false },
					chat: { id: 7, type: "private" },
					text: `message ${id}`,
				},
			})),
		);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const seen: string[] = [];
		const { controller, run } = start(createTelegramAdapter(config, env, transportDeps), async value => {
			seen.push(value.text);
			entered.resolve();
			await release.promise;
		});
		try {
			await entered.promise;
			controller.abort();
			await run;
			expect(seen).toEqual(["message 1"]);
		} finally {
			release.resolve();
		}
	});

	it("rejects a conflicting polling consumer instead of retrying indefinitely", async () => {
		let polls = 0;
		interceptFetch(request => {
			if (request.url.endsWith("/getMe"))
				return Response.json({ ok: true, result: { id: 42, is_bot: true, username: "TestBot" } });
			polls++;
			return Response.json({ ok: false, error_code: 409, description: env.TEST_BOT_TOKEN }, { status: 409 });
		});
		const { run } = start(createTelegramAdapter(config, env, transportDeps), async () => {});
		const failure = await run.then(
			() => undefined,
			error => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).not.toContain(env.TEST_BOT_TOKEN);
		expect(polls).toBe(1);
	});

	for (const result of [null, {}]) {
		it(`does not report delivery success for an invalid sendMessage result ${JSON.stringify(result)}`, async () => {
			let requests = 0;
			interceptFetch(() => {
				requests++;
				return Response.json({ ok: true, result });
			});
			const failure = await createTelegramAdapter(config, env, transportDeps)
				.send(message("telegram"), "answer")
				.then(
					() => undefined,
					error => error,
				);
			expect(failure).toBeInstanceOf(Error);
			expect(requests).toBe(1);
		});
	}
});

it("Telegram authenticates a colon-delimited bot token without percent-encoding the token separator", async () => {
	const controller = new AbortController();
	controllers.push(controller);
	interceptFetch(request => {
		const path = new URL(request.url).pathname;
		if (path === "/bot123:fixture_token/getMe")
			return Response.json({ ok: true, result: { id: 123, is_bot: true, username: "TestBot" } });
		if (path === "/bot123:fixture_token/getUpdates")
			return Response.json({
				ok: true,
				result: [
					{
						update_id: 1,
						message: {
							message_id: 1,
							from: { id: 7, is_bot: false },
							chat: { id: 7, type: "private" },
							text: "routed",
						},
					},
				],
			});
		return Response.json({ ok: false, error_code: 401 }, { status: 401 });
	});
	const received: string[] = [];
	const run = createTelegramAdapter(config, { ...env, TEST_BOT_TOKEN: "123:fixture_token" }, transportDeps).start(
		async value => {
			received.push(value.text);
			controller.abort();
		},
		controller.signal,
	);
	runs.push(run);
	await run;
	expect(received).toEqual(["routed"]);
});

function controlledDiscordClock() {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	const scheduled = mailbox<{ id: number; delay: number }>();
	const clock: DiscordClock = {
		random: () => 0.5,
		schedule(callback, delay) {
			const id = nextId++;
			timers.set(id, { at: now + delay, callback });
			scheduled.push({ id, delay });
			return () => {
				timers.delete(id);
			};
		},
	};
	return {
		clock,
		async nextDelay() {
			const firstNewId = nextId;
			for (;;) {
				const timer = await scheduled.next();
				if (timer.id >= firstNewId && timers.has(timer.id)) return timer.delay;
			}
		},
		advance(duration: number) {
			const target = now + duration;
			for (;;) {
				const next = [...timers.entries()]
					.filter(([, timer]) => timer.at <= target)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				timers.delete(next[0]);
				now = next[1].at;
				next[1].callback();
			}
			now = target;
		},
		pending: () => timers.size,
	};
}

describe("Discord deterministic recovery", () => {
	function network() {
		interceptFetch(request => {
			if (new URL(request.url).pathname.endsWith("/users/@me")) return Response.json({ id: "42", bot: true });
			return Response.json({ url: "wss://gateway.discord.gg" });
		});
		return socketFixture({ op: 10, d: { heartbeat_interval: 100 } }, false);
	}

	it("keeps the scheduled cadence after requested heartbeats and reconnects only when a scheduled heartbeat lacks ACK", async () => {
		const fixture = network();
		const time = controlledDiscordClock();
		const { controller, run } = start(
			createDiscordAdapter(config, env, { ...transportDeps, clock: time.clock }),
			async () => {},
		);
		const socket = await fixture.connections.next();
		expect(await fixture.packets.next()).toMatchObject({ op: 2 });
		socket.send(
			JSON.stringify({
				op: 0,
				t: "READY",
				s: 10,
				d: { session_id: "fixture", resume_gateway_url: "wss://gateway.discord.gg" },
			}),
		);
		time.advance(50);
		const first = await fixture.packets.next();
		expect(first.op).toBe(1);
		socket.send(JSON.stringify({ op: 11, d: null }));
		socket.send(JSON.stringify({ op: 1, d: null }));
		expect(await fixture.packets.next()).toEqual({ op: 1, d: 10 });
		// The requested heartbeat remains unacknowledged. It must not reset the scheduled ACK watchdog.
		time.advance(100);
		expect(await Promise.race([fixture.packets.next(), fixture.closed.then(code => ({ closed: code }))])).toEqual({
			op: 1,
			d: 10,
		});
		const reconnectScheduled = time.nextDelay();
		time.advance(100);
		await fixture.closed;
		await reconnectScheduled;
		controller.abort();
		await run;
		expect(time.pending()).toBe(0);
	});

	it("falls back from a failed resume host to fresh identification and cancels reconnect timers on shutdown", async () => {
		const fixture = network();
		const time = controlledDiscordClock();
		const { controller, run } = start(
			createDiscordAdapter(config, env, { ...transportDeps, clock: time.clock }),
			async () => {},
		);
		const initial = await fixture.connections.next();
		expect(await fixture.packets.next()).toMatchObject({ op: 2 });
		initial.send(
			JSON.stringify({
				op: 0,
				t: "READY",
				s: 20,
				d: { session_id: "resume-session", resume_gateway_url: "wss://gateway-us-west.discord.gg" },
			}),
		);
		initial.send(JSON.stringify({ op: 1, d: null }));
		expect(await fixture.packets.next()).toEqual({ op: 1, d: 20 });
		const resumeScheduled = time.nextDelay();
		initial.close(4000);
		await fixture.closes.next();
		time.advance(await resumeScheduled);
		const resuming = await fixture.connections.next();
		expect(await fixture.packets.next()).toMatchObject({
			op: 6,
			d: { token: env.TEST_BOT_TOKEN, session_id: "resume-session", seq: 20 },
		});
		const identifyScheduled = time.nextDelay();
		resuming.close(4000);
		await fixture.closes.next();
		time.advance(await identifyScheduled);
		await fixture.connections.next();
		expect(await fixture.packets.next()).toMatchObject({ op: 2 });
		expect(fixture.urls.map(url => new URL(url).hostname)).toEqual([
			"gateway.discord.gg",
			"gateway-us-west.discord.gg",
			"gateway.discord.gg",
		]);
		controller.abort();
		await run;
		expect(time.pending()).toBe(0);
	});
});

describe("Slack workspace isolation and reconnect", () => {
	function network() {
		let ticket = 0;
		interceptFetch(request => {
			if (new URL(request.url).pathname.endsWith("/auth.test"))
				return Response.json({ ok: true, team_id: "T1", user_id: "U42" });
			return Response.json({ ok: true, url: `wss://wss-primary.slack.com/link/?ticket=${++ticket}` });
		});
		return socketFixture({ type: "hello" });
	}

	function envelope(id: string, event: Record<string, unknown>, team = "T1") {
		return JSON.stringify({
			type: "events_api",
			envelope_id: id,
			payload: { team_id: team, event_id: `event-${id}`, event },
		});
	}

	it("ACKs but rejects foreign workspace messages, preserves foreign mentions and leaves bare DMs unthreaded", async () => {
		const fixture = network();
		const received: MessengerMessage[] = [];
		const done = Promise.withResolvers<void>();
		const { controller, run } = start(createSlackAdapter(config, env, transportDeps), async value => {
			received.push(value);
			if (value.messageId === "3.0") done.resolve();
		});
		const socket = await fixture.opened;
		const base = { type: "message", user: "U7", channel: "C1", text: "<@U42> private workspace", ts: "1.0" };
		socket.send(envelope("foreign", base, "T2"));
		socket.send(envelope("other-mention", { ...base, text: "<@U99> only", ts: "2.0" }));
		socket.send(envelope("dm", { ...base, channel: "D1", channel_type: "im", text: "hello", ts: "3.0" }));
		for (const id of ["foreign", "other-mention", "dm"])
			expect(await fixture.packets.next()).toMatchObject({ envelope_id: id });
		await done.promise;
		expect(
			received.map(value => ({
				id: value.messageId,
				account: value.accountId,
				text: value.text,
				mentioned: value.mentioned,
				direct: value.direct,
				thread: value.threadId,
			})),
		).toEqual([
			{ id: "2.0", account: "T1", text: "<@U99> only", mentioned: false, direct: false, thread: "2.0" },
			{ id: "3.0", account: "T1", text: "hello", mentioned: false, direct: true, thread: undefined },
		]);
		controller.abort();
		await run;
	});

	it("refreshes the socket URL and retains message deduplication across reconnect", async () => {
		const fixture = network();
		const received = mailbox<MessengerMessage>();
		const seen: string[] = [];
		const { controller, run } = start(createSlackAdapter(config, env, transportDeps), async value => {
			seen.push(value.text);
			received.push(value);
		});
		const initial = await fixture.connections.next();
		const event = { type: "message", user: "U7", channel: "D1", text: "first", ts: "1.0" };
		initial.send(envelope("first-envelope", event));
		expect((await received.next()).text).toBe("first");
		expect(await fixture.packets.next()).toMatchObject({ envelope_id: "first-envelope" });
		initial.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
		const reconnected = await fixture.connections.next();
		reconnected.send(envelope("redelivery", event));
		reconnected.send(envelope("second-envelope", { ...event, ts: "2.0", text: "second" }));
		expect((await received.next()).text).toBe("second");
		expect(await fixture.packets.next()).toMatchObject({ envelope_id: "redelivery" });
		expect(await fixture.packets.next()).toMatchObject({ envelope_id: "second-envelope" });
		expect(seen).toEqual(["first", "second"]);
		expect(fixture.urls.map(url => new URL(url).searchParams.get("ticket"))).toEqual(["1", "2"]);
		controller.abort();
		await run;
	});

	it("rejects link_disabled instead of reconnecting to a disabled Socket Mode app", async () => {
		const fixture = network();
		const { run } = start(createSlackAdapter(config, env, transportDeps), async () => {});
		const socket = await fixture.opened;
		socket.send(JSON.stringify({ type: "disconnect", reason: "link_disabled" }));
		await expect(run).rejects.toThrow("Slack Socket Mode is disabled");
		expect(fixture.urls).toHaveLength(1);
	});

	it("aborts after a disconnect without opening another socket", async () => {
		const fixture = network();
		const { controller, run } = start(createSlackAdapter(config, env, transportDeps), async () => {});
		const socket = await fixture.opened;
		socket.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
		await fixture.closed;
		controller.abort();
		await run;
		expect(fixture.urls).toHaveLength(1);
	});
});

it("Telegram resumes delivery after a transient polling failure without restarting account discovery", async () => {
	const controller = new AbortController();
	controllers.push(controller);
	let identities = 0;
	let polls = 0;
	interceptFetch(request => {
		if (request.url.endsWith("/getMe")) {
			identities++;
			return Response.json({ ok: true, result: { id: 42, is_bot: true, username: "TestBot" } });
		}
		polls++;
		if (polls === 1) return Response.json({ ok: false }, { status: 503 });
		return Response.json({
			ok: true,
			result: [
				{
					update_id: 10,
					message: {
						message_id: 1,
						from: { id: 7, is_bot: false },
						chat: { id: 7, type: "private" },
						text: "recovered",
					},
				},
			],
		});
	});
	const seen: string[] = [];
	const run = createTelegramAdapter(config, env, transportDeps).start(async value => {
		seen.push(value.text);
		controller.abort();
	}, controller.signal);
	runs.push(run);
	await run;
	expect(seen).toEqual(["recovered"]);
	expect(polls).toBe(2);
	expect(identities).toBe(1);
});

describe("Discord startup rate limits", () => {
	it("waits until the server Retry-After deadline before attempting authentication again", async () => {
		const time = controlledDiscordClock();
		const retryScheduled = time.nextDelay();
		const controller = new AbortController();
		controllers.push(controller);
		const retried = Promise.withResolvers<void>();
		let attempts = 0;
		interceptFetch(() => {
			attempts++;
			if (attempts === 1)
				return Response.json({ message: "rate limited" }, { status: 429, headers: { "Retry-After": "65" } });
			retried.resolve();
			controller.abort();
			return Response.json({ id: "42", bot: true });
		});
		const run = createDiscordAdapter(config, env, { ...transportDeps, clock: time.clock }).start(
			async () => {},
			controller.signal,
		);
		runs.push(run);
		void run.catch(() => {});
		expect(await retryScheduled).toBe(65_000);
		time.advance(64_999);
		expect(attempts).toBe(1);
		time.advance(1);
		await retried.promise;
		await run;
		expect(attempts).toBe(2);
		expect(time.pending()).toBe(0);
	});

	it("cancels a server-mandated retry wait without issuing another authentication request", async () => {
		const time = controlledDiscordClock();
		const retryScheduled = time.nextDelay();
		let attempts = 0;
		interceptFetch(() => {
			attempts++;
			return Response.json({ message: "rate limited" }, { status: 429, headers: { "Retry-After": "65" } });
		});
		const { controller, run } = start(
			createDiscordAdapter(config, env, { ...transportDeps, clock: time.clock }),
			async () => {},
		);
		await retryScheduled;
		controller.abort();
		await run;
		time.advance(65_000);
		expect(time.pending()).toBe(0);
		expect(attempts).toBe(1);
	});
});
