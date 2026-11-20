import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexDir, openCodeDatabase, search } from "../src/core/code";

test("code index incrementally indexes safe text regardless of extension and removes stale chunks", () => {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-text-index-"));
	const db = openCodeDatabase(":memory:");
	try {
		mkdirSync(join(root, ".jeo", "db"), { recursive: true });
		writeFileSync(join(root, "settings.conf"), "cobaltmarker strategy\nretain history");
		writeFileSync(join(root, "extensionless"), "quartz propagation protocol");
		writeFileSync(join(root, ".env"), "password=known_sensitive_value");
		writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
		writeFileSync(join(root, ".jeo", "db", "jeo.db"), "selfIndexSentinel");

		const first = indexDir(db, root);
		expect(first.added).toBe(2);
		expect(search(db, "cobaltmarker").some(hit => hit.path === "settings.conf")).toBe(true);
		expect(search(db, "quartz propagation").some(hit => hit.path === "extensionless")).toBe(true);
		expect(search(db, "known_sensitive_value selfIndexSentinel")).toHaveLength(0);
		expect(db.query("SELECT COUNT(*) AS count FROM code_files").get()).toEqual({ count: 2 });

		writeFileSync(join(root, "settings.conf"), "onyxmarker strategy\nretain history");
		const update = indexDir(db, root);
		expect(update.changed).toBe(1);
		expect(search(db, "cobaltmarker")).toHaveLength(0);
		expect(search(db, "onyxmarker").some(hit => hit.path === "settings.conf")).toBe(true);

		rmSync(join(root, "extensionless"));
		const deletion = indexDir(db, root);
		expect(deletion.removed).toBe(1);
		expect(search(db, "quartz propagation")).toHaveLength(0);
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
