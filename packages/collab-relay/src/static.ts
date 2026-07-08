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
		// Reject traversal outside webRoot. A bare `startsWith(webRoot)` string
		// check is a prefix collision, not a path-boundary check: with webRoot
		// `/app/dist/web`, a sibling `/app/dist/web-evil/secret` also starts
		// with that string and would pass. Require an exact match or a
		// `webRoot + path.sep` prefix so only real descendants qualify.
		if (resolved !== this.#webRoot && !resolved.startsWith(this.#webRoot + path.sep)) {
			return new Response("Forbidden", { status: 403 });
		}
		const file = Bun.file(resolved);
		if (await file.exists()) return new Response(file);
		const index = Bun.file(path.join(this.#webRoot, "index.html"));
		if (await index.exists()) return new Response(index);
		return new Response("collab-web build not found — run `bun run build` first", { status: 404 });
	}
}
