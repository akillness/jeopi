import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentEvent, AgentMessage, AsideMessage } from "jeopi-agent-core";
import { TelegramControl, telegramControlFromEnv } from "jeopi-agent-core/telegram";

interface RecordedRequest {
	url: string;
	init?: RequestInit;
}

/** Mock `fetch` that records requests and replays a queue of JSON responses. */
function mockFetch(responses: unknown[]): { fetch: typeof fetch; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	let i = 0;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		const body = responses[Math.min(i, responses.length - 1)];
		i++;
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, requests };
}

const updateFrom = (updateId: number, chatId: number, text: string, date = 1700) => ({
	update_id: updateId,
	message: { text, date, chat: { id: chatId }, from: { username: "op" } },
});

describe("TelegramControl transport", () => {
	it("posts sendMessage to the authorized chat and reports ok", async () => {
		const { fetch, requests } = mockFetch([{ ok: true }]);
		const tg = new TelegramControl({ botToken: "T0K", chatId: 42, fetch });

		const ok = await tg.notify("hello");

		expect(ok).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://api.telegram.org/botT0K/sendMessage");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ chat_id: 42, text: "hello" });
	});

	it("returns false and does not throw when Telegram reports not-ok", async () => {
		const { fetch } = mockFetch([{ ok: false, description: "blocked" }]);
		const tg = new TelegramControl({ botToken: "T", chatId: 1, fetch });
		expect(await tg.notify("x")).toBe(false);
	});

	it("truncates messages above the Telegram length cap", async () => {
		const { fetch, requests } = mockFetch([{ ok: true }]);
		const tg = new TelegramControl({ botToken: "T", chatId: 1, fetch });
		await tg.notify("a".repeat(5000));
		const sent = JSON.parse(String(requests[0]?.init?.body)).text as string;
		expect(sent.length).toBeLessThanOrEqual(3900);
		expect(sent.endsWith("…")).toBe(true);
	});

	it("skips empty notifications without a network round-trip", async () => {
		const { fetch, requests } = mockFetch([{ ok: true }]);
		const tg = new TelegramControl({ botToken: "T", chatId: 1, fetch });
		expect(await tg.notify("   ")).toBe(false);
		expect(requests).toHaveLength(0);
	});
});

describe("TelegramControl inbound polling", () => {
	it("accepts messages from the authorized chat, advances the offset, and fans out to listeners", async () => {
		const result = { ok: true, result: [updateFrom(10, 42, "run tests"), updateFrom(11, 42, "status")] };
		const { fetch, requests } = mockFetch([result, { ok: true, result: [] }]);
		const tg = new TelegramControl({ botToken: "T", chatId: 42, fetch, pollTimeoutSec: 5 });

		const seen: string[] = [];
		tg.onInbound(m => seen.push(m.text));

		const first = await tg.poll();
		expect(first.map(m => m.text)).toEqual(["run tests", "status"]);
		expect(seen).toEqual(["run tests", "status"]);
		expect(requests[0]?.url).toBe("https://api.telegram.org/botT/getUpdates?offset=0&timeout=5");

		await tg.poll();
		// Offset advanced past update_id 11 → next round asks for 12.
		expect(requests[1]?.url).toBe("https://api.telegram.org/botT/getUpdates?offset=12&timeout=5");
	});

	it("drops messages from unauthorized chats but still advances past them", async () => {
		const result = { ok: true, result: [updateFrom(20, 999, "intruder"), updateFrom(21, 42, "legit")] };
		const { fetch, requests } = mockFetch([result, { ok: true, result: [] }]);
		const tg = new TelegramControl({ botToken: "T", chatId: 42, fetch });

		const accepted = await tg.poll();
		expect(accepted.map(m => m.text)).toEqual(["legit"]);

		await tg.poll();
		expect(requests[1]?.url).toContain("offset=22");
	});

	it("returns [] and does not advance on an API error round", async () => {
		const { fetch, requests } = mockFetch([{ ok: false }, { ok: true, result: [] }]);
		const tg = new TelegramControl({ botToken: "T", chatId: 42, fetch });
		expect(await tg.poll()).toEqual([]);
		await tg.poll();
		expect(requests[1]?.url).toContain("offset=0");
	});

	it("drains queued inbound messages as user agent messages and clears the queue", async () => {
		const result = { ok: true, result: [updateFrom(1, 7, "do it", 1700)] };
		const { fetch } = mockFetch([result]);
		const tg = new TelegramControl({ botToken: "T", chatId: 7, fetch });

		await tg.poll();
		const drained = tg.drainInbound();
		expect(drained).toEqual([{ role: "user", content: "do it", timestamp: 1700 * 1000 }]);
		expect(tg.drainInbound()).toEqual([]);
	});
});

