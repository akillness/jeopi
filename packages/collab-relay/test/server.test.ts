/**
 * Full-server integration: `startRelayServer` wired end to end (HTTP, share
 * store, static serving) against a real port with a temp data/web dir per test.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type RelayServerHandle, startRelayServer } from "../src/server";

let handle: RelayServerHandle | null = null;
let webRoot: string;
let dataDir: string;

async function makeTempDirs(): Promise<void> {
	webRoot = await fs.mkdtemp(path.join(os.tmpdir(), "collab-relay-web-"));
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-relay-data-"));
	await Bun.write(path.join(webRoot, "index.html"), "<!doctype html><title>spa</title>");
	await Bun.write(path.join(webRoot, "s", "share-viewer.html"), "<!doctype html><title>viewer</title>");
}

function baseUrl(): string {
	if (!handle) throw new Error("server not started");
	return `http://${handle.hostname === "0.0.0.0" ? "localhost" : handle.hostname}:${handle.port}`;
}

beforeEach(async () => {
	await makeTempDirs();
});

afterEach(async () => {
	await handle?.stop();
	handle = null;
	await fs.rm(webRoot, { recursive: true, force: true });
	await fs.rm(dataDir, { recursive: true, force: true });
});

describe("startRelayServer", () => {
	it("answers /healthz", async () => {
		handle = await startRelayServer({ port: 0, hostname: "127.0.0.1", webRoot, dataDir });
		const res = await fetch(`${baseUrl()}/healthz`);
		expect(res.status).toBe(200);
	});

	it("serves the SPA at / and falls back to index.html for unknown paths", async () => {
		handle = await startRelayServer({ port: 0, hostname: "127.0.0.1", webRoot, dataDir });
		const root = await fetch(`${baseUrl()}/`);
		expect(await root.text()).toContain("spa");

		const deepLink = await fetch(`${baseUrl()}/some/client/route`);
		expect(deepLink.status).toBe(200);
		expect(await deepLink.text()).toContain("spa");
	});

	it("round-trips a share upload through POST /s and GET /s/<id>/raw", async () => {
		handle = await startRelayServer({ port: 0, hostname: "127.0.0.1", webRoot, dataDir, shareMaxBytes: 1024 });
		const blob = new Uint8Array([1, 2, 3, 4, 5]);

		const upload = await fetch(`${baseUrl()}/s`, { method: "POST", body: blob });
		expect(upload.status).toBe(200);
		const { id } = (await upload.json()) as { id: string };
		expect(id).toMatch(/^[A-Za-z0-9_-]{10,64}$/);

		const raw = await fetch(`${baseUrl()}/s/${id}/raw`);
		expect(raw.status).toBe(200);
		expect(new Uint8Array(await raw.arrayBuffer())).toEqual(blob);

		const viewer = await fetch(`${baseUrl()}/s/${id}`);
		expect(viewer.status).toBe(200);
		expect(await viewer.text()).toContain("viewer");
	});

	it("rejects a share upload over the configured byte cap with 413", async () => {
		handle = await startRelayServer({ port: 0, hostname: "127.0.0.1", webRoot, dataDir, shareMaxBytes: 4 });
		const upload = await fetch(`${baseUrl()}/s`, { method: "POST", body: new Uint8Array(5) });
		expect(upload.status).toBe(413);
	});

	it("returns 404 for a raw fetch of an unknown share id", async () => {
		handle = await startRelayServer({ port: 0, hostname: "127.0.0.1", webRoot, dataDir });
		const res = await fetch(`${baseUrl()}/s/doesnotexist000000/raw`);
		expect(res.status).toBe(404);
	});

	it("rejects a room upgrade request with a missing or invalid role", async () => {
		handle = await startRelayServer({ port: 0, hostname: "127.0.0.1", webRoot, dataDir });
		const res = await fetch(`${baseUrl()}/r/SomeRoom_1234567`);
		expect(res.status).toBe(400);
	});
});
