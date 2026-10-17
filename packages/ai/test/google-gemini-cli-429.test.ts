import { describe, expect, it } from "bun:test";
import * as AIError from "jeopi-ai/error";
import { parseRateLimitReason } from "jeopi-ai/error/rate-limit";
import { streamGoogleGeminiCli } from "jeopi-ai/providers/google-gemini-cli";
import type { Context, FetchImpl, Model } from "jeopi-ai/types";
import { buildModel } from "jeopi-catalog/build";
import { extractRetryHint } from "jeopi-utils";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const cliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (CCA)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const individualQuotaBody = JSON.stringify({
	error: {
		code: 429,
		message:
			"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 28h48m25s.",
		status: "RESOURCE_EXHAUSTED",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.ErrorInfo",
				reason: "QUOTA_EXHAUSTED",
				domain: "cloudcode-pa.googleapis.com",
				metadata: {
					uiMessage: "true",
					model: "gemini-3-flash-agent",
					quotaResetDelay: "28h48m25.991228095s",
					quotaResetTimeStamp: "2026-07-03T18:44:59Z",
				},
			},
			{
				"@type": "type.googleapis.com/google.rpc.RetryInfo",
				retryDelay: "103705.991228095s",
			},
		],
	},
});

const genericQuotaMessage = "Resource has been exhausted (e.g. check quota).";
const genericQuotaBody = JSON.stringify({
	error: { code: 429, status: "RESOURCE_EXHAUSTED", message: genericQuotaMessage },
});
const credentials = JSON.stringify({ token: "synthetic-token", projectId: "synthetic-project" });
const productionEndpoint = "https://daily-cloudcode-pa.googleapis.com";
const sandboxEndpoint = "https://daily-cloudcode-pa.sandbox.googleapis.com";

function sse(chunk: unknown): Response {
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function emptySse(url: string): Response {
	const response = new Response("", { headers: { "content-type": "text/event-stream" } });
	// Fetch responses carry the URL used by the provider's empty-stream retry.
	Object.defineProperty(response, "url", { value: url });
	return response;
}

function success(): Response {
	return sse({
		response: {
			candidates: [{ content: { parts: [{ text: "recovered" }] }, finishReason: "STOP" }],
		},
	});
}
type RetryBodyController = (controller: ReadableStreamDefaultController<Uint8Array> | undefined) => void;

function stalledHeaders(signal: AbortSignal | null | undefined): Promise<Response> {
	const { promise, reject } = Promise.withResolvers<Response>();
	signal?.addEventListener(
		"abort",
		() => reject(signal.reason ?? new DOMException("Synthetic headers aborted", "AbortError")),
		{ once: true },
	);
	return promise;
}

function stalledErrorBody(
	signal: AbortSignal | null | undefined,
	status: number,
	setController: RetryBodyController,
): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				setController(controller);
				signal?.addEventListener(
					"abort",
					() => {
						controller.error(signal.reason ?? new DOMException("Synthetic body aborted", "AbortError"));
						setController(undefined);
					},
					{ once: true },
				);
			},
			cancel() {
				setController(undefined);
			},
		}),
		{ status },
	);
}

