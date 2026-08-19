import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	BlobStore,
	externalizeImageData,
	isBlobRef,
	parseBlobRef,
	resolveImageData,
	resolveImageDataSync,
	resolveImageDataUrl,
} from "jeopi-cli/session/blob-store";

/**
 * Wire format of a blob reference. Pinned here on purpose: session JSONL files
 * written by older builds must keep parsing, so the prefix is a compatibility
 * contract and not an implementation detail.
 */
const PREFIX = "blob:sha256:";

/** SHA-256 of the empty byte string — a real digest, used as a canonical suffix. */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const tempRoots: string[] = [];

interface Harness {
	/** Temp root. The store lives *below* this, so `root` is "outside" the store. */
	root: string;
	storeDir: string;
	store: BlobStore;
}

/**
 * Nest the store two levels under the temp root so a traversal payload has
 * somewhere real to escape to that is still inside our own sandbox.
 */
async function makeHarness(create = true): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeopi-blob-store-"));
	tempRoots.push(root);
	const storeDir = path.join(root, "nested", "blobs");
	if (create) await fs.mkdir(storeDir, { recursive: true });
	return { root, storeDir, store: new BlobStore(storeDir) };
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

afterEach(async () => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("parseBlobRef", () => {
	it("returns the bare hash for a canonical ref", () => {
		expect(parseBlobRef(`${PREFIX}${EMPTY_SHA256}`)).toBe(EMPTY_SHA256);
	});

	it("accepts every lowercase hex digit in a suffix", () => {
		const allDigits = "0123456789abcdef".repeat(4);
		expect(allDigits).toHaveLength(64);
		expect(parseBlobRef(`${PREFIX}${allDigits}`)).toBe(allDigits);
	});

	// Each row is a suffix that must never reach `path.join(dir, hash)`.
	const rejected: Array<[name: string, input: string]> = [
		["a string with no blob prefix", "not-a-blob-ref"],
		["a bare hash carrying no prefix", EMPTY_SHA256],
		["a different digest algorithm", `blob:sha1:${EMPTY_SHA256}`],
		["a relative traversal payload", `${PREFIX}../../../etc/passwd`],
		["a traversal payload dressed as a hash segment", `${PREFIX}${EMPTY_SHA256}/../../../etc/passwd`],
		["an absolute path payload", `${PREFIX}/etc/passwd`],
		["uppercase hex", `${PREFIX}${EMPTY_SHA256.toUpperCase()}`],
		["63 hex chars", `${PREFIX}${EMPTY_SHA256.slice(0, 63)}`],
		["65 hex chars", `${PREFIX}${EMPTY_SHA256}a`],
		["a canonical hash with a trailing path segment", `${PREFIX}${EMPTY_SHA256}/x`],
		["a canonical hash with a trailing extension", `${PREFIX}${EMPTY_SHA256}.png`],
		["a non-hex character inside a 64-char suffix", `${PREFIX}${`${EMPTY_SHA256.slice(0, 63)}z`}`],
		["an empty suffix", PREFIX],
	];

	for (const [name, input] of rejected) {
		it(`returns null for ${name}`, () => {
			expect(parseBlobRef(input)).toBeNull();
		});
	}

	it("keeps recognition loose while the parse stays strict", () => {
		// session-loader routes anything `isBlobRef` accepts into resolution, so the
		// hostile ref *must* be recognized here — the parse is the only choke point.
		const hostile = `${PREFIX}../../../etc/passwd`;
		expect(isBlobRef(hostile)).toBe(true);
		expect(parseBlobRef(hostile)).toBeNull();
	});

	it("confines every accepted suffix to the store dir", async () => {
		const { storeDir } = await makeHarness();
		const candidates = [`${PREFIX}${EMPTY_SHA256}`, ...rejected.map(([, input]) => input)];

		for (const candidate of candidates) {
			const hash = parseBlobRef(candidate);
			if (hash === null) continue;
			// This is the join `get`/`getSync`/`has` perform verbatim.
			expect(path.join(storeDir, hash)).toBe(path.join(storeDir, path.basename(hash)));
			expect(path.resolve(storeDir, hash).startsWith(`${storeDir}${path.sep}`)).toBe(true);
		}
	});
});

describe("BlobStore path confinement", () => {
	it("cannot reach a sentinel outside the store dir through a traversal ref", async () => {
		const { root, storeDir, store } = await makeHarness();
		const sentinelPath = path.join(root, "outside-secret.txt");
		const sentinel = "SENTINEL-OUTSIDE-BLOB-DIR";
		await fs.writeFile(sentinelPath, sentinel, "utf8");

		// Derive the payload from the real paths instead of guessing a `../` count,
		// then prove it genuinely escapes — otherwise this test could pass against a
		// path that never left the store dir and would prove nothing.
		const escapeSuffix = path.relative(storeDir, sentinelPath);
		expect(escapeSuffix.startsWith("..")).toBe(true);
		expect(path.join(storeDir, escapeSuffix)).toBe(sentinelPath);
		expect(await fs.readFile(path.join(storeDir, escapeSuffix), "utf8")).toBe(sentinel);

		const hostileRef = `${PREFIX}${escapeSuffix}`;
		expect(isBlobRef(hostileRef)).toBe(true);
		const parsed = parseBlobRef(hostileRef);
		expect(parsed).toBeNull();

		// Drive the three accessors through the parse gate exactly as production does.
		// The calls are conditional on the *real* parse result, so before the guard
		// existed `parsed` was the raw `../..` slice and all three surfaced the sentinel.
		const viaGet = parsed === null ? null : await store.get(parsed);
		const viaGetSync = parsed === null ? null : store.getSync(parsed);
		const viaHas = parsed === null ? false : await store.has(parsed);

		expect(viaGet).toBeNull();
		expect(viaGetSync).toBeNull();
		expect(viaHas).toBe(false);
	});

	it("returns the hostile ref untouched from every resolver instead of the sentinel", async () => {
		const { root, storeDir, store } = await makeHarness();
		const sentinelPath = path.join(root, "outside-secret.txt");
		const sentinel = "SENTINEL-OUTSIDE-BLOB-DIR";
		await fs.writeFile(sentinelPath, sentinel, "utf8");

		const hostileRef = `${PREFIX}${path.relative(storeDir, sentinelPath)}`;
		expect(path.join(storeDir, path.relative(storeDir, sentinelPath))).toBe(sentinelPath);

		// These three are the actual attack surface: a crafted session file reaches
		// them via session-loader. Pre-guard they returned the sentinel's bytes.
		expect(await resolveImageData(store, hostileRef)).toBe(hostileRef);
		expect(resolveImageDataSync(store, hostileRef)).toBe(hostileRef);
		expect(await resolveImageDataUrl(store, hostileRef)).toBe(hostileRef);

		const leaked = [sentinel, Buffer.from(sentinel, "utf8").toString("base64")];
		for (const resolved of [
			await resolveImageData(store, hostileRef),
			resolveImageDataSync(store, hostileRef),
			await resolveImageDataUrl(store, hostileRef),
		]) {
			for (const secret of leaked) expect(resolved).not.toContain(secret);
		}

		// Resolution must not have created anything beside the store either.
		expect((await fs.readdir(root)).sort()).toEqual(["nested", "outside-secret.txt"]);
	});

	it("ignores an extension that would place a sidecar outside the store dir", async () => {
		const { root, storeDir, store } = await makeHarness();
		const data = Buffer.from("sidecar", "utf8");

		for (const extension of ["../../evil", "a/../../evil", "/abs-evil", "png/../../evil"]) {
			const result = await store.put(data, { extension });
			expect(result.displayPath).toBe(result.path);
			expect(result.path).toBe(path.join(storeDir, result.hash));
		}

		expect(await exists(path.join(root, "evil"))).toBe(false);
		expect((await fs.readdir(root)).sort()).toEqual(["nested"]);
		expect(await fs.readdir(storeDir)).toEqual([new Bun.SHA256().update(data).digest("hex")]);
	});

	it("keeps a legitimate sidecar inside the store dir", async () => {
		const { storeDir, store } = await makeHarness();
		const data = Buffer.from("legit", "utf8");
		const result = await store.put(data, { extension: "PNG" });

		expect(result.displayPath).toBe(`${result.path}.png`);
		expect(path.dirname(result.displayPath)).toBe(storeDir);
		expect(await fs.readFile(result.displayPath)).toEqual(data);
		// The ref still addresses the extensionless canonical path.
		expect(parseBlobRef(result.ref)).toBe(result.hash);
	});

	it("does not let a hostile image mime type escape the store dir", async () => {
		const { root, storeDir, store } = await makeHarness();
		const base64 = Buffer.from("mime-driven", "utf8").toString("base64");

		const ref = await externalizeImageData(store, base64, "image/../../evil");

		expect(parseBlobRef(ref)).not.toBeNull();
		expect(await exists(path.join(root, "evil"))).toBe(false);
		expect((await fs.readdir(root)).sort()).toEqual(["nested"]);

		// Exactly one file, named by the ref's own hash: no sidecar landed anywhere.
		const stored = await fs.readdir(storeDir);
		expect(stored).toHaveLength(1);
		expect(`${PREFIX}${stored[0]}`).toBe(ref);
	});
});

describe("BlobStore round trip", () => {
	it("returns identical bytes from get and getSync after put", async () => {
		const { storeDir, store } = await makeHarness();
		// Non-UTF8-safe bytes: a utf8 round trip anywhere in the path would corrupt these.
		const data = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01, 0xfe, 0xc3, 0x28]);

		const result = await store.put(data);

		expect(result.path).toBe(path.join(storeDir, result.hash));
		expect(result.displayPath).toBe(result.path);
		expect(result.ref).toBe(`${PREFIX}${result.hash}`);
		// put and parseBlobRef must agree, or every blob it writes is unreadable.
		expect(parseBlobRef(result.ref)).toBe(result.hash);

		expect(await store.get(result.hash)).toEqual(data);
		expect(store.getSync(result.hash)).toEqual(data);
		expect(await store.has(result.hash)).toBe(true);
	});

	it("reports absence for a well-formed hash that was never stored", async () => {
		const { store } = await makeHarness();
		const stored = await store.put(Buffer.from("present", "utf8"));
		const absent = "0".repeat(64);

		expect(absent).not.toBe(stored.hash);
		expect(parseBlobRef(`${PREFIX}${absent}`)).toBe(absent);

		expect(await store.get(absent)).toBeNull();
		expect(store.getSync(absent)).toBeNull();
		expect(await store.has(absent)).toBe(false);
		// The store still serves the blob that is actually there.
		expect(await store.has(stored.hash)).toBe(true);
	});

	it("addresses blobs by their real SHA-256 digest", async () => {
		const { store } = await makeHarness();
		// Known-answer vector: catches a swapped or truncated digest algorithm.
		expect((await store.put(Buffer.alloc(0))).hash).toBe(EMPTY_SHA256);
	});

	it("deduplicates identical bytes across put and putSync", async () => {
		const { storeDir, store } = await makeHarness();
		const data = Buffer.from("deduplicate me", "utf8");

		const first = await store.put(data);
		const second = await store.put(data);
		const third = store.putSync(data);

		expect(second.hash).toBe(first.hash);
		expect(third.hash).toBe(first.hash);
		expect(await fs.readdir(storeDir)).toEqual([first.hash]);
		expect(await store.get(first.hash)).toEqual(data);
	});

	it("creates the store dir on demand for both put and putSync", async () => {
		const asyncHarness = await makeHarness(false);
		const syncHarness = await makeHarness(false);
		const data = Buffer.from("lazy dir", "utf8");

		expect(await exists(asyncHarness.storeDir)).toBe(false);
		expect(await exists(syncHarness.storeDir)).toBe(false);

		const asyncResult = await asyncHarness.store.put(data);
		const syncResult = syncHarness.store.putSync(data);

		expect(await asyncHarness.store.get(asyncResult.hash)).toEqual(data);
		expect(syncHarness.store.getSync(syncResult.hash)).toEqual(data);
	});

	it("round-trips an externalized image through the resolver", async () => {
		const { store } = await makeHarness();
		const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]).toString("base64");

		const ref = await externalizeImageData(store, original, "image/png");

		expect(isBlobRef(ref)).toBe(true);
		expect(await resolveImageData(store, ref)).toBe(original);
		expect(resolveImageDataSync(store, ref)).toBe(original);
	});

	it("returns the ref unchanged when a well-formed blob is missing from disk", async () => {
		const { store } = await makeHarness();
		const missingRef = `${PREFIX}${"0".repeat(64)}`;

		expect(await resolveImageData(store, missingRef)).toBe(missingRef);
		expect(resolveImageDataSync(store, missingRef)).toBe(missingRef);
		expect(await resolveImageDataUrl(store, missingRef)).toBe(missingRef);
	});
});
