import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMessengerConfig, parseMessengerConfig, validateMessengerEnvironment } from "../src/messenger/config";
import { createMessengerGateway, isMessengerMessageAllowed, messengerConversationKey } from "../src/messenger/gateway";
import { MessengerHttpError, messengerFetchJson, splitMessengerText } from "../src/messenger/http";
import type { MessengerAdapter, MessengerConfig, MessengerMessage, MessengerReply } from "../src/messenger/types";
import { MessengerFatalError } from "../src/messenger/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function rawConfig() {
	return {
		cwd: "workspace",
		sessionDir: "state",
		toolNames: ["read"],
		platforms: {
			telegram: {
				tokenEnv: "TEST_TELEGRAM_TOKEN",
				allowedUserIds: ["alice", "bob"],
				allowedChannelIds: ["room", "other-room"],
			},
		},
	};
}

function config(): MessengerConfig {
	return parseMessengerConfig(rawConfig(), tmpdir());
}

function message(overrides: Partial<MessengerMessage> = {}): MessengerMessage {
	return {
		platform: "telegram",
		accountId: "account",
		channelId: "room",
		senderId: "alice",
		messageId: "message",
		text: "Explain the result",
		direct: true,
		mentioned: false,
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => {
		resolve = res;
	});
	return { promise, resolve };
}

function harness(reply: MessengerReply, settings = config()) {
	const delivered: Array<{ message: MessengerMessage; text: string }> = [];
	const adapters: MessengerAdapter[] = (["telegram", "discord", "slack"] as const).map(platform => ({
		platform,
		async start() {},
		async send(incoming, text) {
			delivered.push({ message: incoming, text });
		},
	}));
	return { gateway: createMessengerGateway(settings, adapters, reply), delivered };
}

describe("messenger configuration security", () => {
	test.each([
		["null", null],
		["array", []],
		["empty platform set", { ...rawConfig(), platforms: {} }],
		["unknown platform", { ...rawConfig(), platforms: { irc: rawConfig().platforms.telegram } }],
		["unknown root key", { ...rawConfig(), allowAll: true }],
		["unknown tool", { ...rawConfig(), toolNames: ["invented_tool"] }],
		["delegation tool", { ...rawConfig(), toolNames: ["task"] }],
		["evaluation tool", { ...rawConfig(), toolNames: ["eval"] }],
		["browser tool", { ...rawConfig(), toolNames: ["browser"] }],
		["string tool list", { ...rawConfig(), toolNames: "read" }],
		["non-string working directory", { ...rawConfig(), cwd: 17 }],
	] as const)("rejects %s rather than enabling an ambiguous policy", (_name, value) => {
		expect(() => parseMessengerConfig(value, tmpdir())).toThrow();
	});

	test.each([
		["missing sender allowlist", { allowedUserIds: undefined }],
		["empty sender allowlist", { allowedUserIds: [] }],
		["string sender allowlist", { allowedUserIds: "alice" }],
		["wildcard sender", { allowedUserIds: ["*"] }],
		["duplicate sender", { allowedUserIds: ["alice", "alice"] }],
		["blank sender", { allowedUserIds: [""] }],
		["numeric sender", { allowedUserIds: [123] }],
		["empty channel restriction", { allowedChannelIds: [] }],
		["wildcard channel", { allowedChannelIds: ["*"] }],
		["duplicate channel", { allowedChannelIds: ["room", "room"] }],
		["blank channel", { allowedChannelIds: [" "] }],
		["literal token", { token: "fixture-secret-not-a-real-token" }],
		["invalid environment reference", { tokenEnv: "TOKEN-NAME" }],
		["environment interpolation", { tokenEnv: `\${TOKEN}` }],
		["empty environment reference", { tokenEnv: "" }],
	] as const)("rejects %s", (_name, patch) => {
		const value = rawConfig();
		expect(() =>
			parseMessengerConfig(
				{ ...value, platforms: { telegram: { ...value.platforms.telegram, ...patch } } },
				tmpdir(),
			),
		).toThrow();
	});

	test("resolves explicit relative paths against the config file, not the process working directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "messenger-config-"));
		temporaryDirectories.push(directory);
		const file = join(directory, "messenger.json");
		await writeFile(file, JSON.stringify(rawConfig()));
		const loaded = await loadMessengerConfig(file);
		expect(loaded.cwd).toBe(resolve(directory, "workspace"));
		expect(loaded.sessionDir).toBe(resolve(directory, "state"));
	});

	test.each([undefined, "", "   "])("refuses missing or blank bot credentials (%s)", credential => {
		expect(() => validateMessengerEnvironment(config(), { TEST_TELEGRAM_TOKEN: credential })).toThrow();
	});

	test("requires Slack's app credential even when its bot credential exists, without exposing the bot secret", () => {
		const settings = parseMessengerConfig(
			{
				...rawConfig(),
				platforms: {
					slack: {
						tokenEnv: "TEST_SLACK_BOT",
						appTokenEnv: "TEST_SLACK_APP",
						allowedUserIds: ["alice"],
					},
				},
			},
			tmpdir(),
		);
		let failure: unknown;
		try {
			validateMessengerEnvironment(settings, { TEST_SLACK_BOT: "fixture-private-bot-secret" });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).not.toContain("fixture-private-bot-secret");
	});
});

