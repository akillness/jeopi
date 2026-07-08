/**
 * Disk-backed store for `/share` sealed blobs. Mirrors the contract
 * coding-agent's `uploadToServer`/`share-loader.js` expect: POST returns a
 * `{ id }` matching `/^[A-Za-z0-9_-]{10,64}$/`, `GET /s/<id>/raw` returns the
 * raw sealed bytes.
 *
 * IDs are 22-char base64url (16 random bytes) — always outside the pure-hex
 * `GIST_ID_RE` shape the client uses to route between the GitHub gist API and
 * this store, so a relay-issued id can never be misrouted to gist fetching.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Rejects path traversal and anything the upload/fetch regexes wouldn't accept. */
const SHARE_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const ID_BYTES = 16;

export interface ShareStoreOptions {
	dataDir: string;
	maxBytes: number;
	/** Hard cap on the sum of all live (non-expired) blob bytes on disk. */
	maxTotalBytes: number;
	ttlMs: number;
}

export class ShareStoreSizeError extends Error {}
/** Thrown when a `put` would push total live storage over {@link ShareStoreOptions.maxTotalBytes}. */
export class ShareStoreCapacityError extends Error {}
export class ShareStoreNotFoundError extends Error {}

export class ShareStore {
	readonly #opts: ShareStoreOptions;
	#initialized: Promise<void> | null = null;
	// Sum of live blob bytes on disk. `POST /s` has no auth (matches the
	// upstream relay's public-upload contract — see docs/collab.md), so
	// without this an attacker can upload unboundedly many under-cap blobs
	// and exhaust the data volume. Tracked in memory instead of statting the
	// directory on every put; seeded from disk once on first use.
	#totalBytes = 0;

	constructor(opts: ShareStoreOptions) {
		this.#opts = opts;
	}

	async #ensureDir(): Promise<void> {
		this.#initialized ??= (async () => {
			await fs.mkdir(this.#opts.dataDir, { recursive: true });
			const entries = await fs.readdir(this.#opts.dataDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile() || !SHARE_ID_RE.test(entry.name)) continue;
				const stat = await fs.stat(path.join(this.#opts.dataDir, entry.name)).catch(() => null);
				if (stat) this.#totalBytes += stat.size;
			}
		})();
		await this.#initialized;
	}

	#pathFor(id: string): string {
		return path.join(this.#opts.dataDir, id);
	}

	/**
	 * Persists a sealed blob, returning its assigned id.
	 * Throws {@link ShareStoreSizeError} over the per-blob cap, or
	 * {@link ShareStoreCapacityError} if this upload would exceed the
	 * store-wide total-bytes cap.
	 */
	async put(sealed: Uint8Array): Promise<string> {
		if (sealed.byteLength > this.#opts.maxBytes) {
			throw new ShareStoreSizeError(
				`sealed blob ${sealed.byteLength} bytes exceeds ${this.#opts.maxBytes} byte cap`,
			);
		}
		await this.#ensureDir();
		if (this.#totalBytes + sealed.byteLength > this.#opts.maxTotalBytes) {
			throw new ShareStoreCapacityError(
				`store is at capacity (${this.#totalBytes}/${this.#opts.maxTotalBytes} bytes); try again after the next GC sweep`,
			);
		}
		// Reserve space before the write completes to tighten the race window
		// between concurrent puts both observing capacity under the cap.
		this.#totalBytes += sealed.byteLength;
		let id: string;
		do {
			id = Buffer.from(crypto.getRandomValues(new Uint8Array(ID_BYTES))).toString("base64url");
		} while (!SHARE_ID_RE.test(id));
		try {
			await Bun.write(this.#pathFor(id), sealed);
		} catch (err) {
			this.#totalBytes -= sealed.byteLength;
			throw err;
		}
		return id;
	}

	/** Reads a stored blob's raw bytes. Throws {@link ShareStoreNotFoundError} for a missing/expired id. */
	async get(id: string): Promise<Uint8Array> {
		if (!SHARE_ID_RE.test(id)) throw new ShareStoreNotFoundError(id);
		const file = Bun.file(this.#pathFor(id));
		try {
			return new Uint8Array(await file.arrayBuffer());
		} catch (err) {
			if (err instanceof Error && "code" in err && err.code === "ENOENT") throw new ShareStoreNotFoundError(id);
			throw err;
		}
	}

	/** Deletes every blob whose mtime is older than `ttlMs`. Returns the count removed. */
	async collectExpired(): Promise<number> {
		await this.#ensureDir();
		const cutoff = Date.now() - this.#opts.ttlMs;
		const entries = await fs.readdir(this.#opts.dataDir, { withFileTypes: true });
		let removed = 0;
		for (const entry of entries) {
			if (!entry.isFile() || !SHARE_ID_RE.test(entry.name)) continue;
			const filePath = path.join(this.#opts.dataDir, entry.name);
			const stat = await fs.stat(filePath).catch(() => null);
			if (stat && stat.mtimeMs < cutoff) {
				await fs.rm(filePath, { force: true });
				this.#totalBytes = Math.max(0, this.#totalBytes - stat.size);
				removed++;
			}
		}
		return removed;
	}
}
