/**
 * Exercises `RoomManager` through a real `Bun.serve` HTTP+WS layer (not just
 * unit-called), so envelope routing, close codes, and capacity limits are all
 * proven against the actual upgrade/message/close lifecycle production uses.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { ENVELOPE_HEADER_LENGTH } from "jeopi-wire";
import {
	CLOSE_HOST_EXISTS,
	CLOSE_NO_SUCH_ROOM,
	CLOSE_ROOM_CLOSED,
	CLOSE_ROOM_FULL,
	RoomManager,
	type RoomSocketData,
} from "../src/rooms";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const ROOM = "TestRoom_1234567";
const REQUEST_TIMEOUT_MS = 1_000;

function packEnvelope(peerId: number, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + payload.byteLength);
	new DataView(out.buffer).setUint32(0, peerId, false);
	out.set(payload, ENVELOPE_HEADER_LENGTH);
	return out;
}

function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } {
	const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
	return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

function startTestServer(rooms: RoomManager): Bun.Server<RoomSocketData> {
	return Bun.serve<RoomSocketData>({
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			const match = ROOM_PATH_RE.exec(url.pathname);
			const role = url.searchParams.get("role");
			if (!match || (role !== "host" && role !== "guest")) return new Response("not found", { status: 404 });
			const roomId = match[1] as string;
			if (role === "host" && !rooms.canAcceptNewHost(roomId)) return new Response("full", { status: 503 });
			const data: RoomSocketData = { roomId, role, peerId: 0 };
			if (srv.upgrade(req, { data })) return undefined;
			return new Response("websocket upgrade required", { status: 426 });
		},
		websocket: {
			open: ws => rooms.open(ws),
			message: (ws, message) => rooms.message(ws, message),
			close: ws => rooms.close(ws),
		},
	});
}

let server: Bun.Server<RoomSocketData> | null = null;
const sockets: WebSocket[] = [];
const inboxes = new Map<WebSocket, { queue: MessageEvent[]; waiters: Array<(event: MessageEvent) => void> }>();

function socket(path: string): WebSocket {
	if (!server) throw new Error("server not started");
	const ws = new WebSocket(`ws://localhost:${server.port}${path}`);
	ws.binaryType = "arraybuffer";
	const inbox = { queue: [] as MessageEvent[], waiters: [] as Array<(event: MessageEvent) => void> };
	inboxes.set(ws, inbox);
	ws.addEventListener("message", event => {
		const waiter = inbox.waiters.shift();
		if (waiter) waiter(event as MessageEvent);
		else inbox.queue.push(event as MessageEvent);
	});
	sockets.push(ws);
	return ws;
}

function nextMessage(ws: WebSocket, label: string): Promise<MessageEvent> {
	const inbox = inboxes.get(ws);
	if (!inbox) throw new Error("socket not created via socket()");
	const queued = inbox.queue.shift();
	if (queued) return Promise.resolve(queued);
	const { promise, resolve, reject } = Promise.withResolvers<MessageEvent>();
	const timer = setTimeout(() => {
		const idx = inbox.waiters.indexOf(onEvent);
		if (idx !== -1) inbox.waiters.splice(idx, 1);
		reject(new Error(`timed out waiting for ${label}`));
	}, REQUEST_TIMEOUT_MS);
	const onEvent = (event: MessageEvent): void => {
		clearTimeout(timer);
		resolve(event);
	};
	inbox.waiters.push(onEvent);
	return promise;
}

function waitEvent<T extends Event>(ws: WebSocket, type: string, label: string): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => {
		ws.removeEventListener(type, onEvent);
		reject(new Error(`timed out waiting for ${label}`));
	}, REQUEST_TIMEOUT_MS);
	const onEvent = (event: Event): void => {
		clearTimeout(timer);
		resolve(event as T);
	};
	ws.addEventListener(type, onEvent);
	return promise;
}

function waitOpen(ws: WebSocket): Promise<Event> {
	if (ws.readyState === WebSocket.OPEN) return Promise.resolve(new Event("open"));
	return waitEvent(ws, "open", "socket open");
}

async function waitText(ws: WebSocket, label: string): Promise<string> {
	const event = await nextMessage(ws, label);
	if (typeof event.data !== "string") throw new Error(`${label} was not TEXT`);
	return event.data;
}

async function waitBinary(ws: WebSocket, label: string): Promise<Uint8Array> {
	const event = await nextMessage(ws, label);
	const data: unknown = event.data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	throw new Error(`${label} was not binary`);
}

afterEach(() => {
	for (const ws of sockets.splice(0)) {
		if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000);
	}
	inboxes.clear();
	server?.stop(true);
	server = null;
});

describe("RoomManager over Bun.serve", () => {
	it("rejects a guest joining before a host creates the room", async () => {
		server = startTestServer(new RoomManager({ maxRooms: 10, maxGuestsPerRoom: 10 }));
		const guest = socket(`/r/${ROOM}?role=guest`);
		const close = await waitEvent<CloseEvent>(guest, "close", "missing-room guest close");
		expect(close.code).toBe(CLOSE_NO_SUCH_ROOM);
	});

	it("routes opaque envelopes host<->guest without decrypting them", async () => {
		server = startTestServer(new RoomManager({ maxRooms: 10, maxGuestsPerRoom: 10 }));
		const host = socket(`/r/${ROOM}?role=host`);
		await waitOpen(host);

		const guest = socket(`/r/${ROOM}?role=guest`);
		await waitOpen(guest);
		expect(JSON.parse(await waitText(host, "peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		guest.send(packEnvelope(0, new Uint8Array([1, 2, 3])));
		const fromGuest = unpackEnvelope(await waitBinary(host, "guest envelope"));
		expect(fromGuest.peerId).toBe(1);
		expect(fromGuest.payload).toEqual(new Uint8Array([1, 2, 3]));

		const broadcast = waitBinary(guest, "host broadcast");
		host.send(packEnvelope(0, new Uint8Array([9])));
		expect(unpackEnvelope(await broadcast).payload).toEqual(new Uint8Array([9]));
	});

	it("enforces one host per room and closes guests on host disconnect", async () => {
		server = startTestServer(new RoomManager({ maxRooms: 10, maxGuestsPerRoom: 10 }));
		const host = socket(`/r/${ROOM}?role=host`);
		await waitOpen(host);

		const duplicateHost = socket(`/r/${ROOM}?role=host`);
		const duplicateClose = await waitEvent<CloseEvent>(duplicateHost, "close", "duplicate host close");
		expect(duplicateClose.code).toBe(CLOSE_HOST_EXISTS);

		const guest = socket(`/r/${ROOM}?role=guest`);
		await waitOpen(guest);
		await waitText(host, "peer join");

		const closure = waitText(guest, "room close control");
		const guestClose = waitEvent<CloseEvent>(guest, "close", "guest room close");
		host.close(1000);
		expect(JSON.parse(await closure)).toEqual({ t: "room-closed" });
		expect((await guestClose).code).toBe(CLOSE_ROOM_CLOSED);
	});

	it("rejects a guest beyond maxGuestsPerRoom", async () => {
		server = startTestServer(new RoomManager({ maxRooms: 10, maxGuestsPerRoom: 1 }));
		const host = socket(`/r/${ROOM}?role=host`);
		await waitOpen(host);

		const guest1 = socket(`/r/${ROOM}?role=guest`);
		await waitOpen(guest1);

		const guest2 = socket(`/r/${ROOM}?role=guest`);
		const close = await waitEvent<CloseEvent>(guest2, "close", "over-capacity guest close");
		expect(close.code).toBe(CLOSE_ROOM_FULL);
	});

	it("rejects a new host beyond maxRooms at the HTTP layer before upgrade", async () => {
		server = startTestServer(new RoomManager({ maxRooms: 1, maxGuestsPerRoom: 10 }));
		const host = socket(`/r/${ROOM}?role=host`);
		await waitOpen(host);

		const res = await fetch(`http://localhost:${server.port}/r/AnotherRoom_99999?role=host`);
		expect(res.status).toBe(503);
	});
});
