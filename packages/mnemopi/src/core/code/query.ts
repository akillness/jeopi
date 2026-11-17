import type { Database } from "bun:sqlite";

export interface Loc {
	name: string;
	kind: string;
	path: string;
	start: number;
	end: number;
	conf?: string;
}
export interface QOpts {
	limit?: number;
	strict?: boolean;
}

const confSql = (strict?: boolean) => (strict ? "AND e.conf <> 'name'" : "");
export const isTestPath = (p: string) => /(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
const SEL = `n.name name, n.kind kind, f.path path, n.start_line start, n.end_line end`;
const ORDER =
	"ORDER BY CASE MIN(e.conf) WHEN 'import' THEN 0 WHEN 'local' THEN 1 ELSE 2 END, n.name, f.path, n.start_line";

export const whereDefined = (db: Database, name: string, limit = 5): Loc[] =>
	db
		.query(
			`SELECT ${SEL} FROM code_nodes n JOIN code_files f ON f.id=n.file_id WHERE n.name=? AND n.kind<>'module' LIMIT ?`,
		)
		.all(name, limit) as Loc[];

export const whoCalls = (db: Database, name: string, o: QOpts = {}): Loc[] =>
	db
		.query(`SELECT ${SEL}, MIN(e.conf) conf FROM code_edges e JOIN code_nodes d ON d.id=e.dst_id JOIN code_nodes n ON n.id=e.src_id
            JOIN code_files f ON f.id=n.file_id WHERE d.name=? AND e.kind IN ('calls','imports','extends','references') ${confSql(o.strict)}
            GROUP BY n.id ${ORDER} LIMIT ?`)
		.all(name, o.limit ?? 5) as Loc[];

export const whatCalls = (db: Database, name: string, o: QOpts = {}): Loc[] =>
	db
		.query(`SELECT ${SEL}, MIN(e.conf) conf FROM code_edges e JOIN code_nodes s ON s.id=e.src_id JOIN code_nodes n ON n.id=e.dst_id
            JOIN code_files f ON f.id=n.file_id WHERE s.name=? AND e.kind='calls' ${confSql(o.strict)}
            GROUP BY n.id ${ORDER} LIMIT ?`)
		.all(name, o.limit ?? 5) as Loc[];

export function impact(
	db: Database,
	target: string,
	depth = 3,
	limit = 20,
	strict = false,
): { files: string[]; tests: string[]; symbols: Loc[] } {
	let seeds = db
		.query("SELECT n.id FROM code_nodes n JOIN code_files f ON f.id=n.file_id WHERE f.path=?")
		.all(target) as { id: number }[];
	if (!seeds.length)
		seeds = db.query("SELECT id FROM code_nodes WHERE name=? AND kind<>'module'").all(target) as { id: number }[];
	const seen = new Set(seeds.map(s => s.id));
	let frontier = [...seen];
	for (let d = 0; d < depth && frontier.length; d++) {
		const rows = db
			.query(
				`SELECT DISTINCT src_id id FROM code_edges WHERE ${strict ? "conf <> 'name' AND " : ""}dst_id IN (${frontier.map(() => "?").join(",")})`,
			)
			.all(...frontier) as { id: number }[];
		frontier = rows.map(r => r.id).filter(id => !seen.has(id));
		frontier.forEach(id => {
			seen.add(id);
		});
	}
	const ids = [...seen].slice(0, 500);
	if (!ids.length) return { files: [], tests: [], symbols: [] };
	const syms = db
		.query(
			`SELECT ${SEL} FROM code_nodes n JOIN code_files f ON f.id=n.file_id WHERE n.id IN (${ids.map(() => "?").join(",")})`,
		)
		.all(...ids) as Loc[];
	const all = [...new Set(syms.filter(s => s.path !== target).map(s => s.path))];
	return {
		files: all.filter(p => !isTestPath(p)).slice(0, limit),
		tests: all.filter(isTestPath).slice(0, limit),
		symbols: syms.filter(s => s.kind !== "module" && !isTestPath(s.path)).slice(0, limit),
	};
}

const STOP = new Set([
	"the",
	"and",
	"for",
	"with",
	"how",
	"what",
	"where",
	"this",
	"that",
	"from",
	"into",
	"are",
	"does",
]);
const ftsQuery = (text: string) => {
	const expanded = `${text} ${text.replace(/([a-z0-9])([A-Z])/g, "$1 $2")}`;
	const toks = [
		...new Set(
			expanded
				.toLowerCase()
				.split(/[^\p{L}\p{N}]+/u)
				.map(t => t.replace(/"/g, ""))
				.filter(t => (t.length >= 3 || (/[^\x00-\x7f]/.test(t) && t.length >= 2)) && !STOP.has(t)),
		),
	];
	return toks.map(t => `"${t}"*`).join(" OR ");
};

export type Hit = { type: "symbol" | "doc"; path: string; start: number; end: number; label: string };

export function search(db: Database, text: string, limit = 5): Hit[] {
	const q = ftsQuery(text);
	if (!q) return [];
	const sym = db
		.query(`SELECT 'symbol' type, f.path path, n.start_line start, n.end_line end, n.kind||' '||n.name label
    FROM code_nodes_fts x JOIN code_nodes n ON n.id=x.rowid JOIN code_files f ON f.id=n.file_id
    WHERE code_nodes_fts MATCH ? ORDER BY bm25(code_nodes_fts) LIMIT ?`)
		.all(q, limit) as Hit[];
	const doc = db
		.query(`SELECT 'doc' type, f.path path, c.start_line start, c.end_line end, c.heading label
    FROM code_chunks_fts x JOIN code_chunks c ON c.id=x.rowid JOIN code_files f ON f.id=c.file_id
    WHERE code_chunks_fts MATCH ? ORDER BY bm25(code_chunks_fts) LIMIT ?`)
		.all(q, limit) as Hit[];
	return [...sym, ...doc].slice(0, limit * 2);
}

export const stats = (db: Database) => ({
	files: (db.query("SELECT COUNT(*) c FROM code_files").get() as any).c,
	nodes: (db.query("SELECT COUNT(*) c FROM code_nodes").get() as any).c,
	edges: (db.query("SELECT COUNT(*) c FROM code_edges").get() as any).c,
	chunks: (db.query("SELECT COUNT(*) c FROM code_chunks").get() as any).c,
});
