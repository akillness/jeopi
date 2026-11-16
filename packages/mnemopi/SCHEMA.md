# jeo-mem SCHEMA (contract v1)

Shared *contract* with jeo-code `jeo-mem`; no shared code. Keep this file identical in both repos.

## Principles
- Files (JSONL event log + markdown + source) are the SSOT. The DB is a derived, rebuildable index.
- Local only. No network, no hosting.
- Code-graph tables use the `code_` prefix so they never collide with mnemopi tables.

## Event envelope (JSONL, append-only)
`{ "v": 1, "ts": ISO8601, "kind": string, "ref": string, "payload": object }`
jeo-code `.jeo/ledger.jsonl` legacy lines `{ts,type,planId,...}` are read as
`kind=type, ref=planId, payload=rest`.

## Tables (v1)
- `schema_versions(version INTEGER, applied_at TEXT)`
- `code_files(id, path UNIQUE, lang, digest, mtime, indexed_at)`
- `code_nodes(id, file_id, name, kind, start_line, end_line, exported)`
- `code_edges(id, src_id, dst_id, kind, conf)`     -- kind: calls|imports|extends|references, conf: local|import|name
- `code_refs(id, src_id, name, kind, recv)`        -- raw name refs; `code_edges` is derived by joining refs to node names
- `code_imports(id, file_id, spec, imported, local, reexport)` -- ES imports & re-exports
- `code_chunks(id, file_id, heading, start_line, end_line, text)` -- markdown/code chunks (<=3600 chars)
- `code_nodes_fts(name, words)`, `code_chunks_fts(heading, text)`  (FTS5, BM25; rowid = node/chunk id, maintained by the indexer)
- Every file gets a synthetic node `<module>` (kind=module) that owns top-level calls and imports.

## Verbs (CLI / MCP)
shared with mnemopi: `index query get remember recall link export import stats diagnose`
new: `who-calls what-calls where-defined impact scope reindex`
Defaults: `--preview none`, `--limit 5`, return path + line ranges only.
