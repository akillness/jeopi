import * as path from "node:path";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	smokeTestWorker,
	type WorkerHandle,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import { messengerSessionRoute } from "./gateway";
import type { MessengerSessionInbound, MessengerSessionOutbound } from "./session-worker";
import type { MessengerActivityReporter, MessengerConfig, MessengerMessage, MessengerReply } from "./types";

/** Hidden CLI selector that re-enters jeopi as one conversation's session process (dispatched in `cli.ts`). */
export const MESSENGER_SESSION_WORKER_ARG = "__omp_worker_messenger_session";

const MAX_SESSION_PROCESSES = 8;
const SESSION_IDLE_MS = 10 * 60_000;
/** Bound on a session process flushing and disposing its session before it is killed. */
const SESSION_CLOSE_TIMEOUT_MS = 5_000;

/** One conversation's jeopi session process, as the pool sees it. */
export interface MessengerSessionProcess {
	send(message: MessengerSessionInbound): void;
	onMessage(handler: (message: MessengerSessionOutbound) => void): () => void;
	/** Settles when the process has exited for any reason. */
	exited: Promise<unknown>;
	kill(): void;
}

/** Session processes start without the configured platform token variables. Not OS isolation: tools run as the same user. */
function sessionEnv(config: MessengerConfig): Record<string, string> {
	const secrets = new Set<string>();
	for (const platform of Object.values(config.platforms)) {
		if (!platform) continue;
		secrets.add(platform.tokenEnv);
		if (platform.appTokenEnv) secrets.add(platform.appTokenEnv);
	}
	return Object.fromEntries(Object.entries(workerEnvFromParent()).filter(([key]) => !secrets.has(key)));
}

function spawnSessionHandle(
	env: Record<string, string>,
): WorkerHandle<MessengerSessionInbound, MessengerSessionOutbound> & { exited: Promise<unknown> } {
	const spawned = createWorkerSubprocess<MessengerSessionOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(MESSENGER_SESSION_WORKER_ARG),
		env,
		exitLabel: "messenger session process",
	});
	return {
		...createWorkerHandle<MessengerSessionInbound, MessengerSessionOutbound>(spawned, message =>
			spawned.proc.send(message),
		),
		exited: spawned.proc.exited,
	};
}

/** Spawn a real session process (the pool's default). */
export function spawnMessengerSessionProcess(config: MessengerConfig): MessengerSessionProcess {
	const handle = spawnSessionHandle(sessionEnv(config));
	return {
		send: handle.send,
		onMessage: handler => handle.onMessage(handler),
		exited: handle.exited,
		kill: () => void handle.terminate(),
	};
}

/** `jeopi --smoke-test` probe: the session process loads its module graph and answers over IPC. */
export async function smokeTestMessengerSessionWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(spawnSessionHandle(workerEnvFromParent()), "messenger session process", timeoutMs);
}

export interface MessengerSessionPoolOptions {
	/** Resident session processes; at the limit a new conversation retires the least recently used idle one. */
	maxProcesses?: number;
	/** Idle time after which a conversation's process exits; its session file keeps the history. */
	idleMs?: number;
	/** Test seam: start one conversation's session process. */
	spawn?: (config: MessengerConfig) => MessengerSessionProcess;
}

export interface MessengerSessionPool {
	reply: MessengerReply;
	close(): Promise<void>;
}

interface LiveSession {
	process: MessengerSessionProcess;
	/** Rejects the in-flight turn when the process dies under it. */
	failTurn?: (error: Error) => void;
	lastUsed: number;
	/** Its capacity slot was returned; set once. */
	released: boolean;
}

interface Lane {
	route: string;
	/** Settles after this conversation's latest queued job: jobs run strictly one after another. */
	tail: Promise<unknown>;
	/** Turns queued or running; idle retirement waits for zero. */
	turns: number;
	live?: LiveSession;
	idle?: NodeJS.Timeout;
	/** Already chosen to free a slot, so concurrent starts pick different victims. */
	evicting?: boolean;
}

/**
 * Give every conversation (a Discord thread or DM, a Telegram chat or topic, a Slack thread) its own jeopi
 * session process: the first message starts it, later turns reuse it, and it exits after idling; the next
 * message resumes the persisted session in a fresh process. Turns of one conversation run strictly in order
 * (including retirement), while different conversations run concurrently. At most `maxProcesses` processes
 * are resident: a new conversation waits for the least recently used idle one to retire, or for a slot.
 */
