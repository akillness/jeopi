import assert from "node:assert/strict";

export class AbortError extends Error {
	constructor(signal: AbortSignal) {
		assert(signal.aborted, "Abort signal must be aborted");

		const message = signal.reason instanceof Error ? signal.reason.message : "Cancelled";
		super(`Aborted: ${message}`, { cause: signal.reason });
		this.name = "AbortError";
	}
}
export class IdleTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Stream idle timeout exceeded: no chunk received for ${timeoutMs}ms`);
		this.name = "IdleTimeoutError";
	}
}

/**
 * Abortable async iteration over a {@link ReadableStream}. Reads the source
 * reader directly and yields each chunk, so the consumer's `for await` drives a
 * single read loop with no intermediate stream or per-chunk enqueue.
 *
 * Unlike `stream.pipeThrough(..., { signal })`, this explicitly cancels the
 * source reader on abort or early `break`, propagating HTTP-client disconnects
 * and watchdog timeouts to the backend request instead of only stopping the
 * local consumer. On abort it throws {@link AbortError}; the lock is released
 * on completion, abort, throw, or early exit. The source is cancelled only on
 * abort or early exit — never on natural EOF.
 */
export async function* abortableSource<T>(
	stream: ReadableStream<T>,
	signal?: AbortSignal,
	idleTimeoutMs?: number,
): AsyncGenerator<T> {
	if (signal?.aborted) throw new AbortError(signal);
	const reader = stream.getReader();
	let onAbort: (() => void) | undefined;
	if (signal) {
		onAbort = () => {
			void reader.cancel(signal.reason).catch(() => {});
		};
		signal.addEventListener("abort", onAbort, { once: true });
	}
	let completed = false;
	let timedOutError: IdleTimeoutError | undefined;
	const hasIdleTimeout = idleTimeoutMs !== undefined && Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0;
	try {
		for (;;) {
			const rawReadPromise = reader.read();
			let readPromise = rawReadPromise;
			let timeoutId: NodeJS.Timeout | undefined;
			if (hasIdleTimeout) {
				const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
				timeoutId = setTimeout(() => {
					const err = new IdleTimeoutError(idleTimeoutMs);
					timedOutError = err;
					rawReadPromise.catch(() => {});
					reject(err);
				}, idleTimeoutMs);
				timeoutId.unref?.();
				readPromise = Promise.race([rawReadPromise, timeoutPromise]);
			}
			let result: { done: true; value?: T } | { done: false; value: T };
			try {
				result = await readPromise;
			} finally {
				clearTimeout(timeoutId);
			}
			if (signal?.aborted) throw new AbortError(signal);
			if (result.done) {
				completed = true;
				return;
			}
			yield result.value;
		}
	} finally {
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		// Propagate early-exit (`break`/`return`), timeout, and abort to the backend;
		// skip on natural EOF where the stream already closed itself. Bound the wait
		// so a stalled underlying stream cannot hang `cancel()` forever.
		if (!completed && !signal?.aborted) {
			let cancelTimer: NodeJS.Timeout | undefined;
			const { promise: cancelTimeout, resolve: resolveCancelTimeout } = Promise.withResolvers<void>();
			cancelTimer = setTimeout(resolveCancelTimeout, 250);
			cancelTimer.unref?.();
			try {
				await Promise.race([reader.cancel(timedOutError).catch(() => {}), cancelTimeout]);
			} catch {
			} finally {
				clearTimeout(cancelTimer);
			}
		}
		try {
			reader.releaseLock();
		} catch {}
	}
}

/**
 * Runs a promise-returning function (`pr`). If the given AbortSignal is aborted before or during
 * execution, the promise is rejected with a standard error.
 *
 * @param signal - Optional AbortSignal to cancel the operation
 * @param pr - Function returning a promise to run
 * @returns Promise resolving as `pr` would, or rejecting on abort
 */
export function untilAborted<T>(
	signal: AbortSignal | undefined | null,
	pr: Promise<T> | (() => Promise<T>),
): Promise<T> {
	if (!signal) return typeof pr === "function" ? pr() : pr;
	if (signal.aborted) return Promise.reject(new AbortError(signal));

	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const onAbort = () => reject(new AbortError(signal));
	signal.addEventListener("abort", onAbort, { once: true });

	void (async () => {
		try {
			resolve(await (typeof pr === "function" ? pr() : pr));
		} catch (err) {
			reject(err);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	})();

	return promise;
}

/**
 * Memoizes a function with no arguments, calling it once and caching the result.
 *
 * @param fn - Function to be called once
 * @returns A function that returns the cached result of `fn`
 */
export function once<T>(fn: () => T): () => T {
	let store = undefined as { value: T } | undefined;
	return () => {
		if (store) {
			return store.value;
		}
		const value = fn();
		store = { value };
		return value;
	};
}