describe("google-gemini-cli quota versus transient 429 transport", () => {
	for (const quota of [
		{ name: "explicit quota", body: individualQuotaBody, message: "Individual quota reached." },
		{
			name: "structured quota with transient-looking wording",
			body: JSON.stringify({
				error: {
					code: 429,
					status: "RESOURCE_EXHAUSTED",
					message: "Resource exhausted. Please try again later.",
					details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }],
				},
			}),
			message: "Resource exhausted. Please try again later.",
		},
	]) {
		it(`does not send an exhausted credential to sandbox after empty SSE retries into ${quota.name}`, async () => {
			const requests: string[] = [];
			const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
				apiKey: credentials,
				antigravityEndpointMode: "auto",
				maxRetryDelayMs: 0,
				fetch: async input => {
					const url = String(input);
					requests.push(url);
					if (requests.length === 1) return emptySse(url);
					if (requests.length === 2) return new Response(quota.body, { status: 429 });
					return success();
				},
			}).result();

			expect({
				requests,
				stopReason: result.stopReason,
				status: result.errorStatus,
				usageLimit: ((result.errorId ?? 0) & AIError.Flag.UsageLimit) !== 0,
			}).toEqual({
				requests: Array.from({ length: 2 }, () => `${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`),
				stopReason: "error",
				status: 429,
				usageLimit: true,
			});
			expect(result.errorMessage).toContain(quota.message);
		}, 5_000);
	}

	for (const mode of ["production", "auto"] as const) {
		it(`preserves per-minute semantics after empty SSE retry in ${mode} mode`, async () => {
			const requests: string[] = [];
			const message = "Requests per minute exceeded. Please retry.";
			const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
				apiKey: credentials,
				antigravityEndpointMode: mode,
				maxRetryDelayMs: 0,
				fetch: async input => {
					const url = String(input);
					requests.push(url);
					if (requests.length === 1) return emptySse(url);
					if (requests.length === 2) {
						return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message } }), {
							status: 429,
						});
					}
					return success();
				},
			}).result();

			if (mode === "auto") {
				expect(result.stopReason).toBe("stop");
				expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
			} else {
				expect({
					stopReason: result.stopReason,
					status: result.errorStatus,
					transient: ((result.errorId ?? 0) & AIError.Flag.Transient) !== 0,
					usageLimit: ((result.errorId ?? 0) & AIError.Flag.UsageLimit) !== 0,
				}).toEqual({ stopReason: "error", status: 429, transient: true, usageLimit: false });
				expect(parseRateLimitReason(result.errorMessage ?? "")).toBe("RATE_LIMIT_EXCEEDED");
				expect(result.errorMessage).toContain(message);
			}
			expect(requests).toEqual([
				`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
				`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
				...(mode === "auto" ? [`${sandboxEndpoint}/v1internal:streamGenerateContent?alt=sse`] : []),
			]);
		}, 5_000);
	}

	for (const mode of ["production", "auto"] as const) {
		for (const status of [429, 503]) {
			for (const cancelled of [false, true]) {
				it(`${cancelled ? "preserves cancellation" : "retains HTTP status"} when ${mode}'s terminal HTTP ${status} body cannot be read`, async () => {
					const abort = new AbortController();
					const requests: string[] = [];
					const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
						apiKey: credentials,
						antigravityEndpointMode: mode,
						maxRetryDelayMs: 0,
						signal: abort.signal,
						fetch: async input => {
							requests.push(String(input));
							if (mode === "auto" && requests.length === 1) return new Response("Unavailable", { status: 503 });
							return new Response(
								new ReadableStream(
									{
										pull(controller) {
											if (cancelled) abort.abort();
											controller.error(new Error("Synthetic terminal body disconnected"));
										},
									},
									{ highWaterMark: 0 },
								),
								{ status },
							);
						},
					}).result();

					if (cancelled) {
						expect(result.stopReason).toBe("aborted");
					} else {
						expect({ stopReason: result.stopReason, status: result.errorStatus }).toEqual({
							stopReason: "error",
							status,
						});
						expect(result.errorMessage).toContain(
							`Cloud Code Assist API error (${status}): Could not read response body`,
						);
					}
					expect(requests).toEqual([
						`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
						...(mode === "auto" ? [`${sandboxEndpoint}/v1internal:streamGenerateContent?alt=sse`] : []),
					]);
				});
			}
		}
	}

	it("surfaces generic Google RESOURCE_EXHAUSTED without RetryInfo as UsageLimit after one fetch", async () => {
		let calls = 0;
		const result = await streamGoogleGeminiCli(cliModel, context, {
			apiKey: credentials,
			maxRetryDelayMs: 0,
			fetch: async () => {
				calls += 1;
				return new Response(genericQuotaBody, { status: 429 });
			},
		}).result();

		expect({
			calls,
			stopReason: result.stopReason,
			status: result.errorStatus,
			usageLimit: ((result.errorId ?? 0) & AIError.Flag.UsageLimit) !== 0,
			reason: parseRateLimitReason(result.errorMessage ?? ""),
		}).toEqual({ calls: 1, stopReason: "error", status: 429, usageLimit: true, reason: "QUOTA_EXHAUSTED" });
		expect(result.errorMessage).toContain(genericQuotaMessage);
	});

	for (const transport of ["response", "stream error", "generic stream error"] as const) {
		it(`does not send an exhausted credential to sandbox after a quota ${transport}`, async () => {
			const requests: string[] = [];
			const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
				apiKey: credentials,
				antigravityEndpointMode: "auto",
				maxRetryDelayMs: 0,
				fetch: async input => {
					requests.push(String(input));
					if (requests.length > 1) return success();
					return transport === "response"
						? new Response(individualQuotaBody, { status: 429 })
						: sse(JSON.parse(transport === "generic stream error" ? genericQuotaBody : individualQuotaBody));
				},
			}).result();

			expect(requests).toEqual([`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`]);
			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(429);
			expect((result.errorId ?? 0) & AIError.Flag.UsageLimit).toBe(AIError.Flag.UsageLimit);
			expect(result.errorMessage).toContain(
				transport === "generic stream error" ? genericQuotaMessage : "Individual quota reached.",
			);
		});
	}

	for (const transport of ["HTTP", "pre-content SSE"] as const) {
		it(`honors structured QUOTA_EXHAUSTED over transient-looking wording for ${transport}`, async () => {
			const requests: string[] = [];
			const body = {
				error: {
					code: 429,
					status: "RESOURCE_EXHAUSTED",
					message: "Resource exhausted. Please try again later.",
					details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }],
				},
			};
			const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
				apiKey: credentials,
				antigravityEndpointMode: "auto",
				maxRetryDelayMs: 0,
				streamFirstEventTimeoutMs: 250,
				fetch: async input => {
					requests.push(String(input));
					if (requests.length > 1) return success();
					return transport === "HTTP" ? new Response(JSON.stringify(body), { status: 429 }) : sse(body);
				},
			}).result();

			expect({
				requests,
				stopReason: result.stopReason,
				status: result.errorStatus,
				usageLimit: ((result.errorId ?? 0) & AIError.Flag.UsageLimit) !== 0,
			}).toEqual({
				requests: [`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`],
				stopReason: "error",
				status: 429,
				usageLimit: true,
			});
			expect(result.errorMessage).toContain(body.error.message);
		});
	}

	for (const status of [503, 429]) {
		it(`falls back to healthy sandbox when the first HTTP ${status} error body stays open`, async () => {
			const abort = new AbortController();
			const requests: string[] = [];
			let heldBody: ReadableStreamDefaultController<Uint8Array> | undefined;
			// The caller deadline only bounds a broken provider; recovery must come from its watchdog.
			const deadline = setTimeout(() => {
				abort.abort();
				heldBody?.error(new DOMException("Synthetic stalled error body deadline", "AbortError"));
				heldBody = undefined;
			}, 1_000);

			try {
				const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
					apiKey: credentials,
					antigravityEndpointMode: "auto",
					maxRetryDelayMs: 0,
					streamFirstEventTimeoutMs: 250,
					signal: abort.signal,
					fetch: async input => {
						requests.push(String(input));
						if (requests.length > 1) return success();
						return new Response(
							new ReadableStream<Uint8Array>(
								{
									start(controller) {
										heldBody = controller;
									},
									cancel() {
										heldBody = undefined;
									},
								},
								{ highWaterMark: 0 },
							),
							{ status },
						);
					},
				}).result();

				expect({ stopReason: result.stopReason, content: result.content, requests }).toEqual({
					stopReason: "stop",
					content: [{ type: "text", text: "recovered" }],
					requests: [
						`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
						`${sandboxEndpoint}/v1internal:streamGenerateContent?alt=sse`,
					],
				});
			} finally {
				clearTimeout(deadline);
				abort.abort();
				heldBody?.error(new DOMException("Synthetic stalled error body cleanup", "AbortError"));
				heldBody = undefined;
			}
		}, 5_000);

		it(`falls back to healthy sandbox when the first HTTP ${status} error body cannot be read`, async () => {
			const requests: string[] = [];
			const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
				apiKey: credentials,
				antigravityEndpointMode: "auto",
				maxRetryDelayMs: 0,
				streamFirstEventTimeoutMs: 250,
				fetch: async input => {
					requests.push(String(input));
					if (requests.length > 1) return success();
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.error(new Error("Synthetic error body disconnected"));
							},
						}),
						{ status },
					);
				},
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
			expect(requests).toEqual([
				`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
				`${sandboxEndpoint}/v1internal:streamGenerateContent?alt=sse`,
			]);
		});

		it(`does not dispatch sandbox when cancelled while reading the HTTP ${status} error body`, async () => {
			const abort = new AbortController();
			const requests: string[] = [];
			const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
				apiKey: credentials,
				antigravityEndpointMode: "auto",
				maxRetryDelayMs: 0,
				streamFirstEventTimeoutMs: 250,
				signal: abort.signal,
				fetch: async input => {
					requests.push(String(input));
					if (requests.length > 1) return success();
					return new Response(
						new ReadableStream(
							{
								pull(controller) {
									abort.abort();
									controller.error(new DOMException("Synthetic body read cancelled", "AbortError"));
								},
							},
							{ highWaterMark: 0 },
						),
						{ status },
					);
				},
			}).result();

			expect(result.stopReason).toBe("aborted");
			expect(requests).toEqual([`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`]);
		});
	}
	it("bounds an empty-SSE retry header stall without dispatching sandbox", async () => {
		const caller = new AbortController();
		const requests: string[] = [];
		// Real time is intentional: this proves the provider's watchdog bounds a stalled fetch.
		const deadline = setTimeout(
			() => caller.abort(new DOMException("Synthetic header-stall test deadline", "AbortError")),
			1_200,
		);

		try {
			const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
				apiKey: credentials,
				antigravityEndpointMode: "auto",
				maxRetryDelayMs: 0,
				streamFirstEventTimeoutMs: 25,
				signal: caller.signal,
				fetch: async (input, init) => {
					const url = String(input);
					requests.push(url);
					if (requests.length === 1) return emptySse(url);
					return stalledHeaders(init?.signal);
				},
			}).result();

			expect({ stopReason: result.stopReason, requests }).toEqual({
				stopReason: "error",
				requests: [
					`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
					`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
				],
			});
		} finally {
			clearTimeout(deadline);
			caller.abort();
		}
	}, 4_000);

	for (const status of [429, 503]) {
		it(`recovers through healthy sandbox after an empty SSE and HTTP ${status} retry body stalls`, async () => {
			const caller = new AbortController();
			const requests: string[] = [];
			let stalledBody: ReadableStreamDefaultController<Uint8Array> | undefined;
			// Real time is intentional: this proves the provider's watchdog bounds a stalled body.
			const deadline = setTimeout(() => {
				caller.abort(new DOMException("Synthetic body-stall test deadline", "AbortError"));
				stalledBody?.error(new DOMException("Synthetic body-stall test cleanup", "AbortError"));
				stalledBody = undefined;
			}, 1_200);

			try {
				const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
					apiKey: credentials,
					antigravityEndpointMode: "auto",
					maxRetryDelayMs: 0,
					streamFirstEventTimeoutMs: 25,
					signal: caller.signal,
					fetch: async (input, init) => {
						const url = String(input);
						requests.push(url);
						if (requests.length === 1) return emptySse(url);
						if (requests.length === 2) {
							return stalledErrorBody(init?.signal, status, controller => {
								stalledBody = controller;
							});
						}
						return success();
					},
				}).result();

				expect({ stopReason: result.stopReason, content: result.content, requests }).toEqual({
					stopReason: "stop",
					content: [{ type: "text", text: "recovered" }],
					requests: [
						`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
						`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
						`${sandboxEndpoint}/v1internal:streamGenerateContent?alt=sse`,
					],
				});
			} finally {
				clearTimeout(deadline);
				caller.abort();
				stalledBody?.error(new DOMException("Synthetic body-stall cleanup", "AbortError"));
				stalledBody = undefined;
			}
		}, 4_000);
	}

	for (const retryFailure of ["stalled retry headers", "non-OK retry body stays open"] as const) {
		it(`caller cancellation wins during an empty-SSE ${retryFailure} without sandbox dispatch`, async () => {
			const caller = new AbortController();
			const requests: string[] = [];

			try {
				const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
					apiKey: credentials,
					antigravityEndpointMode: "auto",
					maxRetryDelayMs: 0,
					streamFirstEventTimeoutMs: 25,
					signal: caller.signal,
					fetch: async (input, init) => {
						const url = String(input);
						requests.push(url);
						if (requests.length === 1) return emptySse(url);
						queueMicrotask(() => caller.abort());
						return retryFailure === "stalled retry headers"
							? stalledHeaders(init?.signal)
							: stalledErrorBody(init?.signal, 503, () => {});
					},
				}).result();

				expect({ stopReason: result.stopReason, requests }).toEqual({
					stopReason: "aborted",
					requests: [
						`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
						`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
					],
				});
			} finally {
				caller.abort();
			}
		}, 4_000);
	}

	for (const transport of ["HTTP", "pre-content SSE"] as const) {
		it(`keeps terminal ${transport} per-minute exhaustion transient without leaking RESOURCE_EXHAUSTED into quota classification`, async () => {
			const requests: string[] = [];
			const message = "Requests per minute exceeded. Please retry.";
			const body = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message } };
			const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
				apiKey: credentials,
				antigravityEndpointMode: "auto",
				maxRetryDelayMs: 0,
				streamFirstEventTimeoutMs: 250,
				fetch: async input => {
					requests.push(String(input));
					return transport === "HTTP" ? new Response(JSON.stringify(body), { status: 429 }) : sse(body);
				},
			}).result();

			expect({
				stopReason: result.stopReason,
				status: result.errorStatus,
				transient: ((result.errorId ?? 0) & AIError.Flag.Transient) !== 0,
				usageLimit: ((result.errorId ?? 0) & AIError.Flag.UsageLimit) !== 0,
				reason: parseRateLimitReason(result.errorMessage ?? ""),
			}).toEqual({
				stopReason: "error",
				status: 429,
				transient: true,
				usageLimit: false,
				reason: "RATE_LIMIT_EXCEEDED",
			});
			expect(result.errorMessage).toContain(message);
			expect(requests).toEqual([
				`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
				...Array.from(
					{ length: transport === "HTTP" ? 4 : 1 },
					() => `${sandboxEndpoint}/v1internal:streamGenerateContent?alt=sse`,
				),
			]);
		});
	}

	it("retains hard-quota status and body instead of waiting for Retry-After until the pre-response watchdog aborts", async () => {
		let calls = 0;
		const body = JSON.stringify({
			error: {
				code: 429,
				status: "RESOURCE_EXHAUSTED",
				message: "Daily quota exhausted for synthetic account A.",
				details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }],
			},
		});
		const result = await streamGoogleGeminiCli(cliModel, context, {
			apiKey: credentials,
			maxRetryDelayMs: 2_000,
			streamFirstEventTimeoutMs: 250,
			fetch: async () => {
				calls += 1;
				return new Response(body, { status: 429, headers: { "retry-after": "1" } });
			},
		}).result();

		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain("Daily quota exhausted for synthetic account A.");
		expect((result.errorId ?? 0) & AIError.Flag.UsageLimit).toBe(AIError.Flag.UsageLimit);
		expect(calls).toBe(1);
	});

	for (const message of [
		"Requests per minute exceeded. Please retry.",
		"Requests per minute quota exceeded. Please retry.",
		"Too many requests. Please retry.",
		"Resource exhausted. Please try again later.",
		"Model overloaded. Please try again later.",
		"Model capacity exhausted. Please try again later.",
	]) {
		it(`preserves endpoint fallback and retry for transient 429: ${message}`, async () => {
			const requests: string[] = [];
			const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
				apiKey: credentials,
				antigravityEndpointMode: "auto",
				maxRetryDelayMs: 0,
				fetch: async input => {
					requests.push(String(input));
					return requests.length < 3
						? new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message } }), {
								status: 429,
							})
						: success();
				},
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
			expect(requests).toEqual([
				`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
				`${sandboxEndpoint}/v1internal:streamGenerateContent?alt=sse`,
				`${sandboxEndpoint}/v1internal:streamGenerateContent?alt=sse`,
			]);
		});
	}

	for (const message of ["Please retry in 5s", "Requests per minute quota exceeded. Please retry."]) {
		it(`falls back after an ambiguous or transient SSE 429 without treating it as hard quota: ${message}`, async () => {
			const requests: string[] = [];
			const result = await streamGoogleGeminiCli({ ...cliModel, baseUrl: productionEndpoint }, context, {
				apiKey: credentials,
				antigravityEndpointMode: "auto",
				maxRetryDelayMs: 0,
				fetch: async input => {
					requests.push(String(input));
					if (requests.length > 2) throw new Error("Unexpected retry after bounded SSE fallback");
					return requests.length === 1
						? sse({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message } })
						: success();
				},
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
			expect(requests).toEqual([
				`${productionEndpoint}/v1internal:streamGenerateContent?alt=sse`,
				`${sandboxEndpoint}/v1internal:streamGenerateContent?alt=sse`,
			]);
		});
	}
});

describe("extractRetryHint – header parsing", () => {
	it("reads retry-after header as seconds", () => {
		const headers = new Headers({ "retry-after": "5" });
		expect(extractRetryHint(headers)).toBe(5_000);
	});

	it("reads x-ratelimit-reset-after header as seconds", () => {
		const headers = new Headers({ "x-ratelimit-reset-after": "30" });
		expect(extractRetryHint(headers)).toBe(30_000);
	});

	it("prefers retry-after over x-ratelimit-reset-after when both are present", () => {
		const headers = new Headers({ "retry-after": "5", "x-ratelimit-reset-after": "30" });
		expect(extractRetryHint(headers)).toBe(5_000);
	});
});

describe("extractRetryHint – body text parsing", () => {
	it("parses 'retryDelay' JSON field in seconds", () => {
		expect(extractRetryHint(undefined, '"retryDelay": "3s"')).toBe(3_000);
	});

	it("parses 'retryDelay' JSON field in milliseconds", () => {
		expect(extractRetryHint(undefined, '"retryDelay": "500ms"')).toBe(500);
	});

	it("parses 'Please retry in Xs' pattern", () => {
		expect(extractRetryHint(undefined, "Please retry in 5s")).toBe(5_000);
	});

	it("parses 'quota will reset after Xs' simple duration", () => {
		expect(extractRetryHint(undefined, "Your quota will reset after 39s")).toBe(39_000);
	});

	it("parses compound duration 'reset after 1h30m10s'", () => {
		expect(extractRetryHint(undefined, "Your quota will reset after 1h30m10s")).toBe(5_410_000);
	});
	it("parses Cloud Code Assist 'Resets in' quota text", () => {
		expect(extractRetryHint(undefined, "Individual quota reached. Resets in 28h48m25s.")).toBe(103_705_000);
	});

	it("parses Cloud Code Assist quotaResetDelay metadata", () => {
		expect(extractRetryHint(undefined, '"quotaResetDelay":"28h48m25.991228095s"')).toBeCloseTo(103_705_991.228095);
	});

	it("parses Codex-style 'try again in Xms'", () => {
		expect(extractRetryHint(undefined, "try again in 250ms")).toBe(250);
	});

	it("parses Codex-style 'try again in Xs'", () => {
		expect(extractRetryHint(undefined, "try again in 12s")).toBe(12_000);
	});

	it("parses Codex 'Try again in ~X min.' (usage_limit_reached friendly text)", () => {
		// Verbatim shape Codex's parseCodexError builds when usage_limit_reached
		// arrives with a `resets_at` minutes-out reset time. Used to fall
		// through to undefined → the gateway and TUI both had no retry-after
		// signal to honour, so they defaulted to QUOTA_EXHAUSTED's 30-min
		// blanket and rotated immediately even when the actual reset window
		// was much longer.
		expect(extractRetryHint(undefined, "Try again in ~158 min.")).toBe(158 * 60_000);
	});

	it("parses 'try again in X min' / 'X minutes' without the tilde", () => {
		expect(extractRetryHint(undefined, "try again in 5 min")).toBe(5 * 60_000);
		expect(extractRetryHint(undefined, "try again in 90 minutes")).toBe(90 * 60_000);
	});

	it("parses 'try again in X h' / 'X hour' / 'X hours'", () => {
		expect(extractRetryHint(undefined, "try again in 2 h")).toBe(2 * 60 * 60_000);
		expect(extractRetryHint(undefined, "try again in 1 hour")).toBe(60 * 60_000);
		expect(extractRetryHint(undefined, "try again in 3 hours")).toBe(3 * 60 * 60_000);
	});

	it("returns undefined when body contains no recognised delay pattern", () => {
		expect(extractRetryHint(undefined, "Quota exceeded, please try again later")).toBeUndefined();
	});

	it("returns undefined for empty error string and no headers", () => {
		expect(extractRetryHint(undefined, "")).toBeUndefined();
	});
});

describe("google-gemini-cli quota error formatting", () => {
	it("formats Individual quota 429s as actionable reset messages instead of raw JSON", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return new Response(individualQuotaBody, {
				status: 429,
				headers: { "content-type": "application/json" },
			});
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123", email: "user@example.com" }),
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain(
			"Cloud Code Assist API error (429): Cloud Code Assist quota exhausted for gemini-3-flash-agent on user@example.com.",
		);
		expect(result.errorMessage).toContain("Individual quota reached.");
		expect(result.errorMessage).toContain("Your quota will reset after 28h48m25.991228095s (2026-07-03T18:44:59Z).");
		expect(result.errorMessage).toContain("Add another Google account with /login");
		expect(result.errorMessage).not.toContain('"details"');
	});

	it("formats Individual quota 429s with literal newlines in the message field", async () => {
		let calls = 0;
		const bodyWithNewline = `{
  "error": {
    "code": 429,
    "message": "Individual quota reached. Please upgrade your subscription to increase your\n limits. Resets in 28h48m25s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "QUOTA_EXHAUSTED",
        "domain": "cloudcode-pa.googleapis.com",
        "metadata": {
          "uiMessage": "true",
          "model": "gemini-3-flash-agent",
          "quotaResetDelay": "28h48m25.991228095s",
          "quotaResetTimeStamp": "2026-07-03T18:44:59Z"
        }
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "103705.991228095s"
      }
    ]
  }
}`.replace("\\n", "\n"); // Force a literal newline inside the message string

		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return new Response(bodyWithNewline, {
				status: 429,
				headers: { "content-type": "application/json" },
			});
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123", email: "user@example.com" }),
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain(
			"Cloud Code Assist API error (429): Cloud Code Assist quota exhausted for gemini-3-flash-agent on user@example.com.",
		);
		expect(result.errorMessage).toContain("Individual quota reached.");
		expect(result.errorMessage).toContain("Your quota will reset after 28h48m25.991228095s (2026-07-03T18:44:59Z).");
		expect(result.errorMessage).toContain("Add another Google account with /login");
		expect(result.errorMessage).not.toContain('"details"');
	});
});
