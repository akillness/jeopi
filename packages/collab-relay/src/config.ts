/**
 * Environment-driven configuration. Every value has a production-sane
 * default so `bun src/server.ts` runs with zero required env vars; override
 * via env for real deployments (data dir persistence, port binding, caps).
 */
import * as path from "node:path";

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envStr(name: string, fallback: string): string {
	const raw = process.env[name];
	return raw?.trim() ? raw.trim() : fallback;
}

export interface RelayConfig {
	/** TCP port to bind. Most PaaS providers inject `PORT`. */
	port: number;
	/** Bind hostname; `0.0.0.0` for containers, override for local-only. */
	hostname: string;
	/** Directory the built collab-web SPA + generated share-viewer.html live in. */
	webRoot: string;
	/** Directory sealed share blobs are persisted to (survives restarts). */
	dataDir: string;
	/** Hard cap on an uploaded share blob, mirrors coding-agent's `SERVER_MAX_SEALED_BYTES`. */
	shareMaxBytes: number;
	/** Share blobs older than this are swept on the periodic GC pass. */
	shareTtlMs: number;
	/** How often the share-store GC sweep runs. */
	shareGcIntervalMs: number;
	/** Max live rooms at once; a new host beyond this is rejected at upgrade. */
	maxRooms: number;
	/** Max guests per room; beyond this a joining guest is rejected. */
	maxGuestsPerRoom: number;
	/** WebSocket per-message cap; must cover a base64 inline image + JSON/seal overhead. */
	wsMaxPayloadBytes: number;
	/** Seconds of silence before Bun closes a websocket (protocol-level ping keeps it alive). */
	wsIdleTimeoutSec: number;
}

export function loadConfig(): RelayConfig {
	const dataDir = path.resolve(envStr("RELAY_DATA_DIR", ".data"));
	return {
		port: envInt("PORT", 8787),
		hostname: envStr("HOST", "0.0.0.0"),
		webRoot: path.resolve(envStr("RELAY_WEB_ROOT", "dist/web")),
		dataDir,
		shareMaxBytes: envInt("RELAY_SHARE_MAX_BYTES", 1_000_000),
		shareTtlMs: envInt("RELAY_SHARE_TTL_DAYS", 30) * 24 * 60 * 60 * 1000,
		shareGcIntervalMs: envInt("RELAY_SHARE_GC_INTERVAL_MIN", 60) * 60 * 1000,
		maxRooms: envInt("RELAY_MAX_ROOMS", 10_000),
		maxGuestsPerRoom: envInt("RELAY_MAX_GUESTS_PER_ROOM", 32),
		wsMaxPayloadBytes: envInt("RELAY_WS_MAX_PAYLOAD_BYTES", 48 * 1024 * 1024),
		wsIdleTimeoutSec: envInt("RELAY_WS_IDLE_TIMEOUT_SEC", 180),
	};
}
