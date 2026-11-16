import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { impact, indexDir, openCodeDatabase, search, whatCalls, whereDefined, whoCalls } from "../src/core/code";
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

test("openDatabase keeps memory DBs isolated from code_* schema while openCodeDatabase initializes SCHEMA v1", () => {
	const memDb = openDatabase(":memory:");
	try {
		const codeTbl = memDb.query("SELECT name FROM sqlite_master WHERE type='table' AND name='code_files'").get();
		expect(codeTbl).toBeNull();
	} finally {
		memDb.close();
	}

	const codeDb = openCodeDatabase(":memory:");
	try {
		const codeTbl = codeDb.query("SELECT name FROM sqlite_master WHERE type='table' AND name='code_files'").get();
		expect(codeTbl).not.toBeNull();
		const ver = codeDb.query("SELECT MAX(version) v FROM schema_versions").get() as { v: number | null };
		expect(ver.v).toBe(1);
	} finally {
		codeDb.close();
	}
});

test("mnemopi code graph: index → who-calls / what-calls / where-defined / impact / search", () => {
	const root = fixture();
	const db = openCodeDatabase(":memory:");
	try {
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
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("mnemopi code graph incremental: unchanged skipped, change/remove and import cleanup handled", () => {
	const root = fixture();
	const db = openCodeDatabase(":memory:");
	try {
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

		writeFileSync(join(root, "src/b.ts"), `export const run = () => 1;\n`);
		utimesSync(join(root, "src/b.ts"), new Date(), new Date(Date.now() + 10000));
		indexDir(db, root);
		const imps = db.query("SELECT COUNT(*) c FROM code_imports").get() as { c: number };
		expect(imps.c).toBe(0);
		expect(whoCalls(db, "readLedger").length).toBe(0);

		rmSync(join(root, "src/b.ts"));
		expect(indexDir(db, root).removed).toBe(1);
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("mnemopi code graph FTS5 supports Unicode/Korean and camelCase queries", () => {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-code-ko-"));
	const db = openCodeDatabase(":memory:");
	try {
		writeFileSync(join(root, "README.ko.md"), `# 아키텍처 설계\n메모리 코드 그래프 엔진입니다.\n`);
		writeFileSync(join(root, "mod.ts"), `export function parseLedgerEntry() { return 1; }\n`);
		indexDir(db, root);
		expect(
			search(db, "parseLedgerEntry").some(h => h.type === "symbol" && h.label.includes("parseLedgerEntry")),
		).toBe(true);
		expect(search(db, "메모리 그래프").some(h => h.type === "doc" && h.path === "README.ko.md")).toBe(true);
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("mnemopi MCP & CLI code tools target .jeopi/db/jeo.db without leaking cwd DBs", async () => {
	const root = fixture();
	const prevEnv = process.env.MNEMOPI_CODE_DB_PATH;
	delete process.env.MNEMOPI_CODE_DB_PATH;
	try {
		const res = await handleToolCall("jeox_where_defined", { name: "readLedger", root });
		expect(Array.isArray(res.results)).toBe(true);
		expect((res.results as Array<{ path: string }>)[0]?.path).toBe("src/a.ts");
		expect(existsSync(join(root, ".jeopi", "db", "jeo.db"))).toBe(true);
		expect(existsSync(join(root, ".jeo"))).toBe(false);

		const lines: string[] = [];
		const dbFile = join(root, ".jeopi", "db", "jeo.db");
		const code = await runCli(["where-defined", "--limit", "2", "--db", dbFile, "readLedger"], {
			stdout: { write: s => lines.push(s) },
			stderr: { write: () => {} },
		});
		expect(code).toBe(0);
		expect(lines.join("")).toContain("src/a.ts");
	} finally {
		if (prevEnv === undefined) delete process.env.MNEMOPI_CODE_DB_PATH;
		else process.env.MNEMOPI_CODE_DB_PATH = prevEnv;
		rmSync(root, { recursive: true, force: true });
	}
});
