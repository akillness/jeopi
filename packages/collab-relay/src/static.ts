/**
 * Static file serving for the built collab-web SPA under `webRoot`
 * (`dist/web` — see `scripts/build.ts`). Any path without a matching file
 * falls back to `index.html`: collab-web is a single-page app that resolves
 * `#<link>` client-side, so every non-asset path is a valid entry point.
 */
import * as path from "node:path";

export interface StaticServerOptions {
	webRoot: string;
}

export class StaticServer {
	readonly #webRoot: string;

	constructor(opts: StaticServerOptions) {
		this.#webRoot = opts.webRoot;
	}

	async serve(pathname: string): Promise<Response> {
		const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
		const resolved = path.join(this.#webRoot, relative);
		// Reject traversal outside webRoot (encoded `..` segments, absolute overrides).
		if (!resolved.startsWith(this.#webRoot)) return new Response("Forbidden", { status: 403 });
		const file = Bun.file(resolved);
		if (await file.exists()) return new Response(file);
		const index = Bun.file(path.join(this.#webRoot, "index.html"));
		if (await index.exists()) return new Response(index);
		return new Response("collab-web build not found — run `bun run build` first", { status: 404 });
	}
}
