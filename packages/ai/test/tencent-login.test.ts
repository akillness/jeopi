import { describe, expect, it, vi } from "bun:test";
import { loginTencent } from "jeopi-ai/registry/tencent";
import type { FetchImpl } from "jeopi-ai/types";

describe("tencent login", () => {
	it("validates pasted keys against the Anthropic messages endpoint", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const headers = new Headers(init?.headers);
			const body = JSON.parse(String(init?.body)) as { model?: string; max_tokens?: number };

			expect(url).toBe("https://tokenhub-intl.tencentcloudmaas.com/v1/messages");
			expect(init?.method).toBe("POST");
			expect(headers.get("content-type")).toBe("application/json");
			expect(headers.get("anthropic-version")).toBe("2023-06-01");
			expect(headers.get("x-api-key")).toBe("sk-tencent-valid");
			expect(headers.get("authorization")).toBeNull();
			expect(body.model).toBe("deepseek-v4-pro");
			expect(body.max_tokens).toBe(1);

			return new Response(JSON.stringify({ id: "msg_test", type: "message" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const apiKey = await loginTencent({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "  sk-tencent-valid  ";
			},
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-tencent-valid");
		expect(authUrl).toBe("https://cloud.tencent.com/product/lke");
		expect(authInstructions).toContain("Tencent Cloud MaaS");
		expect(promptMessage).toBe("Paste your Tencent Cloud MaaS API key");
		expect(promptPlaceholder).toBe("sk-...");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("surfaces validation errors from the Anthropic messages endpoint", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response("invalid key", {
					status: 401,
					headers: { "Content-Type": "text/plain" },
				}),
		);

		await expect(
			loginTencent({
				onPrompt: async () => "sk-tencent-bad",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Tencent Cloud MaaS API key validation failed (401): invalid key");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("accepts a key that is valid but hit the free-trial quota (HTTP 402) instead of rejecting it", async () => {
		// Verified live against the real gateway (2026-07): a recognized key with no
		// active billing gets HTTP 402 "free trial quota ... postpaid billing is not
		// enabled", not 401/403. Only an authenticated key reaches this response, so
		// it must not be treated as an invalid-key failure.
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: { message: "The free trial quota for the service has been exhausted", type: "api_error" },
					}),
					{ status: 402, headers: { "Content-Type": "application/json" } },
				),
		);

		const apiKey = await loginTencent({
			onPrompt: async () => "sk-tencent-unbilled",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-tencent-unbilled");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