export function createMessengerSessionPool(
	config: MessengerConfig,
	options: MessengerSessionPoolOptions = {},
): MessengerSessionPool {
	const maxProcesses = Math.max(1, options.maxProcesses ?? MAX_SESSION_PROCESSES);
	const idleMs = Math.max(0, options.idleMs ?? SESSION_IDLE_MS);
	const spawn = options.spawn ?? spawnMessengerSessionProcess;
	const cwd = path.resolve(config.cwd);
	const lanes = new Map<string, Lane>();
	const waiters = new Set<() => void>();
	let resident = 0;
	let nextId = 0;
	let closed = false;
	let closing: Promise<void> | undefined;

	const enqueue = <T>(lane: Lane, job: () => Promise<T>): Promise<T> => {
		const run = lane.tail.then(job);
		lane.tail = run.catch(() => {});
		return run;
	};

	/** A slot freed or a conversation went idle: let waiting starts re-check capacity. */
	const capacityChanged = (): void => {
		for (const wake of [...waiters]) wake();
	};

	const release = (live: LiveSession): void => {
		if (live.released) return;
		live.released = true;
		resident--;
		capacityChanged();
	};

	/** Let the process flush and dispose its session, then kill it; the session file stays for resumption. */
	const retire = async (lane: Lane): Promise<void> => {
		const live = lane.live;
		if (!live) return;
		lane.live = undefined;
		const id = String(++nextId);
		const acknowledged = Promise.withResolvers<void>();
		const unsubscribe = live.process.onMessage(event => {
			if (event.type === "closed" && event.id === id) acknowledged.resolve();
		});
		const timer = setTimeout(acknowledged.resolve, SESSION_CLOSE_TIMEOUT_MS);
		try {
			live.process.send({ type: "close", id });
			await Promise.race([acknowledged.promise, live.process.exited]);
		} catch {
			// The process is already gone; killing it below is still safe.
		} finally {
			clearTimeout(timer);
			unsubscribe();
			live.process.kill();
			release(live);
		}
	};

	const retireIfIdle = async (lane: Lane): Promise<void> => {
		try {
			if (lane.turns > 0) return;
			await retire(lane);
			if (lane.turns === 0 && !lane.live && lanes.get(lane.route) === lane) {
				clearTimeout(lane.idle);
				lanes.delete(lane.route);
			}
		} finally {
			lane.evicting = false;
		}
	};

	const leastRecentlyUsedIdle = (): Lane | undefined => {
		let victim: Lane | undefined;
		let oldest = Number.POSITIVE_INFINITY;
		for (const lane of lanes.values()) {
			if (!lane.live || lane.turns > 0 || lane.evicting || lane.live.lastUsed >= oldest) continue;
			oldest = lane.live.lastUsed;
			victim = lane;
		}
		return victim;
	};

	const waitForCapacity = async (signal: AbortSignal): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const wake = (): void => resolve();
		waiters.add(wake);
		signal.addEventListener("abort", wake, { once: true });
		try {
			await promise;
		} finally {
			waiters.delete(wake);
			signal.removeEventListener("abort", wake);
		}
	};

	/** Start a conversation's process without exceeding `maxProcesses`; the check and spawn are atomic. */
	const start = async (lane: Lane, signal: AbortSignal): Promise<LiveSession> => {
		for (;;) {
			if (closed || signal.aborted) throw new Error("Messenger session unavailable");
			if (resident < maxProcesses) break;
			const victim = leastRecentlyUsedIdle();
			if (victim) {
				victim.evicting = true;
				await enqueue(victim, () => retireIfIdle(victim));
			} else {
				await waitForCapacity(signal);
			}
		}
		const child = spawn(config);
		resident++;
		const live: LiveSession = { process: child, lastUsed: Date.now(), released: false };
		lane.live = live;
		const onExit = (): void => {
			live.failTurn?.(new Error("Messenger session process exited"));
			if (lane.live === live) lane.live = undefined;
			release(live);
		};
		void child.exited.then(onExit, onExit);
		child.send({ type: "init", id: String(++nextId), config });
		return live;
	};

	const runTurn = async (
		lane: Lane,
		message: MessengerMessage,
		signal: AbortSignal,
		onActivity: MessengerActivityReporter | undefined,
	): Promise<string> => {
		if (closed || signal.aborted) throw new Error("Messenger session unavailable");
		const id = String(++nextId);
		const result = Promise.withResolvers<string>();
		// Abort, IPC events and process exit may each settle it, possibly after the turn already failed elsewhere.
		result.promise.catch(() => {});
		let live = lane.live;
		let unsubscribe: (() => void) | undefined;
		const onAbort = (): void => {
			try {
				live?.process.send({ type: "abort", id });
			} catch {
				// Already gone: retirement below reaps it.
			}
			result.reject(new Error("Messenger request aborted"));
		};
		try {
			live ??= await start(lane, signal);
			const current = live;
			current.failTurn = result.reject;
			unsubscribe = current.process.onMessage(event => {
				if (event.id !== id) return;
				if (event.type === "activity") onActivity?.(event.text);
				else if (event.type === "reply") result.resolve(event.text);
				else if (event.type === "failed") result.reject(new Error("Messenger session turn failed"));
			});
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			try {
				current.process.send({ type: "turn", id, message });
			} catch (error) {
				result.reject(error);
			}
			return await result.promise;
		} catch (error) {
			// A failed, aborted or crashed turn may leave its session unusable: the next turn resumes the
			// persisted session in a fresh process, after this one has flushed.
			await retire(lane);
			throw error;
		} finally {
			signal.removeEventListener("abort", onAbort);
			unsubscribe?.();
			if (live) {
				live.failTurn = undefined;
				live.lastUsed = Date.now();
			}
		}
	};

	const reply: MessengerReply = async (message, signal, onActivity) => {
		if (closed || signal.aborted) throw new Error("Messenger session unavailable");
		const route = messengerSessionRoute(cwd, message);
		let lane = lanes.get(route);
		if (!lane) {
			lane = { route, tail: Promise.resolve(), turns: 0 };
			lanes.set(route, lane);
		}
		const current = lane;
		clearTimeout(current.idle);
		current.turns++;
		try {
			return await enqueue(current, () => runTurn(current, message, signal, onActivity));
		} finally {
			current.turns--;
			if (current.turns === 0 && !closed) {
				current.idle = setTimeout(() => void enqueue(current, () => retireIfIdle(current)), idleMs);
				current.idle.unref?.();
				capacityChanged();
			}
		}
	};

	const close = (): Promise<void> => {
		closing ??= (async () => {
			closed = true;
			capacityChanged();
			const all = [...lanes.values()];
			lanes.clear();
			for (const lane of all) clearTimeout(lane.idle);
			await Promise.allSettled(all.map(retire));
		})();
		return closing;
	};

	return { reply, close };
}
