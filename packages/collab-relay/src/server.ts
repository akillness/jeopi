/**
 * jeopi collab relay — self-hostable production replacement for the upstream
 * `my.omp.sh`. Implements the full contract documented in `docs/collab.md`
 * §Self-hosting the relay:
 *
 *   GET  /                    — static collab-web guest client (SPA)
 *   GET  /r/<roomId>          — WebSocket upgrade (?role=host|guest)
 *   POST /s                   — /share blob upload → { id }
 *   GET  /s/<id>               — share viewer page
 *   GET  /s/<id>/raw           — share blob fetch (application/octet-stream)
 *   GET  /healthz              — liveness
 *
 * Content-blind by construction: session payloads arrive pre-sealed
 * (AES-256-GCM) by the host/guest; this process only ever touches ciphertext
 * and the plaintext 4-byte peerId envelope prefix for routing.
 */
import { loadConfig, type RelayConfig } from "./config";
import { RoomManager, type RoomSocketData } from "./rooms";
import { ShareStore, ShareStoreCapacityError, ShareStoreNotFoundError, ShareStoreSizeError } from "./share-store";
import { StaticServer } from "./static";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const SHARE_ITEM_RE = /^\/s\/([A-Za-z0-9_-]{10,64})(\/raw)?$/;

/** Handle bundle returned by {@link startRelayServer}; `stop()` tears down the GC timer and every live room. */
export interface RelayServerHandle {
	port: number;
	hostname: string;
	stop(): Promise<void>;
}

export async function startRelayServer(overrides?: Partial<RelayConfig>): Promise<RelayServerHandle> {
	const config = { ...loadConfig(), ...overrides };
	const rooms = new RoomManager({ maxRooms: config.maxRooms, maxGuestsPerRoom: config.maxGuestsPerRoom });
	const shareStore = new ShareStore({
		dataDir: config.dataDir,
		maxBytes: config.shareMaxBytes,
		maxTotalBytes: config.shareMaxTotalBytes,
		ttlMs: config.shareTtlMs,
	});
	const staticServer = new StaticServer({ webRoot: config.webRoot });
	const viewerFile = Bun.file(`${config.webRoot}/s/share-viewer.html`);

	const gcTimer = setInterval(() => {
		shareStore.collectExpired().catch(err => console.error("[relay] share GC sweep failed:", err));
	}, config.shareGcIntervalMs);
	gcTimer.unref();

	const server = Bun.serve<RoomSocketData>({
		port: config.port,
		hostname: config.hostname,
		idleTimeout: 30,
		async fetch(req, srv): Promise<Response | undefined> {
			const url = new URL(req.url);
			const pathname = url.pathname;

			if (pathname === "/healthz") return new Response("ok");

			const roomMatch = ROOM_PATH_RE.exec(pathname);
			if (roomMatch) {
				const roomId = roomMatch[1] as string;
				const role = url.searchParams.get("role");
				if (role !== "host" && role !== "guest") {
					return new Response("role must be host or guest", { status: 400 });
				}
				if (role === "host" && !rooms.canAcceptNewHost(roomId)) {
					return new Response("relay is at capacity", { status: 503 });
				}
				const data: RoomSocketData = { roomId, role, peerId: 0 };
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("websocket upgrade required", { status: 426 });
			}

			if (pathname === "/s" && req.method === "POST") {
				const body = new Uint8Array(await req.arrayBuffer());
				try {
					const id = await shareStore.put(body);
					return Response.json({ id });
				} catch (err) {
					if (err instanceof ShareStoreSizeError) return new Response(err.message, { status: 413 });
					if (err instanceof ShareStoreCapacityError) return new Response(err.message, { status: 503 });
					console.error("[relay] share upload failed:", err);
					return new Response("upload failed", { status: 500 });
				}
			}

			const shareMatch = SHARE_ITEM_RE.exec(pathname);
			if (shareMatch) {
				const id = shareMatch[1] as string;
				const isRaw = shareMatch[2] === "/raw";
				if (isRaw) {
					try {
						const bytes = await shareStore.get(id);
						return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
					} catch (err) {
						if (err instanceof ShareStoreNotFoundError) return new Response("not found", { status: 404 });
						console.error("[relay] share fetch failed:", err);
						return new Response("fetch failed", { status: 500 });
					}
				}
				// The viewer page is id-agnostic — share-loader.js reads the id from
				// location.pathname client-side and fetches /s/<id>/raw itself.
				if (await viewerFile.exists()) return new Response(viewerFile);
				return new Response("share viewer not built — run `bun run build` first", { status: 404 });
			}

			return staticServer.serve(pathname);
		},
		websocket: {
			maxPayloadLength: config.wsMaxPayloadBytes,
			idleTimeout: config.wsIdleTimeoutSec,
			open(ws) {
				rooms.open(ws);
			},
			message(ws, message) {
				rooms.message(ws, message);
			},
			close(ws) {
				rooms.close(ws);
			},
		},
	});

	console.log(`[relay] listening on http://${server.hostname}:${server.port} (webRoot=${config.webRoot})`);

	return {
		port: server.port ?? config.port,
		hostname: server.hostname ?? config.hostname,
		async stop() {
			clearInterval(gcTimer);
			rooms.stopAll();
			await server.stop(true);
		},
	};
}

if (import.meta.main) {
	const handle = await startRelayServer();
	let stopping = false;
	const shutdown = (): void => {
		if (stopping) return;
		stopping = true;
		handle
			.stop()
			.catch(err => console.error("[relay] shutdown error:", err))
			.finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
