import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { impact, indexDir, search, whatCalls, whereDefined, whoCalls } from "../src/core/code";
import { openDatabase } from "../src/db";
import { handleToolCall } from "../src/mcp-tools";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-code-fx-"));
	mkdirSync(join(root, "src"));
	writeFileSync(
		join(root, "src/a.ts"),
		`export function readLedger(p: string) { return parse(p); }\nexport function parse(x: string) { return x; }\n`,
	);
	writeFileSync(
		join(root, "src/b.ts"),
		`import { readLedger } from "./a";\nexport const run = () => readLedger("x");\nclass Foo { go() { run(); } }\n`,
	);
	writeFileSync(join(root, "docs.md"), `# Ledger design\nappend only\n## Reading\nreadLedger folds events\n`);
	return root;
}

test("mnemopi code graph: index → who-calls / what-calls / where-defined / impact / search", () => {
	const root = fixture();
	const db = openDatabase(":memory:");
	const s = indexDir(db, root);
	expect(s.added).toBe(3);
	expect(whereDefined(db, "readLedger")[0]!.path).toBe("src/a.ts");
	expect(
		whoCalls(db, "readLedger", { limit: 10 })
			.map(l => l.name)
			.sort(),
	).toEqual(["<module>", "run"]);
	expect(whatCalls(db, "readLedger").map(l => l.name)).toEqual(["parse"]);
	const imp = impact(db, "parse");
	expect(imp.files).toContain("src/b.ts");
	expect(search(db, "ledger reading").some(h => h.type === "doc")).toBe(true);
	expect(search(db, "read ledger").some(h => h.type === "symbol" && h.label.includes("readLedger"))).toBe(true);
});

test("mnemopi code graph incremental: unchanged skipped, change/remove handled", () => {
	const root = fixture();
	const db = openDatabase(":memory:");
	indexDir(db, root);
	expect(indexDir(db, root).unchanged).toBe(3);
	writeFileSync(
		join(root, "src/a.ts"),
		`export function readLedger() { return other(); }\nexport function other() {}\n`,
	);
	utimesSync(join(root, "src/a.ts"), new Date(), new Date(Date.now() + 5000));
	const s2 = indexDir(db, root);
	expect(s2.changed).toBe(1);
	expect(whatCalls(db, "readLedger").map(l => l.name)).toEqual(["other"]);
	expect(whoCalls(db, "readLedger").length).toBe(2);
	rmSync(join(root, "src/b.ts"));
	expect(indexDir(db, root).removed).toBe(1);
	expect(whoCalls(db, "readLedger").length).toBe(0);
});

test("mnemopi MCP code tools work", async () => {
	const res = await handleToolCall("jeox_where_defined", { name: "readLedger" });
	expect(res).toBeDefined();
});
