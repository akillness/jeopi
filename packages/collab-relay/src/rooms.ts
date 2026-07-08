/**
 * WebSocket room forwarding — production version of collab-web's
 * `scripts/local-relay.ts`. Same content-blind contract (envelope routing,
 * peer-joined/peer-left control frames, room-closed on host disconnect), plus
 * capacity limits (`maxRooms`, `maxGuestsPerRoom`) a dev-only relay doesn't need.
 *
 * The relay never inspects sealed payloads — only the plaintext 4-byte
 * peerId envelope prefix from `jeopi-wire`'s `ENVELOPE_HEADER_LENGTH`.
 */
import { ENVELOPE_HEADER_LENGTH } from "jeopi-wire";

export interface RoomSocketData {
	roomId: string;
	role: "host" | "guest";
	/** Assigned on open for guests; the host stays 0. */
	peerId: number;
}

export type RoomWebSocket = Bun.ServerWebSocket<RoomSocketData>;

interface Room {
	host: RoomWebSocket;
	guests: Map<number, RoomWebSocket>;
	nextPeerId: number;
}

export interface RoomManagerOptions {
	maxRooms: number;
	maxGuestsPerRoom: number;
}

/** Close codes mirroring the documented relay contract (docs/collab.md). */
export const CLOSE_ROOM_FULL = 4008;
export const CLOSE_HOST_EXISTS = 4009;
export const CLOSE_NO_SUCH_ROOM = 4004;
export const CLOSE_ROOM_CLOSED = 4001;

/** In-memory room registry + forwarding logic, wired to Bun's websocket handler lifecycle. */
export class RoomManager {
	readonly #rooms = new Map<string, Room>();
	readonly #opts: RoomManagerOptions;

	constructor(opts: RoomManagerOptions) {
		this.#opts = opts;
	}

	get roomCount(): number {
		return this.#rooms.size;
	}

	/** Called from the HTTP handler before upgrade to reject over-capacity hosts early. */
	canAcceptNewHost(roomId: string): boolean {
		return this.#rooms.has(roomId) || this.#rooms.size < this.#opts.maxRooms;
	}

	open(ws: RoomWebSocket): void {
		const { roomId, role } = ws.data;
		if (role === "host") {
			if (this.#rooms.has(roomId)) {
				ws.close(CLOSE_HOST_EXISTS, "a host is already connected for this room");
				return;
			}
			if (this.#rooms.size >= this.#opts.maxRooms) {
				ws.close(CLOSE_ROOM_FULL, "relay is at capacity");
				return;
			}
			this.#rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
			return;
		}
		const room = this.#rooms.get(roomId);
		if (!room) {
			ws.close(CLOSE_NO_SUCH_ROOM, "no such room");
			return;
		}
		if (room.guests.size >= this.#opts.maxGuestsPerRoom) {
			ws.close(CLOSE_ROOM_FULL, "room is at guest capacity");
			return;
		}
		const peerId = room.nextPeerId++;
		ws.data.peerId = peerId;
		room.guests.set(peerId, ws);
		room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
	}

	message(ws: RoomWebSocket, message: string | Buffer): void {
		if (typeof message === "string") return; // clients never send TEXT
		const room = this.#rooms.get(ws.data.roomId);
		if (!room) return;
		const bytes =
			message instanceof Buffer ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength) : message;
		if (ws.data.role === "host") {
			if (bytes.byteLength < ENVELOPE_HEADER_LENGTH) return;
			const peerId = new DataView(bytes.buffer, bytes.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
			if (peerId === 0) {
				for (const guest of room.guests.values()) guest.send(bytes);
			} else {
				room.guests.get(peerId)?.send(bytes);
			}
			return;
		}
		if (bytes.byteLength < ENVELOPE_HEADER_LENGTH) return;
		new DataView(bytes.buffer, bytes.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, ws.data.peerId, false);
		room.host.send(bytes);
	}

	close(ws: RoomWebSocket): void {
		const { roomId, role, peerId } = ws.data;
		const room = this.#rooms.get(roomId);
		if (!room) return;
		if (role === "host") {
			// A rejected second host already got its own close code; the live room is not its to tear down.
			if (room.host !== ws) return;
			this.#rooms.delete(roomId);
			const closure = JSON.stringify({ t: "room-closed" });
			for (const guest of room.guests.values()) {
				guest.send(closure);
				guest.close(CLOSE_ROOM_CLOSED, "room closed");
			}
			room.guests.clear();
			return;
		}
		if (room.guests.delete(peerId)) {
			room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
		}
	}

	/** Closes every live room. Used on graceful shutdown. */
	stopAll(): void {
		for (const room of this.#rooms.values()) {
			const closure = JSON.stringify({ t: "room-closed" });
			for (const guest of room.guests.values()) {
				guest.send(closure);
				guest.close(CLOSE_ROOM_CLOSED, "relay shutting down");
			}
			room.host.close(1001, "relay shutting down");
		}
		this.#rooms.clear();
	}
}
