# jeox

> Local TypeScript AST code graph, project `@wiki/` cross-links, and BM25 search over `.jeo/db/jeo.db`.

## Source
- Entry: `packages/coding-agent/src/tools/jeox.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/jeox.md`
- Key collaborators:
  - `packages/mnemopi/src/core/code/index.ts` — code graph indexer, SQLite schema (`SCHEMA.md`), and query engine
  - `packages/mnemopi/src/db.ts` — `openCodeDatabase()` and `defaultCodeDbPath()` resolving `.jeo/db/jeo.db` (auto-migrating legacy `.jeopi/db/jeo.db` if canonical is absent)

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"who-calls" \| "what-calls" \| "where-defined" \| "impact" \| "search" \| "scope" \| "build" \| "status"` | Yes | Code graph or search operation to execute. |
| `name` | `string` | Conditional | Symbol name required for `who-calls`, `what-calls`, and `where-defined`. |
| `target` | `string` | Conditional | Symbol name or workspace-relative file path for `impact`. |
| `query` | `string` | Conditional | Search query for `search` or `scope`. |
| `limit` | `number` | No | Maximum results to return (defaults to `5`). |
| `depth` | `number` | No | Reverse-dependency traversal depth for `impact` (defaults to `3`). |
| `strict` | `boolean` | No | Exclude ambiguous name-only heuristic edges. |
| `rebuild` | `boolean` | No | Drop and recreate code graph tables during `build`. |

## Outputs
- Single-shot JSON or formatted text block summarizing matching definitions, callers, callees, impacted files/tests, or index counts.
- Database storage unifies with `jeo-code` and `jeo-skills` at `<cwd>/.jeo/db/jeo.db` (or `MNEMOPI_CODE_DB_PATH` when explicitly set), auto-migrating legacy `<cwd>/.jeopi/db/jeo.db` when canonical does not yet exist.

## Side Effects
- Opens `<cwd>/.jeo/db/jeo.db` via `openCodeDatabase()` in WAL mode, initializes `CODE_DDL` tables on first run, and auto-indexes the workspace if `code_files` is empty or `action` is `build`.
