import type { Database } from "bun:sqlite";
import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
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

const MAX_WIKI_FILES = 40;
const WIKI_SUBDIRS = ["projects", "concepts", "entities", "reports", "queries"] as const;

function isTempWorkspace(root: string): boolean {
	let target = resolve(root);
	try {
		target = realpathSync(target);
	} catch {}
	let sysTmp = resolve(tmpdir());
	try {
		sysTmp = realpathSync(sysTmp);
	} catch {}
	return (
		target === sysTmp ||
		target.startsWith(`${sysTmp}/`) ||
		target.startsWith("/tmp/") ||
		target.startsWith("/private/tmp/") ||
		target.startsWith("/var/folders/") ||
		target.startsWith("/private/var/folders/")
	);
}

function collectMarkdownFiles(dir: string, out: Array<{ absPath: string; mtimeMs: number }>): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) collectMarkdownFiles(full, out);
		else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
			try {
				out.push({ absPath: full, mtimeMs: statSync(full).mtimeMs });
			} catch {}
		}
	}
}

export function discoverProjectWikiFiles(
	root: string,
	explicitWikiRoot?: string,
): Array<{ virtualPath: string; absPath: string }> {
	const envVault = process.env.JEO_WIKI_ROOT?.trim() || process.env.LLM_WIKI_VAULT?.trim();
	const vaultRoot =
		explicitWikiRoot?.trim() || envVault || (isTempWorkspace(root) ? "" : join(homedir(), "vaults", "llm-wiki"));
	if (!vaultRoot) return [];
	const wikiDir = join(vaultRoot, "wiki");
	let realWikiDir = wikiDir;
	try {
		if (!statSync(wikiDir).isDirectory()) return [];
		realWikiDir = realpathSync(wikiDir);
	} catch {
		return [];
	}

	const projectSlug = basename(resolve(root)).toLowerCase();
	if (projectSlug.length < 2) return [];

	const matched: Array<{ absPath: string; mtimeMs: number; priority: number }> = [];
	const seenAbs = new Set<string>();
	const pushMatch = (absPath: string, mtimeMs: number, priority: number) => {
		if (seenAbs.has(absPath)) return;
		seenAbs.add(absPath);
		matched.push({ absPath, mtimeMs, priority });
	};

	const projectsDir = join(realWikiDir, "projects");
	const subFiles: Array<{ absPath: string; mtimeMs: number }> = [];
	collectMarkdownFiles(join(projectsDir, projectSlug), subFiles);
	for (const f of subFiles) pushMatch(f.absPath, f.mtimeMs, 0);

	try {
		for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
			if (!entry.isFile() || !/\.(md|mdx)$/i.test(entry.name)) continue;
			if (!entry.name.toLowerCase().includes(projectSlug)) continue;
			const absPath = join(projectsDir, entry.name);
			try {
				pushMatch(absPath, statSync(absPath).mtimeMs, 0);
			} catch {}
		}
	} catch {}

	for (const sub of WIKI_SUBDIRS) {
		if (sub === "projects") continue;
		const subDir = join(realWikiDir, sub);
		let entries: Dirent[];
		try {
			entries = readdirSync(subDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !/\.(md|mdx)$/i.test(entry.name)) continue;
			if (!entry.name.toLowerCase().includes(projectSlug)) continue;
			const absPath = join(subDir, entry.name);
			try {
				pushMatch(absPath, statSync(absPath).mtimeMs, 1);
			} catch {}
		}
	}

	matched.sort((a, b) => a.priority - b.priority || b.mtimeMs - a.mtimeMs);
	return matched.slice(0, MAX_WIKI_FILES).map(({ absPath }) => ({
		virtualPath: `@wiki/${relative(realWikiDir, absPath).replaceAll("\\", "/")}`,
		absPath,
	}));
}

function extractWikiRefs(text: string): string[] {
	const refs = new Set<string>();
	for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_]{2,})`/g)) {
		if (m[1]) refs.add(m[1]);
		if (refs.size >= 64) break;
	}
	return [...refs];
}

export function indexDir(db: Database, root: string, opts: { rebuild?: boolean; wikiRoot?: string } = {}): IndexStats {
	const t0 = performance.now();
	const st: IndexStats = { scanned: 0, added: 0, changed: 0, removed: 0, unchanged: 0, ms: 0 };
	if (opts.rebuild) db.exec("DELETE FROM code_nodes_fts; DELETE FROM code_chunks_fts; DELETE FROM code_files;");
	const existing = new Map<string, { id: number; digest: string; mtime: number }>();
	for (const r of db.query("SELECT id, path, digest, mtime FROM code_files").all() as any[]) existing.set(r.path, r);

	const delFts = db.prepare("DELETE FROM code_nodes_fts WHERE rowid IN (SELECT id FROM code_nodes WHERE file_id = ?)");
	const delChunkFts = db.prepare(
		"DELETE FROM code_chunks_fts WHERE rowid IN (SELECT id FROM code_chunks WHERE file_id = ?)",
	);
	const delNodes = db.prepare("DELETE FROM code_nodes WHERE file_id = ?");
	const delChunks = db.prepare("DELETE FROM code_chunks WHERE file_id = ?");
	const delImps = db.prepare("DELETE FROM code_imports WHERE file_id = ?");
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

	const wikiEntries = discoverProjectWikiFiles(root, opts?.wikiRoot).map(w => ({
		rel: w.virtualPath,
		abs: w.absPath,
		isWiki: true,
	}));
	const allEntries = [
		...[...walk(root)].map(abs => ({ rel: relative(root, abs), abs, isWiki: false })),
		...wikiEntries,
	];

	const work = db.transaction(() => {
		const seen = new Set<string>();
		for (const { rel, abs, isWiki } of allEntries) {
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
				delNodes.run(prev.id);
				delChunks.run(prev.id);
				delImps.run(prev.id);
				updFile.run(digest, mtime, new Date().toISOString(), prev.id);
				fileId = prev.id;
				st.changed++;
			} else {
				const lang = isWiki ? "wiki" : isScript(rel) ? "script" : "markdown";
				fileId = (insFile.get(rel, lang, digest, mtime, new Date().toISOString()) as { id: number }).id;
				st.added++;
			}
			if (!isWiki && isScript(rel)) {
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
				if (isWiki) {
					const refs = extractWikiRefs(text);
					if (refs.length > 0) {
						const lineCount = Math.max(1, text.split("\n").length);
						const nodeId = (insNode.get(fileId, rel, "wiki", 1, lineCount, 0) as { id: number }).id;
						for (const ident of refs) insRef.run(nodeId, ident, "references", "");
					}
				}
			}
		}
		for (const [path, r] of existing)
			if (!seen.has(path)) {
				clearFile(r.id);
				delFile.run(r.id);
				st.removed++;
			}
		const needsEdges =
			Boolean(opts.rebuild) ||
			st.added > 0 ||
			st.changed > 0 ||
			st.removed > 0 ||
			(db.query("SELECT 1 FROM code_edges LIMIT 1").get() === null &&
				db.query("SELECT 1 FROM code_refs LIMIT 1").get() !== null);
		if (needsEdges) rebuildEdges(db);
	});
	work();
	st.ms = +(performance.now() - t0).toFixed(1);
	return st;
}
