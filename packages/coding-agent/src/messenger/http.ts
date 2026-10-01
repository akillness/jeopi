export class MessengerHttpError extends Error {
	constructor(
		readonly status: number,
		readonly retryAfterMs?: number,
	) {
		super(`Messenger request failed (HTTP ${status})`);
		this.name = "MessengerHttpError";
	}
}

/** Provider limits count UTF-16 units; do not bisect supplementary characters. */
export function splitMessengerText(text: string, limit: number): string[] {
	if (!Number.isSafeInteger(limit) || limit < 2)
		throw new Error("Message chunk limit must be an integer of at least two");
	const chunks: string[] = [];
	for (let start = 0; start < text.length; ) {
		let end = Math.min(start + limit, text.length);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
		chunks.push(text.slice(start, end));
		start = end;
	}
	return chunks;
}

export async function messengerFetchJson(
	url: string,
	init: RequestInit,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
	const signals = [AbortSignal.timeout(35_000)];
	if (signal) signals.push(signal);
	if (init.signal) signals.push(init.signal);
	const requestSignal = AbortSignal.any(signals);
	try {
		const response = await fetchImpl(url, { ...init, redirect: "error", signal: requestSignal });
		if (!response.ok) {
			let retryAfterMs: number | undefined;
			if (response.status === 429) {
				let seconds = Number(response.headers.get("retry-after"));
				if (!seconds) {
					try {
						const body: unknown = await response.json();
						if (typeof body === "object" && body !== null) {
							if ("retry_after" in body && typeof body.retry_after === "number") {
								seconds = body.retry_after;
							} else if (
								"parameters" in body &&
								typeof body.parameters === "object" &&
								body.parameters !== null &&
								"retry_after" in body.parameters &&
								typeof body.parameters.retry_after === "number"
							) {
								seconds = body.parameters.retry_after;
							}
						}
					} catch {
						/* Retry metadata is optional; never surface provider response text. */
					}
				}
				// Larger delays overflow native timers into immediate retries.
				if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = Math.min(seconds * 1000, 2_147_483_647);
			}
			if (!response.bodyUsed) await response.body?.cancel();
			throw new MessengerHttpError(response.status, retryAfterMs);
		}
		return await response.json();
	} catch (error) {
		if (error instanceof MessengerHttpError) throw error;
		if (signal?.aborted || init.signal?.aborted) throw new Error("Messenger request cancelled");
		throw new Error("Messenger request failed");
	}
}

export async function waitForMessengerRetry(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	const done = (): void => {
		clearTimeout(timer);
		signal.removeEventListener("abort", done);
		resolve();
	};
	const timer = setTimeout(done, ms);
	signal.addEventListener("abort", done, { once: true });
	await promise;
}
