import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { paired, ratePair, refreshPairings } from "../src/core/code/pairings";
import { CODE_DDL } from "../src/core/code/schema";

test("wiki query chunks pair only exact indexed paths and retain bounded feedback across refresh", () => {
	const db = new Database(":memory:");
	db.exec("PRAGMA foreign_keys=ON");
	for (const ddl of CODE_DDL) db.exec(ddl);
	try {
		db.query("INSERT INTO code_files(path,lang,digest,mtime,indexed_at) VALUES (?,?,?,?,?)").run(
			"src/service.ts",
			"script",
			"d",
			1,
			"now",
		);
		const projectFile = db.query("SELECT id FROM code_files WHERE path=?").get("src/service.ts") as { id: number };
		db.query("INSERT INTO code_files(path,lang,digest,mtime,indexed_at) VALUES (?,?,?,?,?)").run(
			"@wiki/queries/task.md",
			"wiki",
			"d",
			1,
			"now",
		);
		const wikiFile = db.query("SELECT id FROM code_files WHERE path=?").get("@wiki/queries/task.md") as {
			id: number;
		};
		const insertChunk = db.query(
			"INSERT INTO code_chunks(file_id,heading,start_line,end_line,text) VALUES (?,?,?,?,?) RETURNING id",
		);
		const linkedChunk = insertChunk.get(
			wikiFile.id,
			"Service",
			2,
			4,
			"Investigate src/service.ts service behavior",
		) as { id: number };
		db.query("INSERT INTO code_chunks_fts(rowid,heading,text) VALUES (?,?,?)").run(
			linkedChunk.id,
			"Service",
			"Investigate src/service.ts service behavior",
		);
		const decoyChunk = insertChunk.get(
			wikiFile.id,
			"Near match",
			5,
			6,
			"Investigate src/service.tsx service behavior",
		) as { id: number };
		db.query("INSERT INTO code_chunks_fts(rowid,heading,text) VALUES (?,?,?)").run(
			decoyChunk.id,
			"Near match",
			"Investigate src/service.tsx service behavior",
		);
		db.query("INSERT INTO code_files(path,lang,digest,mtime,indexed_at) VALUES (?,?,?,?,?)").run(
			"src/other.ts",
			"script",
			"d",
			1,
			"now",
		);
		const otherChunk = insertChunk.get(wikiFile.id, "Other", 7, 8, "Investigate src/other.ts service behavior") as {
			id: number;
		};
		db.query("INSERT INTO code_chunks_fts(rowid,heading,text) VALUES (?,?,?)").run(
			otherChunk.id,
			"Other",
			"Investigate src/other.ts service behavior",
		);

		refreshPairings(db);
		const hits = paired(db, "service behavior", 10);
		expect(hits.map(hit => hit.path)).toEqual(["src/service.ts", "src/other.ts"]);
		expect(hits[0]).toMatchObject({
			path: "src/service.ts",
			start: 2,
			end: 4,
			text: "Investigate src/service.ts service behavior",
		});
		const pairId = hits[1]!.pairId;
		ratePair(db, pairId, true);
		refreshPairings(db);
		expect(paired(db, "service behavior", 10)[0]?.path).toBe("src/other.ts");
		expect(paired(db, "service behavior", 10)[0]?.pairId).toBe(pairId);

		db.query("DELETE FROM code_files WHERE id=?").run(projectFile.id);
		expect(db.query("SELECT id FROM code_pairings WHERE id=?").get(hits[0]!.pairId)).toBeNull();
		expect(paired(db, "service behavior", 10).map(hit => hit.pairId)).toEqual([pairId]);
	} finally {
		db.close();
	}
});
