import { describe, expect, test, vi } from "bun:test";
import { createMessengerSessionPool, type MessengerSessionProcess } from "../src/messenger/session-pool";
import type { MessengerSessionInbound, MessengerSessionOutbound } from "../src/messenger/session-worker";
import type { MessengerConfig, MessengerMessage } from "../src/messenger/types";

const config: MessengerConfig = {
	cwd: "/tmp/messenger-exit-workspace",
	sessionDir: "/tmp/messenger-exit-sessions",
	toolNames: [],
	platforms: { telegram: { tokenEnv: "TOKEN", allowedUserIds: ["alice", "bob"] } },
};

const message: MessengerMessage = {
	platform: "telegram",
	accountId: "account",
	channelId: "room",
	senderId: "alice",
	messageId: "one",
	text: "hello",
	direct: true,
	mentioned: false,
};

/** The close acknowledgement and kill request precede the independently controlled process exit. */
function processFixture(holdClose = false, exitOnKill = false) {
	const processes: Array<{ exit: () => void }> = [];
	let active = 0;
	let maximum = 0;
	const closeRequested = Promise.withResolvers<void>();
	const allowClose = Promise.withResolvers<void>();
	if (!holdClose) allowClose.resolve();
	const killed = Promise.withResolvers<void>();
	const spawn = (): MessengerSessionProcess => {
		const exited = Promise.withResolvers<void>();
		const listeners = new Set<(event: MessengerSessionOutbound) => void>();
		let alive = true;
		active++;
		maximum = Math.max(maximum, active);
		const exit = (): void => {
			if (!alive) return;
			alive = false;
			active--;
			exited.resolve();
		};
		processes.push({ exit });
		return {
			exited: exited.promise,
			onMessage(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			send(event: MessengerSessionInbound) {
				if (event.type === "turn")
					queueMicrotask(() => {
						for (const listener of listeners) listener({ type: "reply", id: event.id, text: "answer" });
					});
				if (event.type === "close") {
					closeRequested.resolve();
					void allowClose.promise.then(() => {
						for (const listener of listeners) listener({ type: "closed", id: event.id });
					});
				}
			},
			kill() {
				killed.resolve();
				if (exitOnKill) exit();
			},
		};
	};
	return {
		spawn,
		processes,
		killed: killed.promise,
		closeRequested: closeRequested.promise,
		allowClose: allowClose.resolve,
		counts: () => ({ active, maximum }),
	};
}

async function flush(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

describe("messenger session process exit", () => {
	test("eviction does not start a replacement until the retired process actually exits", async () => {
		const fixture = processFixture();
		const pool = createMessengerSessionPool(config, { maxProcesses: 1, idleMs: 60_000, spawn: fixture.spawn });
		try {
			expect(await pool.reply(message, new AbortController().signal)).toBe("answer");
			const next = pool.reply({ ...message, senderId: "bob", messageId: "two" }, new AbortController().signal);
			await fixture.killed;
			await flush();
			expect(fixture.processes).toHaveLength(1);
			fixture.processes[0]!.exit();
			expect(await next).toBe("answer");
			expect(fixture.processes).toHaveLength(2);
		} finally {
			for (const process of fixture.processes) process.exit();
			await pool.close();
		}
	});

	test("shutdown waits for a killed process to actually exit", async () => {
		const fixture = processFixture();
		const pool = createMessengerSessionPool(config, { maxProcesses: 1, idleMs: 60_000, spawn: fixture.spawn });
		try {
			expect(await pool.reply(message, new AbortController().signal)).toBe("answer");
			let closed = false;
			const closing = pool.close().then(() => {
				closed = true;
			});
			await fixture.killed;
			await flush();
			expect(closed).toBe(false);
			fixture.processes[0]!.exit();
			await closing;
			expect(closed).toBe(true);
		} finally {
			for (const process of fixture.processes) process.exit();
			await pool.close();
		}
	});
	test("shutdown waits for retirement already underway before acknowledgement and exit", async () => {
		const fixture = processFixture(true);
		const pool = createMessengerSessionPool(config, { maxProcesses: 1, idleMs: 60_000, spawn: fixture.spawn });
		try {
			expect(await pool.reply(message, new AbortController().signal)).toBe("answer");
			const next = pool
				.reply({ ...message, senderId: "bob", messageId: "two" }, new AbortController().signal)
				.catch(() => undefined);
			await fixture.closeRequested;
			let closed = false;
			const closing = pool.close().then(() => {
				closed = true;
			});
			await flush();
			expect(closed).toBe(false);
			fixture.allowClose();
			await fixture.killed;
			await flush();
			expect(closed).toBe(false);
			fixture.processes[0]!.exit();
			await closing;
			await next;
			expect(closed).toBe(true);
		} finally {
			fixture.allowClose();
			for (const process of fixture.processes) process.exit();
			await pool.close();
		}
	});

	test("a process that does not exit blocks capacity and causes shutdown to report failure", async () => {
		const fixture = processFixture();
		const pool = createMessengerSessionPool(config, { maxProcesses: 1, idleMs: 60_000, spawn: fixture.spawn });
		try {
			expect(await pool.reply(message, new AbortController().signal)).toBe("answer");
			vi.useFakeTimers();
			const next = pool.reply({ ...message, senderId: "bob", messageId: "two" }, new AbortController().signal);
			const outcome = next.then(
				() => undefined,
				error => error,
			);
			await fixture.killed;
			vi.advanceTimersByTime(5_000);
			expect(await outcome).toBeInstanceOf(Error);
			expect(fixture.processes).toHaveLength(1);
			const controller = new AbortController();
			const waiting = pool.reply({ ...message, senderId: "bob", messageId: "three" }, controller.signal);
			const waitingOutcome = waiting.then(
				() => undefined,
				error => error,
			);
			await Promise.resolve();
			await Promise.resolve();
			expect(fixture.processes).toHaveLength(1);
			controller.abort();
			expect(await waitingOutcome).toBeInstanceOf(Error);
			await expect(pool.close()).rejects.toThrow();
			expect(fixture.processes).toHaveLength(1);
		} finally {
			for (const process of fixture.processes) process.exit();
			vi.useRealTimers();
			await pool.close().catch(() => {});
		}
	});

	test("a timed-out retirement prevents its conversation from starting a second live process despite spare capacity", async () => {
		const fixture = processFixture();
		const pool = createMessengerSessionPool(config, { maxProcesses: 2, idleMs: 60_000, spawn: fixture.spawn });
		try {
			expect(await pool.reply(message, new AbortController().signal)).toBe("answer");
			expect(await pool.reply({ ...message, senderId: "bob" }, new AbortController().signal)).toBe("answer");
			vi.useFakeTimers();
			const evicting = pool
				.reply({ ...message, senderId: "carol" }, new AbortController().signal)
				.catch(error => error);
			await fixture.killed;
			vi.advanceTimersByTime(5_000);
			expect(await evicting).toBeInstanceOf(Error);
			fixture.processes[1]!.exit();
			await Promise.resolve();
			const retry = pool
				.reply({ ...message, messageId: "retry" }, new AbortController().signal)
				.catch(error => error);
			vi.useRealTimers();
			await flush();
			expect(fixture.processes).toHaveLength(2);
			fixture.processes[0]!.exit();
			await retry;
		} finally {
			vi.useRealTimers();
			for (const process of fixture.processes) process.exit();
			await pool.close().catch(() => {});
		}
	});

	test("aborting while a process starts never delivers a turn to that process", async () => {
		const fixture = processFixture(false, true);
		const controller = new AbortController();
		const turns: MessengerSessionInbound[] = [];
		const pool = createMessengerSessionPool(config, {
			maxProcesses: 1,
			idleMs: 60_000,
			spawn: () => {
				const child = fixture.spawn();
				controller.abort();
				return {
					...child,
					send(event) {
						if (event.type === "turn") turns.push(event);
						child.send(event);
					},
				};
			},
		});
		try {
			await expect(pool.reply(message, controller.signal)).rejects.toThrow();
			expect(turns).toEqual([]);
		} finally {
			for (const process of fixture.processes) process.exit();
			await pool.close().catch(() => {});
		}
	});

	test("repeated conversation eviction never exceeds capacity and shutdown leaves no live processes", async () => {
		const fixture = processFixture(false, true);
		const pool = createMessengerSessionPool(config, { maxProcesses: 1, idleMs: 60_000, spawn: fixture.spawn });
		try {
			for (let index = 0; index < 30; index++) {
				const input = { ...message, senderId: `sender-${index}`, messageId: `message-${index}` };
				expect(await pool.reply(input, new AbortController().signal)).toBe("answer");
			}
			await pool.close();
			expect(fixture.counts()).toEqual({ active: 0, maximum: 1 });
		} finally {
			for (const process of fixture.processes) process.exit();
			await pool.close();
		}
	});
});