describe("TelegramControl agent wiring", () => {
	function fakeAgent() {
		let listener: ((e: AgentEvent) => void) | undefined;
		let asideProvider: (() => AsideMessage[] | Promise<AsideMessage[]>) | undefined;
		return {
			subscribe(fn: (e: AgentEvent) => void) {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
			setAsideMessageProvider(fn: (() => AsideMessage[] | Promise<AsideMessage[]>) | undefined) {
				asideProvider = fn;
			},
			emit(e: AgentEvent) {
				listener?.(e);
			},
			get hasListener() {
				return listener !== undefined;
			},
			drainAside: () => asideProvider?.(),
		};
	}

	it("notifies the chat when a run ends, including the last assistant text", async () => {
		const { fetch, requests } = mockFetch([{ ok: true }]);
		const tg = new TelegramControl({ botToken: "T", chatId: 5, fetch });
		const agent = fakeAgent();
		tg.attach(agent);

		const messages: AgentMessage[] = [
			{ role: "user", content: "hi", timestamp: 0 },
			{ role: "assistant", content: [{ type: "text", text: "all done" }], api: "responses", provider: "openai" },
		] as unknown as AgentMessage[];
		agent.emit({ type: "agent_end", messages });
		await Promise.resolve();
		await new Promise(r => setTimeout(r, 0));

		expect(requests).toHaveLength(1);
		const sent = JSON.parse(String(requests[0]?.init?.body));
		expect(sent.chat_id).toBe(5);
		expect(sent.text).toContain("all done");
	});

	it("notifies on tool failure but not on tool success", async () => {
		const { fetch, requests } = mockFetch([{ ok: true }, { ok: true }]);
		const tg = new TelegramControl({ botToken: "T", chatId: 5, fetch });
		const agent = fakeAgent();
		tg.attach(agent);

		agent.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false });
		agent.emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "edit", result: {}, isError: true });
		await new Promise(r => setTimeout(r, 0));

		expect(requests).toHaveLength(1);
		expect(JSON.parse(String(requests[0]?.init?.body)).text).toContain("edit");
	});

	it("feeds inbound Telegram messages into the agent aside channel and detaches cleanly", async () => {
		const result = { ok: true, result: [updateFrom(1, 5, "steer left", 1700)] };
		const { fetch } = mockFetch([result]);
		const tg = new TelegramControl({ botToken: "T", chatId: 5, fetch });
		const agent = fakeAgent();
		const detach = tg.attach(agent);

		await tg.poll();
		const aside = await agent.drainAside();
		expect(aside).toEqual([{ role: "user", content: "steer left", timestamp: 1700 * 1000 }]);

		detach();
		expect(agent.hasListener).toBe(false);
		expect(await agent.drainAside()).toBeUndefined();
	});
});

describe("telegramControlFromEnv", () => {
	it("returns null when either credential is missing", () => {
		expect(telegramControlFromEnv({ TELEGRAM_BOT_TOKEN: "T" })).toBeNull();
		expect(telegramControlFromEnv({ TELEGRAM_CHAT_ID: "1" })).toBeNull();
		expect(telegramControlFromEnv({})).toBeNull();
	});

	it("builds a control when both credentials are present", async () => {
		const { fetch, requests } = mockFetch([{ ok: true }]);
		const tg = telegramControlFromEnv({ TELEGRAM_BOT_TOKEN: "ABC", TELEGRAM_CHAT_ID: "9" }, { fetch });
		expect(tg).not.toBeNull();
		await tg?.notify("ping");
		expect(requests[0]?.url).toBe("https://api.telegram.org/botABC/sendMessage");
		expect(JSON.parse(String(requests[0]?.init?.body)).chat_id).toBe(9);
	});
});

describe("TelegramControl constructor validation", () => {
	it("rejects a non-numeric chat id", () => {
		expect(() => new TelegramControl({ botToken: "T", chatId: "not-a-number" })).toThrow(/numeric chatId/);
	});

	it("rejects an empty bot token", () => {
		expect(() => new TelegramControl({ botToken: "", chatId: 1 })).toThrow(/botToken/);
	});
});

// Guard against a leaked long-poll loop between tests.
let started: TelegramControl | undefined;
beforeEach(() => {
	started = undefined;
});
afterEach(async () => {
	await started?.stop();
});
