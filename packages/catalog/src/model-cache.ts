/**
 * SQLite-backed model cache for atomic cross-process access.
 * Replaces per-provider JSON files with a single cache.db.
 */
import { Database } from "bun:sqlite";
import { getModelDbPath } from "jeopi-utils";
import type { Api, Model, ModelSpec } from "./types";

// Rows persist sparse ModelSpec metadata, never request headers: arbitrary
// provider-defined header names may carry credentials. v9 records restoration
// provenance and invalidates older rows, including v8 credential-bearing rows.
const CACHE_SCHEMA_VERSION = 9;

interface CacheRow {
	provider_id: string;
	version: number;
	updated_at: number;
	authoritative: number;
	static_fingerprint: string;
	models: string;
	header_omitted_model_ids: string;
	unrestorable_header_model_ids: string;
}

interface TableInfoRow {
	name: string;
}

interface CacheEntry<TApi extends Api = Api> {
	models: ModelSpec<TApi>[];
	fresh: boolean;
	authoritative: boolean;
	updatedAt: number;
	/** Model ids whose request headers were omitted from disk. */
	headerOmittedModelIds: readonly string[];
	/** Model ids whose headers did not match a trusted local source. */
	unrestorableHeaderModelIds: readonly string[];
	/**
	 * Hash of the static catalog slice that was merged into `models` when this
	 * row was written. `resolveProviderModels` compares against the current
	 * static fingerprint and bypasses the static+cache re-merge when they
	 * match — the cache already incorporates the same static state.
	 */
	staticFingerprint: string;
}

let sharedDb: Database | null = null;
let sharedDbPath: string | null = null;

function openDb(resolvedPath: string): Database {
	const db = new Database(resolvedPath, { create: true });
	// Install the busy handler BEFORE any lock-taking statement. See
	// https://github.com/can1357/oh-my-pi/issues/2421.
	db.run("PRAGMA busy_timeout = 3000");
	// Scrub deleted legacy credential-bearing cells rather than retaining them in free pages.
	db.run("PRAGMA secure_delete = ON");
	db.run("PRAGMA journal_mode = WAL");
	db.run(`
		CREATE TABLE IF NOT EXISTS model_cache (
			provider_id TEXT PRIMARY KEY,
			version INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			authoritative INTEGER NOT NULL DEFAULT 0,
			static_fingerprint TEXT NOT NULL DEFAULT '',
			header_omitted_model_ids TEXT NOT NULL DEFAULT '[]',
			unrestorable_header_model_ids TEXT NOT NULL DEFAULT '[]',
			models TEXT NOT NULL
		)
	`);
	migrateCacheSchema(db);
	return db;
}

function getSharedDb(): Database {
	const resolvedPath = getModelDbPath();
	if (sharedDb && sharedDbPath === resolvedPath) {
		return sharedDb;
	}
	if (sharedDb) {
		sharedDb.close();
	}
	const db = openDb(resolvedPath);
	sharedDb = db;
	sharedDbPath = resolvedPath;
	return db;
}

function withModelCacheDb<T>(dbPath: string | undefined, useDb: (db: Database) => T): T {
	if (!dbPath) return useDb(getSharedDb());
	const db = openDb(dbPath);
	try {
		return useDb(db);
	} finally {
		db.close();
	}
}

function migrateCacheSchema(db: Database): void {
	const stmt = db.prepare("PRAGMA table_info(model_cache)");
	try {
		const columns = stmt.all() as TableInfoRow[];
		if (!columns.some(column => column.name === "static_fingerprint")) {
			db.run("ALTER TABLE model_cache ADD COLUMN static_fingerprint TEXT NOT NULL DEFAULT ''");
		}
		if (!columns.some(column => column.name === "header_omitted_model_ids")) {
			db.run("ALTER TABLE model_cache ADD COLUMN header_omitted_model_ids TEXT NOT NULL DEFAULT '[]'");
		}
		if (!columns.some(column => column.name === "unrestorable_header_model_ids")) {
			db.run("ALTER TABLE model_cache ADD COLUMN unrestorable_header_model_ids TEXT NOT NULL DEFAULT '[]'");
		}
	} finally {
		stmt.finalize();
	}
	// Delete rows written under any older schema so they cannot be reused. The
	// legacy `UPDATE ... WHERE version = 2` migration silently promoted the very
	// first cache version to whatever the current one is, defeating every
	// subsequent invalidation (see #4146: pre-V2 Codex rows kept the legacy
	// compaction path even after CACHE_SCHEMA_VERSION was bumped).
	db.run("DELETE FROM model_cache WHERE version <> ?", [CACHE_SCHEMA_VERSION]);
}

