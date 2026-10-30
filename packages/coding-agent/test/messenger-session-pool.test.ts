import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessengerSessionBridge } from "../src/messenger/session";
import {
	createMessengerSessionPool,
	type MessengerSessionPool,
	type MessengerSessionPoolOptions,
	type MessengerSessionProcess,
	smokeTestMessengerSessionWorker,
	spawnMessengerSessionProcess,
} from "../src/messenger/session-pool";
import {
	type MessengerSessionInbound,
	type MessengerSessionOutbound,
	startMessengerSessionWorker,
} from "../src/messenger/session-worker";
import type { MessengerConfig, MessengerMessage } from "../src/messenger/types";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function poolConfig(): MessengerConfig {
	return {
		cwd: join(tmpdir(), "messenger-pool-workspace"),
		sessionDir: join(tmpdir(), "messenger-pool-sessions"),
		toolNames: ["read"],
		platforms: { telegram: { tokenEnv: "POOL_TEST_TELEGRAM_TOKEN", allowedUserIds: ["alice", "bob"] } },
	};
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

/** Drain pending microtasks; `setImmediate` is not faked, so it runs even under fake timers. */
function flush(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

function live(): AbortSignal {
	return new AbortController().signal;
}

/** Attach a handler at once so an expected rejection is never reported as unhandled while the test waits. */
function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
	return promise.then(
		value => ({ value }),
		error => ({ error }),
	);
}

/** A fake session process: records what the pool sends and lets the test answer. */
interface FakeSession {
	index: number;
	config: MessengerConfig;
	sent: MessengerSessionInbound[];
	/** Turn ids sent and not yet answered with `reply` or `failed`. */
	open: Set<string>;
	killed: boolean;
	emit(message: MessengerSessionOutbound): void;
	/** The process dies on its own (crash). */
	exit(): void;
}

type PoolEvent =
	| { kind: "spawn"; session: FakeSession }
	| { kind: "send"; session: FakeSession; message: MessengerSessionInbound }
	| { kind: "kill"; session: FakeSession; busy: boolean };

interface SentTurn {
	session: FakeSession;
	id: string;
	message: MessengerMessage;
}

interface FakeSessions {
	spawn(config: MessengerConfig): MessengerSessionProcess;
	sessions: FakeSession[];
	events: PoolEvent[];
	/** Answer `close` with `closed` (default); off lets a test hold the process in retirement. */
	ackClose: boolean;
	/** Make `send` throw synchronously for matching messages, as a closed IPC channel does. */
	sendFault?: (session: FakeSession, message: MessengerSessionInbound) => boolean;
	until(predicate: () => boolean): Promise<void>;
	turn(messageId: string): Promise<SentTurn>;
	sentTurns(): SentTurn[];
	/** Most processes alive at any moment: spawned minus killed or exited, replayed over the event log. */
	maxResident(): number;
}

function fakeSessions(): FakeSessions {
	const sessions: FakeSession[] = [];
	const events: PoolEvent[] = [];
	const waiters = new Set<{ predicate: () => boolean; resolve: () => void }>();
	const record = (event: PoolEvent): void => {
		events.push(event);
		for (const waiter of [...waiters]) {
			if (!waiter.predicate()) continue;
			waiters.delete(waiter);
			waiter.resolve();
		}
	};
	const sentTurns = (): SentTurn[] =>
		events.flatMap(event =>
			event.kind === "send" && event.message.type === "turn"
				? [{ session: event.session, id: event.message.id, message: event.message.message }]
				: [],
		);
	const fake: FakeSessions = {
		sessions,
		events,
		ackClose: true,
		sentTurns,
		spawn(config) {
			const handlers = new Set<(message: MessengerSessionOutbound) => void>();
			const exited = Promise.withResolvers<void>();
			let alive = true;
			const session: FakeSession = {
				index: sessions.length,
				config,
				sent: [],
				open: new Set(),
				killed: false,
				emit(outbound) {
					if (outbound.type === "reply" || outbound.type === "failed") session.open.delete(outbound.id);
					for (const handler of [...handlers]) handler(outbound);
				},
				exit() {
					if (!alive) return;
					alive = false;
					exited.resolve();
				},
			};
			sessions.push(session);
			record({ kind: "spawn", session });
			return {
				send(inbound) {
					if (fake.sendFault?.(session, inbound)) throw new Error("PRIVATE_IPC_DETAIL");
					session.sent.push(inbound);
					if (inbound.type === "turn") session.open.add(inbound.id);
					record({ kind: "send", session, message: inbound });
					if (inbound.type === "close" && fake.ackClose) {
						queueMicrotask(() => session.emit({ type: "closed", id: inbound.id }));
					}
				},
				onMessage(handler) {
					handlers.add(handler);
					return () => handlers.delete(handler);
				},
				exited: exited.promise,
				kill() {
					session.killed = true;
					record({ kind: "kill", session, busy: session.open.size > 0 });
					session.exit();
				},
			};
		},
		until(predicate) {
			if (predicate()) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.add({ predicate, resolve });
			return promise;
		},
		async turn(messageId) {
			const find = () => sentTurns().find(turn => turn.message.messageId === messageId);
			await fake.until(() => find() !== undefined);
			return find()!;
		},
		maxResident() {
			let resident = 0;
			let maximum = 0;
			for (const event of events) {
				if (event.kind === "spawn") resident++;
				else if (event.kind === "kill") resident--;
				maximum = Math.max(maximum, resident);
			}
			return maximum;
		},
	};
	return fake;
}

function pool(
	fake: FakeSessions,
	options: Omit<MessengerSessionPoolOptions, "spawn"> = {},
	config = poolConfig(),
): MessengerSessionPool {
	const created = createMessengerSessionPool(config, { idleMs: 60_000, ...options, spawn: fake.spawn });
	cleanups.push(() => {
		fake.ackClose = true;
		return created.close();
	});
	return created;
}

function sentTypes(session: FakeSession): string[] {
	return session.sent.map(item => item.type);
}

/** Answer one turn per sender so each conversation holds an idle resident process. */
async function fillIdle(fake: FakeSessions, sessions: MessengerSessionPool, senders: string[]): Promise<FakeSession[]> {
	const idle: FakeSession[] = [];
	for (const senderId of senders) {
		const answer = sessions.reply(message({ senderId, messageId: `${senderId}-idle` }), live());
		const turn = await fake.turn(`${senderId}-idle`);
		turn.session.emit({ type: "reply", id: turn.id, text: "Done" });
		await answer;
		idle.push(turn.session);
	}
	return idle;
}

function closeOf(session: FakeSession): MessengerSessionInbound | undefined {
	return session.sent.find(item => item.type === "close");
}

describe("messenger session pool", () => {
	test("the first turn starts one session process, initializes it, and relays its activity and reply", async () => {
		const fake = fakeSessions();
		const config = poolConfig();
		const sessions = pool(fake, {}, config);
		const activity: string[] = [];
		const answer = sessions.reply(message({ messageId: "first" }), live(), text => activity.push(text));
		const turn = await fake.turn("first");
		expect(fake.sessions).toHaveLength(1);
		expect(turn.session.sent).toEqual([
			{ type: "init", id: expect.any(String), config },
			{ type: "turn", id: turn.id, message: message({ messageId: "first" }) },
		]);
		turn.session.emit({ type: "activity", id: "another-turn", text: "Not this turn" });
		turn.session.emit({ type: "activity", id: turn.id, text: "Reading files" });
		turn.session.emit({ type: "reply", id: turn.id, text: "Final answer" });
		expect(await answer).toBe("Final answer");
		expect(activity).toEqual(["Reading files"]);
	});

	test("later turns of one conversation reuse its process without re-initializing it", async () => {
		const fake = fakeSessions();
		const sessions = pool(fake);
		const first = sessions.reply(message({ messageId: "first" }), live());
		const firstTurn = await fake.turn("first");
		firstTurn.session.emit({ type: "reply", id: firstTurn.id, text: "One" });
		await first;
		const second = sessions.reply(message({ messageId: "second" }), live());
		const secondTurn = await fake.turn("second");
		secondTurn.session.emit({ type: "reply", id: secondTurn.id, text: "Two" });
		expect(await second).toBe("Two");
		expect(fake.sessions).toHaveLength(1);
		expect(sentTypes(firstTurn.session)).toEqual(["init", "turn", "turn"]);
	});

	test("different conversations get their own processes and run at the same time", async () => {
		const fake = fakeSessions();
		const sessions = pool(fake);
		const alice = sessions.reply(message({ messageId: "alice-turn" }), live());
		const bob = sessions.reply(message({ senderId: "bob", messageId: "bob-turn" }), live());
		const aliceTurn = await fake.turn("alice-turn");
		const bobTurn = await fake.turn("bob-turn");
		expect(aliceTurn.session).not.toBe(bobTurn.session);
		bobTurn.session.emit({ type: "reply", id: bobTurn.id, text: "For Bob" });
		expect(await bob).toBe("For Bob");
		aliceTurn.session.emit({ type: "reply", id: aliceTurn.id, text: "For Alice" });
		expect(await alice).toBe("For Alice");
	});

	test("a follow-up in a newly opened thread queues behind the turn that opened it, in the same process", async () => {
		const fake = fakeSessions();
		const sessions = pool(fake);
		// The destination the gateway passes after `prepare` opened thread "t1" for a top-level message...
		const opener = sessions.reply(
			message({ platform: "discord", direct: false, mentioned: true, threadId: "t1", messageId: "opener" }),
			live(),
		);
		const openerTurn = await fake.turn("opener");
		// ...and a message posted inside that thread, shaped as Discord delivers it, arriving mid-turn.
		const followUp = sessions.reply(
			message({
				platform: "discord",
				direct: false,
				mentioned: false,
				channelId: "t1",
				threadId: "t1",
				parentChannelId: "room",
				messageId: "follow-up",
			}),
			live(),
		);
		await flush();
		expect(fake.sentTurns().map(turn => turn.message.messageId)).toEqual(["opener"]);
		openerTurn.session.emit({ type: "reply", id: openerTurn.id, text: "Opened" });
		expect(await opener).toBe("Opened");
		const followUpTurn = await fake.turn("follow-up");
		expect(followUpTurn.session).toBe(openerTurn.session);
		followUpTurn.session.emit({ type: "reply", id: followUpTurn.id, text: "Followed up" });
		expect(await followUp).toBe("Followed up");
		expect(fake.sessions).toHaveLength(1);
	});

	test("an idle conversation's process is closed and killed after idleMs; its next message starts a fresh one", async () => {
		vi.useFakeTimers();
		const fake = fakeSessions();
		const sessions = pool(fake, { idleMs: 1_000 });
		const first = sessions.reply(message({ messageId: "first" }), live());
		const firstTurn = await fake.turn("first");
		firstTurn.session.emit({ type: "reply", id: firstTurn.id, text: "One" });
		await first;
		vi.advanceTimersByTime(999);
		await flush();
		expect(sentTypes(firstTurn.session)).toEqual(["init", "turn"]);
		expect(firstTurn.session.killed).toBe(false);
		vi.advanceTimersByTime(1);
		await fake.until(() => firstTurn.session.killed);
		expect(sentTypes(firstTurn.session)).toEqual(["init", "turn", "close"]);
		const second = sessions.reply(message({ messageId: "second" }), live());
		const secondTurn = await fake.turn("second");
		expect(secondTurn.session).not.toBe(firstTurn.session);
		expect(sentTypes(secondTurn.session)).toEqual(["init", "turn"]);
		secondTurn.session.emit({ type: "reply", id: secondTurn.id, text: "Two" });
		expect(await second).toBe("Two");
	});

	test("a failed turn rejects without detail only after its process retired; the next turn starts a fresh process", async () => {
		const fake = fakeSessions();
		fake.ackClose = false;
		const sessions = pool(fake);
		const failed = settle(sessions.reply(message({ messageId: "failing" }), live()));
		const failingTurn = await fake.turn("failing");
		const next = sessions.reply(message({ messageId: "next" }), live());
		failingTurn.session.emit({ type: "failed", id: failingTurn.id });
		await fake.until(() => closeOf(failingTurn.session) !== undefined);
		let rejected = false;
		void failed.then(() => {
			rejected = true;
		});
		await flush();
		expect(rejected).toBe(false);
		expect(failingTurn.session.killed).toBe(false);
		expect(fake.sessions).toHaveLength(1);
		failingTurn.session.emit({ type: "closed", id: closeOf(failingTurn.session)!.id });
		const { error } = await failed;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Messenger session turn failed");
		const nextTurn = await fake.turn("next");
		expect(nextTurn.session).not.toBe(failingTurn.session);
		const killAt = fake.events.findIndex(event => event.kind === "kill" && event.session === failingTurn.session);
		const respawnAt = fake.events.findIndex(event => event.kind === "spawn" && event.session === nextTurn.session);
		expect(killAt).toBeGreaterThanOrEqual(0);
		expect(killAt).toBeLessThan(respawnAt);
		nextTurn.session.emit({ type: "reply", id: nextTurn.id, text: "Recovered" });
		expect(await next).toBe("Recovered");
	});

	test("aborting a turn mid-flight tells its process to abort, rejects, and retires the process", async () => {
		const fake = fakeSessions();
		const sessions = pool(fake);
		const controller = new AbortController();
		const aborted = settle(sessions.reply(message({ messageId: "slow" }), controller.signal));
		const turn = await fake.turn("slow");
		controller.abort();
		const { error } = await aborted;
		expect(error).toBeInstanceOf(Error);
		expect(turn.session.sent).toEqual([
			{ type: "init", id: expect.any(String), config: poolConfig() },
			{ type: "turn", id: turn.id, message: message({ messageId: "slow" }) },
			{ type: "abort", id: turn.id },
			{ type: "close", id: expect.any(String) },
		]);
		expect(turn.session.killed).toBe(true);
	});

	test("a process that exits mid-turn rejects that turn, and the conversation's next turn starts a fresh process", async () => {
		const fake = fakeSessions();
		const sessions = pool(fake);
		const crashed = settle(sessions.reply(message({ messageId: "crashing" }), live()));
		const crashingTurn = await fake.turn("crashing");
		crashingTurn.session.exit();
		const { error } = await crashed;
		expect(error).toBeInstanceOf(Error);
		const next = sessions.reply(message({ messageId: "next" }), live());
		const nextTurn = await fake.turn("next");
		expect(nextTurn.session).not.toBe(crashingTurn.session);
		expect(sentTypes(nextTurn.session)).toEqual(["init", "turn"]);
		nextTurn.session.emit({ type: "reply", id: nextTurn.id, text: "Resumed" });
		expect(await next).toBe("Resumed");
	});

	test("a turn its process cannot be sent rejects, retires the process without an unhandled rejection, and the next turn starts fresh", async () => {
		const unhandled: unknown[] = [];
		const collect = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", collect);
		cleanups.push(() => {
			process.off("unhandledRejection", collect);
		});
		const fake = fakeSessions();
		fake.sendFault = (session, inbound) => session.index === 0 && inbound.type === "turn";
		const sessions = pool(fake);
		const { error } = await settle(sessions.reply(message({ messageId: "undeliverable" }), live()));
		expect(error).toBeInstanceOf(Error);
		const broken = fake.sessions[0]!;
		expect(sentTypes(broken)).toEqual(["init", "close"]);
		expect(broken.killed).toBe(true);
		// Its exit settles the turn again after it already failed; that late settlement must stay handled.
		await flush();
		await flush();
		expect(unhandled).toEqual([]);
		const next = sessions.reply(message({ messageId: "next" }), live());
		const nextTurn = await fake.turn("next");
		expect(nextTurn.session).not.toBe(broken);
		nextTurn.session.emit({ type: "reply", id: nextTurn.id, text: "Delivered" });
		expect(await next).toBe("Delivered");
		expect(unhandled).toEqual([]);
	});

	test("a burst of new conversations on a pool full of idle processes never exceeds maxProcesses or evicts busy work", async () => {
		const fake = fakeSessions();
		const sessions = pool(fake, { maxProcesses: 2 });
		await fillIdle(fake, sessions, ["alice", "bob"]);
		const burst = ["carol", "dave", "erin"];
		const answers = burst.map(senderId =>
			sessions.reply(message({ senderId, messageId: `${senderId}-new` }), live()),
		);
		const burstTurns = () => fake.sentTurns().filter(turn => turn.message.messageId.endsWith("-new"));
		await fake.until(() => burstTurns().length >= 2);
		await flush();
		expect(burstTurns()).toHaveLength(2);
		for (const turn of burstTurns()) turn.session.emit({ type: "reply", id: turn.id, text: turn.message.senderId });
		await fake.until(() => burstTurns().length === 3);
		const last = burstTurns()[2]!;
		last.session.emit({ type: "reply", id: last.id, text: last.message.senderId });
		expect(await Promise.all(answers)).toEqual(burst);
		expect(fake.maxResident()).toBeLessThanOrEqual(2);
		expect(fake.events.filter(event => event.kind === "kill" && event.busy)).toEqual([]);
		expect(fake.sessions).toHaveLength(5);
	});

	test("concurrent new conversations retire different idle processes in parallel, not one after another", async () => {
		const fake = fakeSessions();
		const sessions = pool(fake, { maxProcesses: 2 });
		const idle = await fillIdle(fake, sessions, ["alice", "bob"]);
		fake.ackClose = false;
		const answers = ["carol", "dave"].map(senderId =>
			sessions.reply(message({ senderId, messageId: `${senderId}-new` }), live()),
		);
		await fake.until(() => idle.some(session => closeOf(session) !== undefined));
		await flush();
		expect(idle.map(session => closeOf(session)?.type)).toEqual(["close", "close"]);
		expect(fake.sessions).toHaveLength(2);
		for (const session of idle) session.emit({ type: "closed", id: closeOf(session)!.id });
		for (const senderId of ["carol", "dave"]) {
			const turn = await fake.turn(`${senderId}-new`);
			turn.session.emit({ type: "reply", id: turn.id, text: senderId });
		}
		expect(await Promise.all(answers)).toEqual(["carol", "dave"]);
		expect(fake.maxResident()).toBe(2);
	});

	test("when every resident process is busy, a new conversation waits for a slot instead of exceeding the limit", async () => {
		const fake = fakeSessions();
		const sessions = pool(fake, { maxProcesses: 1 });
		const alice = sessions.reply(message({ messageId: "alice-busy" }), live());
		const aliceTurn = await fake.turn("alice-busy");
		const bob = sessions.reply(message({ senderId: "bob", messageId: "bob-waiting" }), live());
		await flush();
		expect(fake.sessions).toHaveLength(1);
		expect(aliceTurn.session.killed).toBe(false);
		aliceTurn.session.emit({ type: "reply", id: aliceTurn.id, text: "Alice done" });
		expect(await alice).toBe("Alice done");
		const bobTurn = await fake.turn("bob-waiting");
		expect(bobTurn.session).not.toBe(aliceTurn.session);
		expect(aliceTurn.session.killed).toBe(true);
		bobTurn.session.emit({ type: "reply", id: bobTurn.id, text: "Bob done" });
		expect(await bob).toBe("Bob done");
		expect(fake.maxResident()).toBe(1);
		expect(fake.events.filter(event => event.kind === "kill" && event.busy)).toEqual([]);
	});

	test("close releases a start waiting for a slot at once, retires every process, and rejects later replies", async () => {
		const fake = fakeSessions();
		const sessions = pool(fake, { maxProcesses: 1 });
		const alice = settle(sessions.reply(message({ messageId: "alice-busy" }), live()));
		const aliceTurn = await fake.turn("alice-busy");
		const bob = settle(sessions.reply(message({ senderId: "bob", messageId: "bob-waiting" }), live()));
		let bobSettled = false;
		void bob.then(() => {
			bobSettled = true;
		});
		await flush();
		expect(bobSettled).toBe(false);
		fake.ackClose = false;
		const closing = sessions.close();
		await flush();
		// Released before the busy process finishes retiring, not after its flush bound.
		expect(bobSettled).toBe(true);
		expect((await bob).error).toBeInstanceOf(Error);
		expect(sentTypes(aliceTurn.session)).toEqual(["init", "turn", "close"]);
		expect(aliceTurn.session.killed).toBe(false);
		aliceTurn.session.emit({ type: "closed", id: closeOf(aliceTurn.session)!.id });
		await closing;
		expect(aliceTurn.session.killed).toBe(true);
		expect((await alice).error).toBeInstanceOf(Error);
		expect(fake.sessions).toHaveLength(1);
		await expect(sessions.reply(message({ messageId: "after-close" }), live())).rejects.toThrow();
		expect(fake.sessions).toHaveLength(1);
	});
});

describe("messenger session process spawning", () => {
	test("a real session process never receives the configured platform token variables", () => {
		const names = {
			POOL_TEST_TELEGRAM_TOKEN: "telegram-secret",
			POOL_TEST_SLACK_TOKEN: "slack-secret",
			POOL_TEST_SLACK_APP_TOKEN: "slack-app-secret",
			POOL_TEST_PLAIN: "kept",
		};
		for (const [name, value] of Object.entries(names)) {
			const previous = process.env[name];
			process.env[name] = value;
			cleanups.push(() => {
				if (previous === undefined) delete process.env[name];
				else process.env[name] = previous;
			});
		}
		let env: Record<string, string | undefined> | undefined;
		const spawn = spyOn(Bun, "spawn").mockImplementation(((options: { env?: Record<string, string> }) => {
			env = options.env;
			return { exited: Promise.resolve(0), send() {}, kill() {}, unref() {} };
		}) as unknown as typeof Bun.spawn);
		cleanups.push(() => spawn.mockRestore());
		spawnMessengerSessionProcess({
			...poolConfig(),
			platforms: {
				telegram: { tokenEnv: "POOL_TEST_TELEGRAM_TOKEN", allowedUserIds: ["alice"] },
				slack: {
					tokenEnv: "POOL_TEST_SLACK_TOKEN",
					appTokenEnv: "POOL_TEST_SLACK_APP_TOKEN",
					allowedUserIds: ["alice"],
				},
			},
		});
		expect(spawn).toHaveBeenCalledTimes(1);
		// The control variable proves the child gets the parent environment, so the absences are not vacuous.
		expect(env?.POOL_TEST_PLAIN).toBe("kept");
		expect(env).not.toHaveProperty("POOL_TEST_TELEGRAM_TOKEN");
		expect(env).not.toHaveProperty("POOL_TEST_SLACK_TOKEN");
		expect(env).not.toHaveProperty("POOL_TEST_SLACK_APP_TOKEN");
	});

	test("a session process boots from source and answers a ping over IPC", async () => {
		await smokeTestMessengerSessionWorker({ timeoutMs: 20_000 });
	}, 30_000);
});

interface WorkerHarness {
	outbound: MessengerSessionOutbound[];
	deliver(message: MessengerSessionInbound): void;
}

function worker(createBridge: (config: MessengerConfig) => MessengerSessionBridge): WorkerHarness {
	const outbound: MessengerSessionOutbound[] = [];
	const handlers = new Set<(message: MessengerSessionInbound) => void>();
	startMessengerSessionWorker(
		{
			send: message => outbound.push(message),
			onMessage(handler) {
				handlers.add(handler);
				return () => handlers.delete(handler);
			},
		},
		createBridge,
	);
	return {
		outbound,
		deliver(message) {
			for (const handler of [...handlers]) handler(message);
		},
	};
}

function unusedBridge(): MessengerSessionBridge {
	throw new Error("This test never creates a session");
}

describe("messenger session process worker", () => {
	test("answers a ping before any session exists", () => {
		const harness = worker(unusedBridge);
		harness.deliver({ type: "ping", id: "probe" });
		expect(harness.outbound).toEqual([{ type: "pong", id: "probe" }]);
	});

	test("creates its session once, relays a turn's activity and reply, and reports a rejected turn without detail", async () => {
		const configs: MessengerConfig[] = [];
		const harness = worker(config => {
			configs.push(config);
			return {
				async reply(incoming, _signal, onActivity) {
					if (incoming.messageId === "broken") throw new Error("PRIVATE_TOOL_OUTPUT");
					onActivity?.("Reading files");
					return `Answer ${incoming.messageId}`;
				},
				async close() {},
			};
		});
		const first = poolConfig();
		const second = { ...poolConfig(), toolNames: [] };
		harness.deliver({ type: "init", id: "1", config: first });
		harness.deliver({ type: "init", id: "2", config: second });
		harness.deliver({ type: "turn", id: "ok", message: message({ messageId: "working" }) });
		harness.deliver({ type: "turn", id: "bad", message: message({ messageId: "broken" }) });
		await flush();
		expect(configs).toEqual([first]);
		expect(harness.outbound).toEqual([
			{ type: "activity", id: "ok", text: "Reading files" },
			{ type: "reply", id: "ok", text: "Answer working" },
			{ type: "failed", id: "bad" },
		]);
		expect(JSON.stringify(harness.outbound)).not.toContain("PRIVATE_");
	});

	test.each(["no init", "a throwing session factory"] as const)(
		"fails a turn when there is no session (%s)",
		async setup => {
			const harness = worker(() => {
				throw new Error("PRIVATE_SDK_DETAIL");
			});
			if (setup === "a throwing session factory") harness.deliver({ type: "init", id: "1", config: poolConfig() });
			harness.deliver({ type: "turn", id: "turn", message: message() });
			await flush();
			expect(harness.outbound).toEqual([{ type: "failed", id: "turn" }]);
		},
	);

	test("abort cancels only the named turn's signal", async () => {
		const signals = new Map<string, AbortSignal>();
		const harness = worker(() => ({
			reply(incoming, signal) {
				signals.set(incoming.messageId, signal);
				const { promise, reject } = Promise.withResolvers<string>();
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				return promise;
			},
			async close() {},
		}));
		harness.deliver({ type: "init", id: "1", config: poolConfig() });
		harness.deliver({ type: "turn", id: "first", message: message({ messageId: "first" }) });
		harness.deliver({ type: "turn", id: "second", message: message({ messageId: "second" }) });
		harness.deliver({ type: "abort", id: "first" });
		await flush();
		expect(signals.get("first")?.aborted).toBe(true);
		expect(signals.get("second")?.aborted).toBe(false);
		expect(harness.outbound).toEqual([{ type: "failed", id: "first" }]);
	});

	test.each(["resolves", "rejects"] as const)(
		"close aborts in-flight turns and acknowledges only after the session close settles (close %s)",
		async outcome => {
			const turnSignal = Promise.withResolvers<AbortSignal>();
			const closing = Promise.withResolvers<void>();
			const harness = worker(() => ({
				reply(_incoming, signal) {
					turnSignal.resolve(signal);
					const { promise, reject } = Promise.withResolvers<string>();
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					return promise;
				},
				close: () => closing.promise,
			}));
			harness.deliver({ type: "init", id: "1", config: poolConfig() });
			harness.deliver({ type: "turn", id: "turn", message: message() });
			const signal = await turnSignal.promise;
			harness.deliver({ type: "close", id: "bye" });
			await flush();
			expect(signal.aborted).toBe(true);
			expect(harness.outbound).toEqual([{ type: "failed", id: "turn" }]);
			if (outcome === "resolves") closing.resolve();
			else closing.reject(new Error("PRIVATE_FLUSH_DETAIL"));
			await flush();
			expect(harness.outbound).toEqual([
				{ type: "failed", id: "turn" },
				{ type: "closed", id: "bye" },
			]);
		},
	);

	test("close is acknowledged even when no session was ever created", async () => {
		const harness = worker(unusedBridge);
		harness.deliver({ type: "close", id: "bye" });
		await flush();
		expect(harness.outbound).toEqual([{ type: "closed", id: "bye" }]);
	});
});
