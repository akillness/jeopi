import { describe, expect, it } from "bun:test";
import { fetchWithRetry } from "jeopi-utils/fetch-retry";

describe("fetchWithRetry", () => {
	for (const status of [429, 503]) {
		it(`returns HTTP ${status} when retry inspection cannot read the body, leaving the original body failure observable`, async () => {
			let attempts = 0;
			const bodyError = new Error("Synthetic retry body disconnected");
			const original = new Response(
				new ReadableStream({
					start(controller) {
						controller.error(bodyError);
					},
				}),
				{ status },
			);
			const response = await fetchWithRetry("https://example.invalid/unreadable", {
				maxAttempts: 3,
				defaultDelayMs: 0,
				fetch: async () => {
					attempts += 1;
					return original;
				},
			});

			expect(response).toBe(original);
			expect(response.status).toBe(status);
			await expect(response.text()).rejects.toBe(bodyError);
			expect(attempts).toBe(1);
		});

		it(`does not swallow caller cancellation while inspecting an unreadable HTTP ${status} body`, async () => {
			const abort = new AbortController();
			let attempts = 0;
			const request = fetchWithRetry("https://example.invalid/cancelled-body", {
				signal: abort.signal,
				maxAttempts: 3,
				defaultDelayMs: 0,
				fetch: async () => {
					attempts += 1;
					return new Response(
						new ReadableStream(
							{
								pull(controller) {
									abort.abort();
									controller.error(new Error("Synthetic cancelled body disconnected"));
								},
							},
							{ highWaterMark: 0 },
						),
						{ status },
					);
				},
			});

			await expect(request).rejects.toThrow("Request was aborted");
			expect(attempts).toBe(1);
		});
	}

	it("routes requests through the `fetch` override when provided", async () => {
		const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
		const customFetch = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/x", {
			method: "POST",
			body: "hi",
			fetch: customFetch,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://example.invalid/x");
		expect(calls[0]?.init).toMatchObject({ method: "POST", body: "hi" });
	});

	it("retries through the override on transient failures", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			if (attempt === 1) return new Response("", { status: 503 });
			return new Response("done", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/y", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("done");
		expect(attempt).toBe(2);
	});

	it("lets callers stop retries for deterministic response bodies", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("deterministic provider failure", { status: 500 });
		};

		const response = await fetchWithRetry("https://example.invalid/z", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			shouldRetryResponse: (_response, bodyText) => !bodyText.includes("deterministic"),
		});

		expect(response.status).toBe(500);
		expect(await response.text()).toBe("deterministic provider failure");
		expect(attempt).toBe(1);
	});

	it("returns retryable responses immediately when retry hints exceed the delay cap", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } });
		};

		const response = await fetchWithRetry("https://example.invalid/rate-limit", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			maxDelayMs: 10,
		});

		expect(response.status).toBe(429);
		expect(await response.text()).toBe("slow down");
		expect(attempt).toBe(1);
	});
});