describe("messenger authorization and conversation isolation", () => {
	test.each([
		["authorized DM", {}, true],
		["mentioned group", { direct: false, mentioned: true }, true],
		["unmentioned group", { direct: false, mentioned: false }, false],
		["unlisted sender", { senderId: "mallory", mentioned: true }, false],
		["unlisted channel", { channelId: "private-room", mentioned: true }, false],
		["disabled platform", { platform: "discord" }, false],
		["empty text", { text: "" }, false],
		["whitespace text", { text: " \n\t" }, false],
		["maximum text", { text: "x".repeat(32_000) }, true],
		["oversized text", { text: "x".repeat(32_001) }, false],
	] satisfies Array<[string, Partial<MessengerMessage>, boolean]>)("%s", (_name, patch, allowed) => {
		expect(isMessengerMessageAllowed(message(patch), config())).toBe(allowed);
	});

	test("omitting channel restrictions still requires sender authorization and group mentions", () => {
		const settings = config();
		delete settings.platforms.telegram!.allowedChannelIds;
		expect(isMessengerMessageAllowed(message({ channelId: "unlisted" }), settings)).toBe(true);
		expect(isMessengerMessageAllowed(message({ channelId: "unlisted", senderId: "mallory" }), settings)).toBe(false);
		expect(isMessengerMessageAllowed(message({ channelId: "unlisted", direct: false }), settings)).toBe(false);
	});

	test.each([
		["platform", { platform: "slack" }],
		["account", { accountId: "another-account" }],
		["channel", { channelId: "other-room" }],
		["thread", { threadId: "thread" }],
		["sender", { senderId: "bob" }],
	] satisfies Array<[string, Partial<MessengerMessage>]>)("isolates the %s conversation dimension", (_name, patch) => {
		expect(messengerConversationKey(message(patch))).not.toBe(messengerConversationKey(message()));
	});

	test("encodes a reversible tuple without delimiter collisions and excludes transient message IDs", () => {
		const incoming = message({ accountId: 'account/"', channelId: "room:part", threadId: "topic\n1" });
		expect(JSON.parse(messengerConversationKey(incoming))).toEqual([
			"telegram",
			'account/"',
			"room:part",
			"topic\n1",
			"alice",
		]);
		expect(messengerConversationKey(message({ channelId: "a:b", senderId: "c" }))).not.toBe(
			messengerConversationKey(message({ channelId: "a", senderId: "b:c" })),
		);
		expect(messengerConversationKey(message({ messageId: "next", text: "different" }))).toBe(
			messengerConversationKey(message()),
		);
		expect(JSON.parse(messengerConversationKey(message()))[3]).toBe("");
	});
});

