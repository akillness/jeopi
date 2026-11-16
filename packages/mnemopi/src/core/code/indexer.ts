import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { chunkMarkdown } from "./chunk-md";
import { rebuildEdges } from "./edges";
import { extractScript, isScript } from "./extract";

const IGNORE_DIRS = new Set([
	"node_modules",
	"dist",
	".git",
	".jeopi",
	".jeo",
	".mex",
	"coverage",
	"build",
	"graphify-out",
	"llm-wiki",
	"Library",
	"gen",
	"target",
]);
const MAX_FILE_BYTES = 1_000_000;

export interface IndexStats {
	scanned: number;
	added: number;
	changed: number;
	removed: number;
	unchanged: number;
	ms: number;
}

const words = (name: string) =>
	name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_\-.<>]/g, " ")
		.toLowerCase();

function* walk(root: string, dir = root): Generator<string> {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name.startsWith(".") && e.isDirectory() && e.name !== ".") continue;
		if (e.isDirectory()) {
			if (!IGNORE_DIRS.has(e.name)) yield* walk(root, join(dir, e.name));
		} else if (e.isFile() && (isScript(e.name) || e.name.endsWith(".md"))) yield join(dir, e.name);
	}
}

export function indexDir(db: Database, root: string, opts: { rebuild?: boolean } = {}): IndexStats {
	const t0 = performance.now();
	const st: IndexStats = { scanned: 0, added: 0, changed: 0, removed: 0, unchanged: 0, ms: 0 };
	if (opts.rebuild) db.exec("DELETE FROM code_nodes_fts; DELETE FROM code_chunks_fts; DELETE FROM code_files;");
	const existing = new Map<string, { id: number; digest: string; mtime: number }>();
	for (const r of db.query("SELECT id, path, digest, mtime FROM code_files").all() as any[]) existing.set(r.path, r);

	const delFts = db.prepare("DELETE FROM code_nodes_fts WHERE rowid IN (SELECT id FROM code_nodes WHERE file_id = ?)");
	const delChunkFts = db.prepare(
		"DELETE FROM code_chunks_fts WHERE rowid IN (SELECT id FROM code_chunks WHERE file_id = ?)",
	);
	const delFile = db.prepare("DELETE FROM code_files WHERE id = ?");
	const insFile = db.prepare(
		"INSERT INTO code_files(path, lang, digest, mtime, indexed_at) VALUES (?,?,?,?,?) RETURNING id",
	);
	const updFile = db.prepare("UPDATE code_files SET digest=?, mtime=?, indexed_at=? WHERE id=?");
	const insNode = db.prepare(
		"INSERT INTO code_nodes(file_id,name,kind,start_line,end_line,exported) VALUES (?,?,?,?,?,?) RETURNING id",
	);
	const insRef = db.prepare("INSERT INTO code_refs(src_id,name,kind,recv) VALUES (?,?,?,?)");
	const insImp = db.prepare("INSERT INTO code_imports(file_id,spec,imported,local,reexport) VALUES (?,?,?,?,?)");
	const insNodeFts = db.prepare("INSERT INTO code_nodes_fts(rowid,name,words) VALUES (?,?,?)");
	const insChunk = db.prepare(
		"INSERT INTO code_chunks(file_id,heading,start_line,end_line,text) VALUES (?,?,?,?,?) RETURNING id",
	);
	const insChunkFts = db.prepare("INSERT INTO code_chunks_fts(rowid,heading,text) VALUES (?,?,?)");
	const clearFile = (id: number) => {
		delFts.run(id);
		delChunkFts.run(id);
	};

	const work = db.transaction(() => {
		const seen = new Set<string>();
		for (const abs of walk(root)) {
			const rel = relative(root, abs);
			seen.add(rel);
			st.scanned++;
			const stat = statSync(abs);
			if (stat.size > MAX_FILE_BYTES) continue;
			const mtime = Math.floor(stat.mtimeMs);
			const prev = existing.get(rel);
			if (prev && prev.mtime === mtime) {
				st.unchanged++;
				continue;
			}
			const text = readFileSync(abs, "utf8");
			const digest = Bun.hash(text).toString(36);
			if (prev && prev.digest === digest) {
				updFile.run(digest, mtime, new Date().toISOString(), prev.id);
				st.unchanged++;
				continue;
			}
			let fileId: number;
			if (prev) {
				clearFile(prev.id);
				db.query("DELETE FROM code_nodes WHERE file_id = ?").run(prev.id);
				db.query("DELETE FROM code_chunks WHERE file_id = ?").run(prev.id);
				updFile.run(digest, mtime, new Date().toISOString(), prev.id);
				fileId = prev.id;
				st.changed++;
			} else {
				const lang = isScript(rel) ? "script" : "markdown";
				fileId = (insFile.get(rel, lang, digest, mtime, new Date().toISOString()) as { id: number }).id;
				st.added++;
			}
			if (isScript(rel)) {
				const ex = extractScript(rel, text);
				for (const i of ex.imports) insImp.run(fileId, i.spec, i.imported, i.local, i.reexport ? 1 : 0);
				for (const n of ex.nodes) {
					const id = (
						insNode.get(fileId, n.name, n.kind, n.startLine, n.endLine, n.exported ? 1 : 0) as { id: number }
					).id;
					if (n.kind !== "module") insNodeFts.run(id, n.name, words(n.name));
					for (const r of n.refs) insRef.run(id, r.name, r.kind, r.recv);
				}
			} else {
				for (const c of chunkMarkdown(text)) {
					const id = (insChunk.get(fileId, c.heading, c.startLine, c.endLine, c.text) as { id: number }).id;
					insChunkFts.run(id, c.heading, c.text);
				}
			}
		}
		for (const [path, r] of existing)
			if (!seen.has(path)) {
				clearFile(r.id);
				delFile.run(r.id);
				st.removed++;
			}
		rebuildEdges(db);
	});
	work();
	st.ms = +(performance.now() - t0).toFixed(1);
	return st;
}
