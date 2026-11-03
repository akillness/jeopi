import { describe, expect, test } from "bun:test";
import { createMessengerGateway } from "jeopi-cli/messenger/gateway";
import { createSlackAdapter } from "jeopi-cli/messenger/slack";
import { createTelegramAdapter } from "jeopi-cli/messenger/telegram";
import type { MessengerConfig, MessengerMessage, MessengerPlatformConfig } from "jeopi-cli/messenger/types";

const platform: MessengerPlatformConfig = { tokenEnv: "TEST_TOKEN", allowedUserIds: ["human"] };

for (const [name, create, token, createMethod, deleteMethod, editMethod] of [
	["slack", createSlackAdapter, "xoxb-test-token", "chat.postMessage", "chat.delete", "chat.update"],
	["telegram", createTelegramAdapter, "123:test-token", "sendMessage", "deleteMessage", "editMessageText"],
] as const) {
	const message: MessengerMessage = {
		platform: name,
		accountId: "bot",
		channelId: "123",
		senderId: "human",
		messageId: "456",
		text: "hello",
		direct: true,
		mentioned: false,
	};
	const config: MessengerConfig = { cwd: "/tmp", sessionDir: "/tmp", toolNames: [], platforms: { [name]: platform } };
	const created = (id: number) =>
		name === "slack"
			? Response.json({ ok: true, ts: `status-${id}` })
			: Response.json({ ok: true, result: { message_id: id } });
	const success = () => (name === "slack" ? Response.json({ ok: true }) : Response.json({ ok: true, result: true }));

	describe(`${name} activity lifecycle`, () => {
		test("removes a status whose creation completes after cancellation", async () => {
			const started = Promise.withResolvers<void>();
			const response = Promise.withResolvers<Response>();
			const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
			const fetchImpl: typeof fetch = Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
					const method = new URL(request.url).pathname.split("/").at(-1)!;
					const body = (await request.json()) as Record<string, unknown>;
					requests.push({ method, body });
					if (method === createMethod) {
						started.resolve();
						return response.promise;
					}
					return success();
				},
				{ preconnect: fetch.preconnect },
			);
			const adapter = create(platform, { TEST_TOKEN: token }, { fetch: fetchImpl });
			const controller = new AbortController();
			const creating = adapter.activity!(message, "working", controller.signal).catch(() => {});
			await started.promise;
			controller.abort();
			await adapter.activity!(message, undefined);
			response.resolve(created(91));
			await creating;
			expect(requests.map(({ method }) => method)).toEqual([createMethod, deleteMethod]);
			expect(requests[1]!.body).toEqual(
				name === "slack" ? { channel: "123", ts: "status-91" } : { chat_id: "123", message_id: 91 },
			);
			await adapter.activity!(message, undefined);
			expect(requests.map(({ method }) => method)).toEqual([createMethod, deleteMethod]);
		});

		test("gateway cancellation does not abort a pending creation before its late status can be removed", async () => {
			const started = Promise.withResolvers<AbortSignal>();
			const response = Promise.withResolvers<Response>();
			const deleted = Promise.withResolvers<Record<string, unknown>>();
			const fetchImpl: typeof fetch = Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
					const method = new URL(request.url).pathname.split("/").at(-1)!;
					const body = (await request.json()) as Record<string, unknown>;
					if (method === createMethod) {
						started.resolve(request.signal);
						return new Promise<Response>((resolve, reject) => {
							if (request.signal.aborted) return reject(new Error("request aborted"));
							request.signal.addEventListener("abort", () => reject(new Error("request aborted")), {
								once: true,
							});
							response.promise.then(resolve, reject);
						});
					}
					if (method === deleteMethod) {
						deleted.resolve(body);
						return success();
					}
					throw new Error(`Unexpected method: ${method}`);
				},
				{ preconnect: fetch.preconnect },
			);
			const adapter = create(platform, { TEST_TOKEN: token }, { fetch: fetchImpl });
			const gateway = createMessengerGateway(
				config,
				[adapter],
				async (_message, signal, report) => {
					report?.("working");
					await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
					return "";
				},
				{ activityIntervalMs: 0 },
			);
			const controller = new AbortController();
			const handling = gateway.handle(message, controller.signal);
			const requestSignal = await started.promise;
			controller.abort();
			await handling;
			expect(requestSignal.aborted).toBe(false);
			response.resolve(created(91));
			expect(await deleted.promise).toEqual(
				name === "slack" ? { channel: "123", ts: "status-91" } : { chat_id: "123", message_id: 91 },
			);
		});

		test("failed final cleanup does not reuse a stale status in later work", async () => {
			const posted = Promise.withResolvers<void>();
			const requests: string[] = [];
			let posts = 0;
			const fetchImpl: typeof fetch = Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
					const method = new URL(request.url).pathname.split("/").at(-1)!;
					const body = (await request.json()) as Record<string, unknown>;
					if (method === createMethod && body.text === "done") return created(999);
					requests.push(method);
					if (method === createMethod) {
						posted.resolve();
						return created(++posts);
					}
					if (method === deleteMethod)
						return name === "slack"
							? new Response(JSON.stringify({ ok: false }), { status: 429, headers: { "retry-after": "4" } })
							: Response.json({ ok: false, error_code: 429, parameters: { retry_after: 4 } });
					if (method === editMethod) return success();
					throw new Error(`Unexpected method: ${method}`);
				},
				{ preconnect: fetch.preconnect },
			);
			const adapter = create(platform, { TEST_TOKEN: token }, { fetch: fetchImpl });
			const gateway = createMessengerGateway(
				config,
				[adapter],
				async (_message, _signal, report) => {
					report?.("working");
					await posted.promise;
					return "done";
				},
				{ activityIntervalMs: 0 },
			);
			await gateway.handle(message);
			await adapter.activity!(message, "new work");
			expect(requests).toEqual([createMethod, deleteMethod, createMethod]);
		});
	});
}
