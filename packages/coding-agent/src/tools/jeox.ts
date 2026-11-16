import * as path from "node:path";
import { type } from "arktype";
import type { AgentTool, AgentToolResult } from "jeopi-agent-core";
import { untilAborted } from "jeopi-utils";
import jeoxDescription from "../prompts/tools/jeox.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

const jeoxSchema = type({
	action: type(
		"'who-calls' | 'what-calls' | 'where-defined' | 'impact' | 'search' | 'scope' | 'build' | 'status'",
	).describe("code graph or search operation"),
	"name?": type("string").describe("symbol name for who-calls, what-calls, or where-defined"),
	"target?": type("string").describe("symbol name or relative file path for impact"),
	"query?": type("string").describe("search query for search or scope"),
	"limit?": type("number").describe("maximum results to return (default 5)"),
	"depth?": type("number").describe("traversal depth for impact (default 3)"),
	"strict?": type("boolean").describe("exclude name-only heuristic edges"),
	"rebuild?": type("boolean").describe("full rebuild when action is build"),
});

export type JeoxParams = typeof jeoxSchema.infer;

export class JeoxTool implements AgentTool<typeof jeoxSchema> {
	readonly name = "jeox";
	readonly approval = "read" as const;
	readonly label = "Jeox";
	readonly description = jeoxDescription;
	readonly parameters = jeoxSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Query local code graph and BM25 search index (.jeopi/db/jeo.db)";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: JeoxParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const code = await import("jeopi-mnemopi/code");
			const root = path.resolve(this.session.cwd);
			const dbPath = code.defaultCodeDbPath(root);
			const db = code.openCodeDatabase(dbPath);
			const action = params.action;
			const limit = Math.max(1, Math.trunc(params.limit ?? 5));
			const depth = Math.max(1, Math.trunc(params.depth ?? 3));
			const strict = params.strict ?? false;
			const rebuild = params.rebuild ?? false;

			try {
				if (action !== "build" && code.stats(db).files === 0) {
					code.indexDir(db, root);
				}

				switch (action) {
					case "who-calls": {
						const name = params.name?.trim() || params.target?.trim() || "";
						if (!name) throw new ToolError('jeox "who-calls" requires a symbol "name".');
						const hits = code.whoCalls(db, name, { limit, strict });
						const text = hits.length > 0 ? JSON.stringify(hits, null, 2) : `0 callers found for "${name}".`;
						return { content: [{ type: "text", text }], details: { action, hits, dbPath } };
					}
					case "what-calls": {
						const name = params.name?.trim() || params.target?.trim() || "";
						if (!name) throw new ToolError('jeox "what-calls" requires a symbol "name".');
						const hits = code.whatCalls(db, name, { limit, strict });
						const text = hits.length > 0 ? JSON.stringify(hits, null, 2) : `0 callees found for "${name}".`;
						return { content: [{ type: "text", text }], details: { action, hits, dbPath } };
					}
					case "where-defined": {
						const name = params.name?.trim() || params.target?.trim() || "";
						if (!name) throw new ToolError('jeox "where-defined" requires a symbol "name".');
						const hits = code.whereDefined(db, name, limit);
						const text = hits.length > 0 ? JSON.stringify(hits, null, 2) : `0 definitions found for "${name}".`;
						return { content: [{ type: "text", text }], details: { action, hits, dbPath } };
					}
					case "impact": {
						const target = params.target?.trim() || params.name?.trim() || "";
						if (!target) throw new ToolError('jeox "impact" requires a symbol or path "target".');
						const result = code.impact(db, target, depth, limit * 4, strict);
						return {
							content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
							details: { action, result, dbPath },
						};
					}
					case "search": {
						const query = params.query?.trim() || params.name?.trim() || "";
						if (!query) throw new ToolError('jeox "search" requires a "query" string.');
						const hits = code.search(db, query, limit);
						const text = hits.length > 0 ? JSON.stringify(hits, null, 2) : `0 search hits for "${query}".`;
						return { content: [{ type: "text", text }], details: { action, hits, dbPath } };
					}
					case "scope": {
						const query = params.query?.trim() || params.name?.trim() || "";
						if (!query) throw new ToolError('jeox "scope" requires a task "query" string.');
						const hits = code.search(db, query, limit);
						const manifest = { meta: { task: query, hits: hits.length, preview: "none" }, hits };
						return {
							content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }],
							details: { action, manifest, dbPath },
						};
					}
					case "build": {
						const statsResult = code.indexDir(db, root, { rebuild });
						return {
							content: [
								{ type: "text", text: `Indexed in ${statsResult.ms}ms: ${JSON.stringify(statsResult)}` },
							],
							details: { action, stats: statsResult, dbPath },
						};
					}
					case "status": {
						const statsResult = code.stats(db);
						return {
							content: [{ type: "text", text: JSON.stringify(statsResult, null, 2) }],
							details: { action, stats: statsResult, dbPath },
						};
					}
				}
			} finally {
				code.closeQuietly(db);
			}
		});
	}
}