export function readModelCache<TApi extends Api>(
	providerId: string,
	ttlMs: number,
	now: () => number,
	dbPath?: string,
): CacheEntry<TApi> | null {
	try {
		return withModelCacheDb(dbPath, db => {
			const stmt = db.query<CacheRow, [string]>("SELECT * FROM model_cache WHERE provider_id = ?");
			try {
				const row = stmt.get(providerId);
				if (!row || row.version !== CACHE_SCHEMA_VERSION) {
					return null;
				}
				const models = JSON.parse(row.models) as ModelSpec<TApi>[];
				const headerOmittedModelIds: unknown = JSON.parse(row.header_omitted_model_ids);
				const unrestorableHeaderModelIds: unknown = JSON.parse(row.unrestorable_header_model_ids);
				if (
					!Array.isArray(headerOmittedModelIds) ||
					!headerOmittedModelIds.every(id => typeof id === "string") ||
					!Array.isArray(unrestorableHeaderModelIds) ||
					!unrestorableHeaderModelIds.every(id => typeof id === "string")
				)
					return null;
				const ageMs = now() - row.updated_at;
				const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs;
				return {
					models,
					fresh,
					authoritative: row.authoritative === 1,
					updatedAt: row.updated_at,
					headerOmittedModelIds,
					unrestorableHeaderModelIds,
					staticFingerprint: row.static_fingerprint ?? "",
				};
			} finally {
				stmt.finalize();
			}
		});
	} catch {
		return null;
	}
}

function headersEqual(left: Record<string, string>, right: Record<string, string> | undefined): boolean {
	if (!right) return false;
	return (
		Object.keys(left).length === Object.keys(right).length &&
		Object.keys(left).every(key => Object.hasOwn(right, key) && left[key] === right[key])
	);
}

export function writeModelCache<TApi extends Api>(
	providerId: string,
	updatedAt: number,
	models: Model<TApi>[],
	authoritative: boolean,
	staticFingerprint: string,
	dbPath?: string,
	staticHeaderSources: readonly Model<TApi>[] = [],
	restorableHeaderFallback?: Record<string, string>,
	restoreCachedHeaders?: (model: Model<Api>) => Record<string, string> | undefined,
): void {
	try {
		withModelCacheDb(dbPath, db => {
			const headerOmittedModelIds: string[] = [];
			const unrestorableHeaderModelIds: string[] = [];
			const staticById = new Map(staticHeaderSources.map(model => [model.id, model]));
			const cachedModels = models.map(model => {
				const { headers, compatConfig, ...metadata } = model;
				if (headers && Object.keys(headers).length > 0) {
					headerOmittedModelIds.push(model.id);
					const source =
						staticById.get(model.id) ?? (model.requestModelId ? staticById.get(model.requestModelId) : undefined);
					if (
						!headersEqual(headers, source?.headers ?? restorableHeaderFallback) &&
						!headersEqual(headers, restoreCachedHeaders?.({ ...model, headers: undefined }))
					) {
						unrestorableHeaderModelIds.push(model.id);
					}
				}
				return { ...metadata, compat: compatConfig };
			});
			db.run(
				`INSERT OR REPLACE INTO model_cache (
					provider_id, version, updated_at, authoritative, static_fingerprint,
					header_omitted_model_ids, unrestorable_header_model_ids, models
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					providerId,
					CACHE_SCHEMA_VERSION,
					updatedAt,
					authoritative ? 1 : 0,
					staticFingerprint,
					JSON.stringify(headerOmittedModelIds),
					JSON.stringify(unrestorableHeaderModelIds),
					JSON.stringify(cachedModels),
				],
			);
		});
	} catch {
		// Cache writes are best-effort; failures should not break model resolution.
	}
}
