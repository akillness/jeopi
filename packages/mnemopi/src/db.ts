import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dbPath } from "./config";
import { CODE_DDL, CODE_SCHEMA_VERSION } from "./core/code/schema";

export type DatabasePath = string | ":memory:";

export interface OpenDatabaseOptions {
	readonly create?: boolean;
	readonly readwrite?: boolean;
	readonly strict?: boolean;
	readonly loadExtension?: string | readonly string[];
	readonly pragmas?: boolean;
}

interface TxState {
	depth: number;
}

const TX_STATE = Symbol("mnemopi.txState");

type TxDatabase = Database & { [TX_STATE]?: TxState };
type ExtensionDatabase = Database & { loadExtension(path: string): void };

export function defaultCodeDbPath(cwd = process.cwd()): string {
	const override = process.env.MNEMOPI_CODE_DB_PATH?.trim();
	if (override) return override;
	const canonical = join(cwd, ".jeo", "db", "jeo.db");
	const legacy = join(cwd, ".jeopi", "db", "jeo.db");
	if (!existsSync(canonical) && existsSync(legacy)) {
		try {
			mkdirSync(join(cwd, ".jeo", "db"), { recursive: true });
			copyFileSync(legacy, canonical);
			for (const suffix of ["-wal", "-shm"]) {
				if (existsSync(`${legacy}${suffix}`)) {
					copyFileSync(`${legacy}${suffix}`, `${canonical}${suffix}`);
				}
			}
		} catch {
			// Ignore migration copy error and let caller initialize canonical DB.
		}
	}
	return canonical;
}

export function openDatabase(path: DatabasePath = dbPath(), options: OpenDatabaseOptions = {}): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, {
		create: options.create ?? true,
		readwrite: options.readwrite ?? true,
		strict: options.strict ?? true,
	});
	if (options.pragmas !== false) enablePragmas(db, path);
	if (options.loadExtension !== undefined) loadExtensions(db, options.loadExtension);
	return db;
}

export function openCodeDatabase(
	path: DatabasePath = defaultCodeDbPath(),
	options: OpenDatabaseOptions = {},
): Database {
	const db = openDatabase(path, options);
	if (options.readwrite !== false) initCodeSchema(db);
	return db;
}

export function initCodeSchema(db: Database): void {
	for (const stmt of CODE_DDL) {
		db.exec(stmt);
	}
	const row = db.query("SELECT MAX(version) AS v FROM schema_versions").get() as { v: number | null };
	if ((row?.v ?? 0) < CODE_SCHEMA_VERSION) {
		db.query("INSERT INTO schema_versions(version, applied_at) VALUES (?, ?)").run(
			CODE_SCHEMA_VERSION,
			new Date().toISOString(),
		);
	}
}

export function enablePragmas(db: Database, path?: DatabasePath): void {
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
}

export function loadExtensions(db: Database, extensions: string | readonly string[]): void {
	if (typeof extensions === "string") {
		if (extensions) (db as ExtensionDatabase).loadExtension(extensions);
		return;
	}
	for (const extension of extensions) {
		if (extension) (db as ExtensionDatabase).loadExtension(extension);
	}
}

export function transaction<T>(db: Database, fn: () => T): T {
	const txDb = db as TxDatabase;
	let state = txDb[TX_STATE];
	if (state !== undefined && state.depth > 0) {
		state.depth++;
		try {
			return fn();
		} finally {
			state.depth--;
		}
	}

	state = { depth: 1 };
	txDb[TX_STATE] = state;
	db.exec("BEGIN DEFERRED");
	try {
		const result = fn();
		state.depth = 0;
		db.exec("COMMIT");
		return result;
	} catch (error) {
		state.depth = 0;
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original error; rollback can fail if SQLite already closed the transaction.
		}
		throw error;
	} finally {
		delete txDb[TX_STATE];
	}
}

export const deferredTransaction = transaction;

export async function transactionAsync<T>(db: Database, fn: () => Promise<T>): Promise<T> {
	const txDb = db as TxDatabase;
	let state = txDb[TX_STATE];
	if (state !== undefined && state.depth > 0) {
		state.depth++;
		try {
			return await fn();
		} finally {
			state.depth--;
		}
	}

	state = { depth: 1 };
	txDb[TX_STATE] = state;
	db.exec("BEGIN DEFERRED");
	try {
		const result = await fn();
		state.depth = 0;
		db.exec("COMMIT");
		return result;
	} catch (error) {
		state.depth = 0;
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original error; rollback can fail if SQLite already closed the transaction.
		}
		throw error;
	} finally {
		delete txDb[TX_STATE];
	}
}

export function closeQuietly(db: Database | undefined | null): void {
	if (db === undefined || db === null) return;
	try {
		db.close();
	} catch {
		// Best-effort cleanup.
	}
}
