Local code graph, project wiki cross-links, and BM25 search backed by `<cwd>/.jeo/db/jeo.db` (auto-migrating legacy `<cwd>/.jeopi/db/jeo.db` on first access).

<instruction>
- Use `where-defined` to locate exact definitions of functions, classes, methods, interfaces, types, or enums.
- Use `who-calls` and `what-calls` to trace callers, importers, inheritance (`extends`), and callees before refactoring.
- Use `impact` with a symbol name or relative file path to compute the reverse-dependency closure (affected files, tests, and symbols).
- Use `search` or `scope` for BM25 full-text discovery across code symbols and Markdown documentation chunks before reading full files.
- Use `build` (`rebuild: true` for a full reindex) after major branch switches or bulk generation; queries auto-index an empty database on first use.
</instruction>
