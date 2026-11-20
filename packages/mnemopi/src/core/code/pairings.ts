import type { Database } from "bun:sqlite";

export interface PairedHit {
	wikiPath: string;
	path: string;
	start: number;
	end: number;
	pairId: number;
	heading: string;
	text: string;
}

interface ProjectFile {
	id: number;
	path: string;
}

interface WikiChunk {
	id: number;
	path: string;
	text: string;
}

const PATH_TOKEN = /[\w@.-]+(?:\/[\w@.-]+)*/g;
const QUERY_STOP = new Set(["the", "and", "for", "with", "how", "what", "where", "this", "that", "from", "into"]);

function makeFtsQuery(text: string): string {
	return [
		...new Set(
			text
				.toLowerCase()
				.split(/[^\p{L}\p{N}]+/u)
				.filter(t => t.length >= 2 && !QUERY_STOP.has(t)),
		),
	]
		.map(t => `"${t.replaceAll('"', "")}"*`)
		.join(" OR ");
}

/** Rebuild exact-path links from indexed wiki query chunks to indexed project files. */
export function refreshPairings(db: Database): void {
	const projectFiles = db
		.query("SELECT id, path FROM code_files WHERE lang <> 'wiki' AND path NOT LIKE '@wiki/%'")
		.all() as ProjectFile[];
	const byPath = new Map(projectFiles.map(file => [file.path, file.id]));
	const chunks = db
		.query(
			`SELECT c.id, f.path, c.text FROM code_chunks c JOIN code_files f ON f.id=c.file_id
			 WHERE f.lang='wiki'`,
		)
		.all() as WikiChunk[];

	db.transaction(() => {
		db.exec(
			"CREATE TEMP TABLE IF NOT EXISTS current_code_pairings (chunk_id INTEGER NOT NULL, file_id INTEGER NOT NULL, PRIMARY KEY(chunk_id, file_id)); DELETE FROM current_code_pairings",
		);
		const insert = db.query(
			"INSERT INTO code_pairings(chunk_id, file_id) VALUES (?, ?) ON CONFLICT(chunk_id, file_id) DO NOTHING",
		);
		const markCurrent = db.query("INSERT INTO current_code_pairings(chunk_id, file_id) VALUES (?, ?)");
		for (const chunk of chunks) {
			const matched = new Set<number>();
			for (const match of chunk.text.matchAll(PATH_TOKEN)) {
				const fileId = byPath.get(match[0]!);
				if (fileId !== undefined) matched.add(fileId);
			}
			for (const fileId of matched) {
				insert.run(chunk.id, fileId);
				markCurrent.run(chunk.id, fileId);
			}
		}
		db.exec(
			"DELETE FROM code_pairings WHERE NOT EXISTS (SELECT 1 FROM current_code_pairings c WHERE c.chunk_id=code_pairings.chunk_id AND c.file_id=code_pairings.file_id)",
		);
	})();
}

/** Retrieve query-matching paired wiki chunks, with bounded relevance feedback. */
export function paired(db: Database, query: string, limit: number): PairedHit[] {
	const fts = makeFtsQuery(query);
	if (!fts || limit <= 0) return [];
	return db
		.query(
			`SELECT w.path wikiPath, f.path, c.start_line start, c.end_line end, p.id pairId, c.heading, c.text
			 FROM code_chunks_fts x
			 JOIN code_chunks c ON c.id=x.rowid
			 JOIN code_files w ON w.id=c.file_id
			 JOIN code_pairings p ON p.chunk_id=c.id
			 JOIN code_files f ON f.id=p.file_id
			 WHERE code_chunks_fts MATCH ?
			 ORDER BY (bm25(code_chunks_fts) - 0.15 * (p.helpful - p.unhelpful) / 5.0), p.id
			 LIMIT ?`,
		)
		.all(fts, limit) as PairedHit[];
}

/** Record up to five explicit votes per pair in either direction. */
export function ratePair(db: Database, pairId: number, helpful: boolean): void {
	const result = db
		.query(
			`UPDATE code_pairings SET
		 helpful = MIN(5, helpful + ?), unhelpful = MIN(5, unhelpful + ?)
		 WHERE id = ?`,
		)
		.run(helpful ? 1 : 0, helpful ? 0 : 1, pairId);
	if (!result.changes) throw new Error(`Unknown pair ID: ${pairId}`);
}