describe("messenger dispatch", () => {
	test("run routes adapter events and aborts queued and active work on shutdown", async () => {
		const ready = deferred<(incoming: MessengerMessage) => Promise<void>>();
		const entered = deferred<void>();
		const stopped = deferred<void>();
		const controller = new AbortController();
		const turns: string[] = [];
		const output: string[] = [];
		const adapter: MessengerAdapter = {
			platform: "telegram",
			async start(onMessage, signal) {
				signal.addEventListener("abort", () => stopped.resolve(), { once: true });
				ready.resolve(onMessage);
				await stopped.promise;
			},
			async send(_incoming, text) {
				output.push(text);
			},
		};
		const gateway = createMessengerGateway(config(), [adapter], async (incoming, signal) => {
			turns.push(incoming.messageId);
			entered.resolve();
			await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			return "Cancelled turn";
		});
		const running = gateway.run(controller.signal);
		const emit = await ready.promise;
		const active = emit(message({ messageId: "active" }));
		await entered.promise;
		const queued = emit(message({ messageId: "queued" }));
		controller.abort();
		await Promise.all([running, active, queued, stopped.promise]);
		expect(turns).toEqual(["active"]);
		expect(output).toEqual([]);
	});

	test("fatal session initialization stops the gateway without retrying or sending an error reply", async () => {
		const ready = deferred<(incoming: MessengerMessage) => Promise<void>>();
		const entered = deferred<void>();
		const release = deferred<void>();
		const stopped = deferred<void>();
		const controller = new AbortController();
		const turns: string[] = [];
		const output: string[] = [];
		let transportAborted = false;
		const adapter: MessengerAdapter = {
			platform: "telegram",
			async start(onMessage, signal) {
				signal.addEventListener(
					"abort",
					() => {
						transportAborted = true;
						stopped.resolve();
					},
					{ once: true },
				);
				ready.resolve(onMessage);
				await stopped.promise;
			},
			async send(_incoming, text) {
				output.push(text);
			},
		};
		const gateway = createMessengerGateway(config(), [adapter], async incoming => {
			turns.push(incoming.messageId);
			entered.resolve();
			await release.promise;
			throw new MessengerFatalError();
		});
		const running = gateway.run(controller.signal).then(
			() => null,
			error => error,
		);
		try {
			const emit = await ready.promise;
			const active = emit(message({ messageId: "fatal" }));
			await entered.promise;
			const queued = emit(message({ messageId: "queued" }));
			release.resolve();
			await Promise.all([active, queued]);
			expect(turns).toEqual(["fatal"]);
			expect(output).toEqual([]);
			expect(transportAborted).toBe(true);
			expect(await running).toBeInstanceOf(MessengerFatalError);
			await gateway.handle(message({ messageId: "after-fatal" }));
			expect(turns).toEqual(["fatal"]);
			expect(output).toEqual([]);
		} finally {
			controller.abort();
			await running;
		}
	});

	test("a failed outbound send is not retried and cannot poison the next turn", async () => {
		const output: string[] = [];
		let failedAttempts = 0;
		const adapter: MessengerAdapter = {
			platform: "telegram",
			async start() {},
			async send(incoming, text) {
				if (incoming.messageId === "failed-send") {
					failedAttempts++;
					throw new Error("fixture-network-secret");
				}
				output.push(text);
			},
		};
		const gateway = createMessengerGateway(config(), [adapter], async incoming => `Answer ${incoming.messageId}`);
		await Promise.allSettled([
			gateway.handle(message({ messageId: "failed-send" })),
			gateway.handle(message({ messageId: "next" })),
		]);
		expect(failedAttempts).toBe(1);
		expect(output).toEqual(["Answer next"]);
	});

	test("an already-aborted request never executes or sends a turn", async () => {
		const turns: string[] = [];
		const { gateway, delivered } = harness(async incoming => {
			turns.push(incoming.messageId);
			return "Must not escape";
		});
		const controller = new AbortController();
		controller.abort();
		await gateway.handle(message(), controller.signal);
		expect(turns).toEqual([]);
		expect(delivered).toEqual([]);
	});

	test.each([
		["unlisted sender", { senderId: "mallory" }],
		["unlisted channel", { channelId: "private-room" }],
		["unmentioned group", { direct: false }],
		["empty prompt", { text: "" }],
		["oversized prompt", { text: "x".repeat(32_001) }],
	] satisfies Array<[string, Partial<MessengerMessage>]>)(
		"%s never executes a turn or consumes an authorized event's dedupe slot",
		async (_name, patch) => {
			const turns: string[] = [];
			const { gateway, delivered } = harness(async incoming => {
				turns.push(incoming.senderId);
				return "Authorized answer";
			});
			await gateway.handle(message(patch));
			expect(turns).toEqual([]);
			expect(delivered).toEqual([]);
			await gateway.handle(message());
			expect(turns).toEqual(["alice"]);
			expect(delivered.map(item => item.text)).toEqual(["Authorized answer"]);
		},
	);

	test("suppresses duplicate events while their turn is active and after it completes", async () => {
		const entered = deferred<void>();
		const release = deferred<string>();
		let turns = 0;
		const { gateway, delivered } = harness(async () => {
			turns++;
			entered.resolve();
			return release.promise;
		});
		const first = gateway.handle(message());
		await entered.promise;
		const duplicate = gateway.handle(message());
		release.resolve("One answer");
		await Promise.all([first, duplicate]);
		await gateway.handle(message());
		expect(turns).toBe(1);
		expect(delivered.map(item => item.text)).toEqual(["One answer"]);
	});

	test.each([
		["platform", { platform: "discord" }],
		["account", { accountId: "account-two" }],
		["channel", { channelId: "other-room" }],
	] satisfies Array<[string, Partial<MessengerMessage>]>)(
		"does not dedupe equal message IDs across %s",
		async (_name, patch) => {
			const settings = config();
			settings.platforms.discord = { ...settings.platforms.telegram! };
			const { gateway, delivered } = harness(
				async incoming => `Answer for ${messengerConversationKey(incoming)}`,
				settings,
			);
			await gateway.handle(message());
			await gateway.handle(message(patch));
			expect(delivered.map(item => item.text)).toEqual([
				`Answer for ${messengerConversationKey(message())}`,
				`Answer for ${messengerConversationKey(message(patch))}`,
			]);
		},
	);

	test("globally serializes different users, threads, accounts and platforms", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const settings = config();
		settings.platforms.discord = { ...settings.platforms.telegram! };
		settings.platforms.slack = { ...settings.platforms.telegram! };
		let active = 0;
		let maximum = 0;
		const turns: string[] = [];
		const { gateway, delivered } = harness(async incoming => {
			active++;
			maximum = Math.max(maximum, active);
			turns.push(incoming.messageId);
			if (incoming.messageId === "first") {
				entered.resolve();
				await release.promise;
			}
			active--;
			return `Answer ${incoming.messageId}`;
		}, settings);
		const first = gateway.handle(message({ messageId: "first" }));
		await entered.promise;
		const second = gateway.handle(
			message({ platform: "discord", senderId: "bob", threadId: "topic", messageId: "second" }),
		);
		const third = gateway.handle(
			message({ platform: "slack", accountId: "account-two", channelId: "other-room", messageId: "third" }),
		);
		release.resolve();
		await Promise.all([first, second, third]);
		expect(maximum).toBe(1);
		expect(turns).toEqual(["first", "second", "third"]);
		expect(delivered.map(item => item.text)).toEqual(["Answer first", "Answer second", "Answer third"]);
	});

	test("redacts rejected turns and recovers the queue for the next message", async () => {
		const { gateway, delivered } = harness(async incoming => {
			if (incoming.messageId === "failed") throw new Error("fixture-secret-and-private-tool-arguments");
			return "Next turn succeeded";
		});
		await Promise.all([
			gateway.handle(message({ messageId: "failed" })),
			gateway.handle(message({ messageId: "next" })),
		]);
		expect(delivered).toHaveLength(2);
		expect(delivered[0]!.message.messageId).toBe("failed");
		expect(delivered[0]!.text.trim().length).toBeGreaterThan(0);
		expect(delivered[0]!.text).not.toContain("fixture-secret-and-private-tool-arguments");
		expect(delivered[1]!.text).toBe("Next turn succeeded");
	});

	test("drops overflow beyond 100 waiting turns without executing or sending them", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const turns: string[] = [];
		const { gateway, delivered } = harness(async incoming => {
			turns.push(incoming.messageId);
			if (incoming.messageId === "active") {
				entered.resolve();
				await release.promise;
			}
			return incoming.messageId;
		});
		const active = gateway.handle(message({ messageId: "active" }));
		await entered.promise;
		const waiting = Array.from({ length: 100 }, (_, index) => `queued-${index}`);
		const queued = waiting.map(messageId => gateway.handle(message({ messageId })));
		const overflow = gateway.handle(message({ messageId: "overflow" }));
		release.resolve();
		await Promise.all([active, ...queued, overflow]);
		expect(turns).toEqual(["active", ...waiting]);
		expect(delivered.map(item => item.text)).toEqual(["active", ...waiting]);
	});

	test("aborting active work signals the turn, drops queued turns and sends no cancelled output", async () => {
		const entered = deferred<void>();
		const controller = new AbortController();
		const turns: string[] = [];
		let activeAborted = false;
		const { gateway, delivered } = harness(async (incoming, signal) => {
			turns.push(incoming.messageId);
			entered.resolve();
			await new Promise<void>(resolve => {
				signal.addEventListener(
					"abort",
					() => {
						activeAborted = true;
						resolve();
					},
					{ once: true },
				);
			});
			return "Cancelled answer must not escape";
		});
		const first = gateway.handle(message({ messageId: "active" }), controller.signal);
		await entered.promise;
		const queued = gateway.handle(message({ messageId: "queued" }), controller.signal);
		controller.abort();
		await Promise.all([first, queued]);
		expect(activeAborted).toBe(true);
		expect(turns).toEqual(["active"]);
		expect(delivered).toEqual([]);
	});
});

