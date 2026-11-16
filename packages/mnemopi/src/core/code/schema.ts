export const CODE_SCHEMA_VERSION = 1;

export const CODE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER NOT NULL, applied_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS code_files (
     id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, lang TEXT NOT NULL,
     digest TEXT NOT NULL, mtime INTEGER NOT NULL, indexed_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS code_nodes (
     id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
     name TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
     exported INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_code_nodes_name ON code_nodes(name)`,
  `CREATE INDEX IF NOT EXISTS idx_code_nodes_file ON code_nodes(file_id)`,
  `CREATE TABLE IF NOT EXISTS code_edges (
     id INTEGER PRIMARY KEY, src_id INTEGER NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
     dst_id INTEGER NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE, kind TEXT NOT NULL,
     conf TEXT NOT NULL DEFAULT 'name')`,
  `CREATE INDEX IF NOT EXISTS idx_code_edges_dst ON code_edges(dst_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_code_edges_src ON code_edges(src_id, kind)`,
  `CREATE TABLE IF NOT EXISTS code_refs (
     id INTEGER PRIMARY KEY, src_id INTEGER NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
     name TEXT NOT NULL, kind TEXT NOT NULL, recv TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS idx_code_refs_name ON code_refs(name)`,
  `CREATE TABLE IF NOT EXISTS code_imports (
     id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
     spec TEXT NOT NULL, imported TEXT NOT NULL, local TEXT NOT NULL, reexport INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_code_imports_file ON code_imports(file_id)`,
  `CREATE TABLE IF NOT EXISTS code_chunks (
     id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
     heading TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, text TEXT NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS code_nodes_fts USING fts5(name, words)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks_fts USING fts5(heading, text)`,
];
