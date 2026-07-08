import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ShareStore, ShareStoreCapacityError, ShareStoreNotFoundError, ShareStoreSizeError } from "../src/share-store";

let dataDir: string;
let store: ShareStore;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-relay-share-"));
	store = new ShareStore({ dataDir, maxBytes: 16, maxTotalBytes: 1_000_000, ttlMs: 24 * 60 * 60 * 1000 });
});

afterEach(async () => {
	await fs.rm(dataDir, { recursive: true, force: true });
});

describe("ShareStore", () => {
	it("round-trips a blob under the size cap", async () => {
		const blob = new Uint8Array([1, 2, 3, 4, 5]);
		const id = await store.put(blob);
		expect(id).toMatch(/^[A-Za-z0-9_-]{10,64}$/);
		expect(await store.get(id)).toEqual(blob);
	});

	it("issues ids that never match the client's pure-hex gist-routing shape", async () => {
		// share-loader.js routes /^[0-9a-f]{20,64}$/ ids to the GitHub gist API
		// instead of this store's /raw endpoint; a relay-issued id landing in
		// that shape would silently misroute every viewer that loads it.
		for (let i = 0; i < 50; i++) {
			const id = await store.put(new Uint8Array([i]));
			expect(id).not.toMatch(/^[0-9a-f]{20,64}$/);
		}
	});

	it("rejects blobs over the configured byte cap", async () => {
		await expect(store.put(new Uint8Array(17))).rejects.toBeInstanceOf(ShareStoreSizeError);
	});

	it("throws ShareStoreNotFoundError for an unknown id", async () => {
		await expect(store.get("nonexistent000000000")).rejects.toBeInstanceOf(ShareStoreNotFoundError);
	});

	it("throws ShareStoreNotFoundError for a malformed id without touching the filesystem", async () => {
		await expect(store.get("../../etc/passwd")).rejects.toBeInstanceOf(ShareStoreNotFoundError);
		await expect(store.get("short")).rejects.toBeInstanceOf(ShareStoreNotFoundError);
	});

	it("sweeps blobs older than the TTL and keeps fresh ones", async () => {
		// `store`'s configured TTL is 24h (see beforeEach).
		const freshId = await store.put(new Uint8Array([9]));
		const staleId = await store.put(new Uint8Array([8]));
		// Backdate the stale blob's mtime past the TTL deterministically instead
		// of sleeping past a real wall-clock TTL.
		const staleMtime = new Date(Date.now() - 25 * 60 * 60 * 1000);
		await fs.utimes(path.join(dataDir, staleId), staleMtime, staleMtime);

		const removed = await store.collectExpired();
		expect(removed).toBe(1);
		await expect(store.get(staleId)).rejects.toBeInstanceOf(ShareStoreNotFoundError);
		expect(await store.get(freshId)).toEqual(new Uint8Array([9]));
	});

	it("rejects a put that would exceed the store-wide total-bytes cap", async () => {
		const capped = new ShareStore({ dataDir, maxBytes: 16, maxTotalBytes: 10, ttlMs: 24 * 60 * 60 * 1000 });
		await capped.put(new Uint8Array(6));
		await expect(capped.put(new Uint8Array(5))).rejects.toBeInstanceOf(ShareStoreCapacityError);
		// A put that fits under the remaining headroom still succeeds.
		await expect(capped.put(new Uint8Array(4))).resolves.toBeDefined();
	});

	it("seeds the total-bytes cap from existing disk contents on first use", async () => {
		// Simulate a restart: blobs already on disk before the store is constructed.
		await fs.writeFile(path.join(dataDir, "AAAAAAAAAAAAAAAAAAAAAA"), new Uint8Array(8));
		const reopened = new ShareStore({ dataDir, maxBytes: 16, maxTotalBytes: 10, ttlMs: 24 * 60 * 60 * 1000 });
		await expect(reopened.put(new Uint8Array(5))).rejects.toBeInstanceOf(ShareStoreCapacityError);
	});

	it("frees total-bytes headroom when the GC sweep removes expired blobs", async () => {
		const capped = new ShareStore({ dataDir, maxBytes: 16, maxTotalBytes: 10, ttlMs: 24 * 60 * 60 * 1000 });
		const staleId = await capped.put(new Uint8Array(8));
		const staleMtime = new Date(Date.now() - 25 * 60 * 60 * 1000);
		await fs.utimes(path.join(dataDir, staleId), staleMtime, staleMtime);
		await expect(capped.put(new Uint8Array(5))).rejects.toBeInstanceOf(ShareStoreCapacityError);

		await capped.collectExpired();
		await expect(capped.put(new Uint8Array(5))).resolves.toBeDefined();
	});
});