describe("messenger text chunking", () => {
	test.each([
		["empty", "", 3, []],
		["below boundary", "ab", 3, ["ab"]],
		["exact boundary", "abc", 3, ["abc"]],
		["over boundary", "abcd", 3, ["abc", "d"]],
		["astral characters", "A😀B🚀C", 2, ["A", "😀", "B", "🚀", "C"]],
		["preserved whitespace", "a\nb c", 2, ["a\n", "b ", "c"]],
	] satisfies Array<[string, string, number, string[]]>)(
		"preserves exact text at %s",
		(_name, text, limit, expected) => {
			const chunks = splitMessengerText(text, limit);
			expect(chunks).toEqual(expected);
			expect(chunks.join("")).toBe(text);
		},
	);

	test("moves a surrogate pair across the platform limit without truncation or oversized chunks", () => {
		const text = `${"a".repeat(4095)}😀${"b".repeat(4094)}🚀`;
		const chunks = splitMessengerText(text, 4096);
		expect(chunks).toEqual(["a".repeat(4095), `😀${"b".repeat(4094)}`, "🚀"]);
		expect(chunks.join("")).toBe(text);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
	});

	test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid chunk limit %s", limit => {
		expect(() => splitMessengerText("text", limit)).toThrow();
	});
});

describe("messenger HTTP boundaries", () => {
	function transport(respond: (init?: RequestInit) => Promise<Response>): typeof fetch {
		return Object.assign(async (_input: string | URL | Request, init?: RequestInit) => respond(init), {
			preconnect() {},
		});
	}

	test("decodes successful provider JSON without treating provider-level errors as HTTP errors", async () => {
		const body = { ok: false, error: "invalid_auth" };
		const result = await messengerFetchJson(
			"https://fixture.invalid/api",
			{},
			undefined,
			transport(async () => Response.json(body)),
		);
		expect(result).toEqual(body);
	});

	test.each([401, 403, 500])(
		"preserves HTTP %s for policy decisions without exposing URL or response body",
		async status => {
			let failure: unknown;
			try {
				await messengerFetchJson(
					"https://fixture.invalid/bot/fixture-url-secret",
					{},
					undefined,
					transport(async () => new Response("fixture-body-secret", { status })),
				);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(MessengerHttpError);
			if (!(failure instanceof MessengerHttpError)) throw new Error("Expected an HTTP policy error");
			expect(failure.status).toBe(status);
			const visible = `${String(failure)} ${JSON.stringify(failure)}`;
			expect(visible).not.toContain("fixture-url-secret");
			expect(visible).not.toContain("fixture-body-secret");
		},
	);

	test.each([
		["header seconds", "2", {}, 2_000],
		["Telegram retry metadata", undefined, { parameters: { retry_after: 3 } }, 3_000],
		["header overrides JSON", "4", { parameters: { retry_after: 12 } }, 4_000],
		["Discord retry metadata", undefined, { retry_after: 1.25 }, 1_250],
		["header overrides Discord JSON", "4", { retry_after: 12 }, 4_000],
		["Discord precedes nested metadata", undefined, { retry_after: 7, parameters: { retry_after: 3 } }, 7_000],
		["long Discord delay", undefined, { retry_after: 600 }, 600_000],
		["native timer Discord overflow", undefined, { retry_after: 2147484 }, 2_147_483_647],
		["long header delay", "600", {}, 600_000],
		["long JSON delay", undefined, { parameters: { retry_after: 600 } }, 600_000],
		["native timer header boundary", "2147483.647", {}, 2_147_483_647],
		["native timer header overflow", "2147484", {}, 2_147_483_647],
		["native timer JSON overflow", undefined, { parameters: { retry_after: 2147484 } }, 2_147_483_647],
		["negative header", "-3", {}, undefined],
		["nonfinite header", "Infinity", {}, undefined],
		["negative JSON delay", undefined, { parameters: { retry_after: -1 } }, undefined],
	] satisfies Array<[string, string | undefined, object, number | undefined]>)(
		"maps 429 %s without retrying the request",
		async (_name, retryAfter, body, expected) => {
			let attempts = 0;
			let failure: unknown;
			try {
				await messengerFetchJson(
					"https://fixture.invalid/rate-limit",
					{},
					undefined,
					transport(async () => {
						attempts++;
						return Response.json(
							{ ...body, private: "fixture-rate-secret" },
							{
								status: 429,
								headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
							},
						);
					}),
				);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(MessengerHttpError);
			if (!(failure instanceof MessengerHttpError)) throw new Error("Expected a rate limit policy error");
			expect(failure.status).toBe(429);
			expect(failure.retryAfterMs).toBe(expected);
			expect(attempts).toBe(1);
			expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain("fixture-rate-secret");
		},
	);

	test.each(["network rejection", "invalid JSON"])(
		"redacts %s rather than exposing provider diagnostics",
		async mode => {
			let failure: unknown;
			try {
				await messengerFetchJson(
					"https://fixture.invalid/fixture-url-secret",
					{},
					undefined,
					transport(async () => {
						if (mode === "network rejection") throw new Error("fixture-provider-secret");
						return new Response("fixture-provider-secret", { status: 200 });
					}),
				);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			const visible = `${String(failure)} ${JSON.stringify(failure)}`;
			expect(visible).not.toContain("fixture-provider-secret");
			expect(visible).not.toContain("fixture-url-secret");
		},
	);

	test.each(["argument", "request init"])("cancels in-flight fetch through the %s signal", async source => {
		const entered = deferred<void>();
		const controller = new AbortController();
		let cancelled = false;
		const request = messengerFetchJson(
			"https://fixture.invalid/long-poll",
			source === "request init" ? { signal: controller.signal } : {},
			source === "argument" ? controller.signal : undefined,
			transport(
				init =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => {
								cancelled = true;
								reject(new Error("fixture-cancellation-secret"));
							},
							{ once: true },
						);
						entered.resolve();
					}),
			),
		);
		const result = request.then(
			() => null,
			error => error,
		);
		await entered.promise;
		controller.abort();
		const failure: unknown = await result;
		expect(cancelled).toBe(true);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).toMatch(/cancel/i);
		expect(String(failure)).not.toContain("fixture-cancellation-secret");
	});
});
