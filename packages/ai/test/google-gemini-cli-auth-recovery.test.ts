import { describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "jeopi-ai/auth-storage";
import * as AIError from "jeopi-ai/error";
import { streamSimple } from "jeopi-ai/stream";
import type { Context, TJsonSchema } from "jeopi-ai/types";
import { buildModel } from "jeopi-catalog/build";

const provider = "google-antigravity";
const model = buildModel({
	id: "gemini-4-argon-medium",
	name: "Argon Medium",
	api: "google-gemini-cli",
	provider,
	baseUrl: "https://daily-cloudcode-pa.googleapis.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 222_000,
	maxTokens: 22_000,
});

const systemPrompt = [
	"You are the release engineer. Preserve all instructions while recovering credentials.",
	"Repository policy:\nRead the full diff before editing. Never discard user changes.\nDo not shorten this block.",
	"Operational constraint:\nUse inspect_release for release evidence. Keep Korean text: 배포 근거를 확인하세요.",
];
const toolSchema: TJsonSchema = {
	type: "object",
	properties: {
		paths: { type: "array", items: { type: "string" } },
		mode: { type: "string", enum: ["read", "verify"] },
	},
	required: ["paths", "mode"],
};
const context: Context = {
	systemPrompt,
	messages: [{ role: "user", content: "Inspect the Argon release without changing the model.", timestamp: 1 }],
	tools: [{ name: "inspect_release", description: "Inspect release evidence without writes", parameters: toolSchema }],
};

interface RequestBody {
	model: string;
	project: string;
	request: {
		contents: unknown[];
		systemInstruction: { parts: Array<{ text: string }> };
		tools: Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: unknown }> }>;
	};
}

describe("Google provider recovery through the AuthStorage resolver", () => {
	for (const { rateLimited, emptyRetry } of [
		{ rateLimited: false, emptyRetry: false },
		{ rateLimited: true, emptyRetry: false },
		{ rateLimited: false, emptyRetry: true },
		{ rateLimited: true, emptyRetry: true },
	]) {
		it(`${emptyRetry ? "after empty SSE retry: " : ""}${
			rateLimited
				? "does not rotate accounts for terminal per-minute HTTP 429 or lose the Argon request context"
				: "rotates exhausted A to B without retrying A or losing the Argon selector, full system prompt, conversation, or tool schema"
		}`, async () => {
			const store = await SqliteAuthCredentialStore.open(":memory:");
			// Refresh and usage lookup are the only external boundaries. Keep the real
			// store, credential ranking, registry serialization, resolver and provider.
			const expires = Date.now() + 60 * 60_000;
			const auth = new AuthStorage(store, {
				usageProviderResolver: () => undefined,
				refreshOAuthCredential: async (_provider, _credentialId, credential) => ({ ...credential, expires }),
			});
			try {
				await auth.set(provider, [
					{
						type: "oauth",
						access: "synthetic-account-A",
						refresh: "synthetic-refresh-A",
						email: "a@example.invalid",
						accountId: "account-A",
						projectId: "project-A",
						expires,
					},
					{
						type: "oauth",
						access: "synthetic-account-B",
						refresh: "synthetic-refresh-B",
						email: "b@example.invalid",
						accountId: "account-B",
						projectId: "project-B",
						expires,
					},
				]);
				// This session's equal-weight selection starts at A. A refresh returns
				// the same serialized key; the existing resolver then rotates to B.
				const sessionId = "argon-recovery-session";
				const requests: Array<{ authorization: string | null; body: RequestBody }> = [];
				const stream = streamSimple(model, context, {
					apiKey: auth.resolver(provider, { sessionId, modelId: model.id }),
					sessionId,
					antigravityEndpointMode: "production",
					maxRetryDelayMs: 0,
					streamFirstEventTimeoutMs: emptyRetry ? 2_000 : 250,
					fetch: async (input, init) => {
						const authorization = new Headers(init?.headers).get("authorization");
						requests.push({ authorization, body: JSON.parse(String(init?.body)) as RequestBody });
						if (authorization === "Bearer synthetic-account-A") {
							if (emptyRetry && requests.length === 1) {
								const response = new Response("", { headers: { "content-type": "text/event-stream" } });
								Object.defineProperty(response, "url", { value: String(input) });
								return response;
							}
							return new Response(
								JSON.stringify({
									error: {
										code: 429,
										status: "RESOURCE_EXHAUSTED",
										message: rateLimited
											? "Requests per minute exceeded. Please retry."
											: emptyRetry
												? "Resource exhausted. Please try again later."
												: "Resource has been exhausted (e.g. check quota).",
										...(emptyRetry && !rateLimited
											? {
													details: [
														{
															"@type": "type.googleapis.com/google.rpc.ErrorInfo",
															reason: "QUOTA_EXHAUSTED",
														},
													],
												}
											: {}),
									},
								}),
								{ status: 429 },
							);
						}
						if (authorization !== "Bearer synthetic-account-B") {
							throw new Error(`Unexpected synthetic credential: ${authorization}`);
						}
						return new Response(
							`data: ${JSON.stringify({
								response: {
									candidates: [
										{ content: { parts: [{ text: "Verified with account B." }] }, finishReason: "STOP" },
									],
									usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 },
								},
							})}\n\n`,
							{ status: 200, headers: { "content-type": "text/event-stream" } },
						);
					},
				});
				const events = [];
				for await (const event of stream) events.push(event);
				const result = await stream.result();

				if (rateLimited) {
					expect({
						stopReason: result.stopReason,
						status: result.errorStatus,
						transient: ((result.errorId ?? 0) & AIError.Flag.Transient) !== 0,
						usageLimit: ((result.errorId ?? 0) & AIError.Flag.UsageLimit) !== 0,
					}).toEqual({ stopReason: "error", status: 429, transient: true, usageLimit: false });
					expect(result.errorMessage).toContain("Requests per minute exceeded. Please retry.");
					expect(events.filter(event => event.type === "error").map(event => event.reason)).toEqual(["error"]);
				} else {
					expect(result.stopReason).toBe("stop");
					expect(result.content).toEqual([{ type: "text", text: "Verified with account B." }]);
					expect(result.model).toBe("gemini-4-argon-medium");
					expect(events.filter(event => event.type === "error")).toEqual([]);
					const recovered = requests.find(request => request.authorization === "Bearer synthetic-account-B");
					expect(recovered?.body.project).toBe("project-B");
				}
				// Assert semantic wire content, not volatile request/trajectory ids.
				for (const { body } of requests) {
					expect(body.model).toBe("gemini-4-argon-medium");
					expect(body.request.systemInstruction.parts).toEqual(systemPrompt.map(text => ({ text })));
					expect(body.request.contents).toEqual([
						{ role: "user", parts: [{ text: "Inspect the Argon release without changing the model." }] },
					]);
					expect(body.request.tools).toMatchObject([
						{
							functionDeclarations: [
								{
									name: "inspect_release",
									description: "Inspect release evidence without writes",
									parameters: {
										type: "object",
										properties: {
											paths: { type: "array", items: { type: "string" } },
											mode: { type: "string", enum: ["read", "verify"] },
										},
										required: ["paths", "mode"],
									},
								},
							],
						},
					]);
				}
				expect(requests.map(request => request.authorization)).toEqual(
					rateLimited
						? Array.from({ length: emptyRetry ? 2 : 4 }, () => "Bearer synthetic-account-A")
						: [
								"Bearer synthetic-account-A",
								...(emptyRetry ? ["Bearer synthetic-account-A"] : []),
								"Bearer synthetic-account-B",
							],
				);
			} finally {
				store.close();
			}
		}, 5_000);
	}
});
