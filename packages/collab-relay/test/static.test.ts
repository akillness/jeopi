import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StaticServer } from "../src/static";

let base: string;
let webRoot: string;
let server: StaticServer;

beforeEach(async () => {
	base = await fs.mkdtemp(path.join(os.tmpdir(), "collab-relay-static-"));
	webRoot = path.join(base, "web");
	await fs.mkdir(webRoot, { recursive: true });
	await fs.writeFile(path.join(webRoot, "index.html"), "<html>fallback</html>");
	await fs.writeFile(path.join(webRoot, "app.js"), "console.log(1)");
	server = new StaticServer({ webRoot });
});

afterEach(async () => {
	await fs.rm(base, { recursive: true, force: true });
});

describe("StaticServer", () => {
	it("serves an existing file under webRoot", async () => {
		const resp = await server.serve("/app.js");
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe("console.log(1)");
	});

	it("falls back to index.html for an unknown client-side route", async () => {
		const resp = await server.serve("/some/spa/route");
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe("<html>fallback</html>");
	});

	it("blocks traversal into a sibling directory that shares webRoot's name as a prefix", async () => {
		// Regression test: webRoot `<base>/web` and a sibling `<base>/web-evil`
		// share the string prefix `<base>/web`, so a naive `startsWith(webRoot)`
		// check treats the sibling as an in-bounds descendant. `path.join`
		// resolves the `..` before the check runs, so this is a real traversal
		// primitive, not just a cosmetic path shape.
		const siblingEvil = path.join(base, "web-evil");
		await fs.mkdir(siblingEvil, { recursive: true });
		await fs.writeFile(path.join(siblingEvil, "secret.txt"), "TOP SECRET DATA");

		const resp = await server.serve("/../web-evil/secret.txt");
		expect(resp.status).toBe(403);
	});

	it("blocks traversal outside webRoot with no sibling present", async () => {
		const resp = await server.serve("/../../../etc/passwd");
		expect(resp.status).toBe(403);
	});

	it("serves the root path from webRoot itself (exact-match boundary)", async () => {
		// webRoot with no trailing path segment must not be rejected by the
		// `webRoot + path.sep` prefix check — `resolved === webRoot` needs its
		// own allow branch.
		const resp = await server.serve("/");
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe("<html>fallback</html>");
	});

	it("404s when neither the requested file nor index.html fallback exists", async () => {
		await fs.rm(path.join(webRoot, "index.html"));
		const resp = await server.serve("/missing.txt");
		expect(resp.status).toBe(404);
	});
});
