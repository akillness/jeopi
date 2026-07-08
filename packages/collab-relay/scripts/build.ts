#!/usr/bin/env bun
/**
 * Production build: compiles collab-web's SPA and the standalone share-viewer
 * page into `dist/web/`, the directory `src/static.ts` serves at runtime.
 *
 * Two cross-package generation steps (both already exist as sibling package
 * scripts — this just sequences and relocates their output):
 *   1. `collab-web`'s own `build` script → `packages/collab-web/dist/`
 *   2. `coding-agent`'s `gen:share-viewer` script → a standalone
 *      `share-viewer.html` (same template `getTemplate()`/`generateThemeVars`
 *      the `/s/<id>` route in a real export uses, minus the embedded session).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const collabWebDir = path.join(root, "../collab-web");
const codingAgentDir = path.join(root, "../coding-agent");
const outDir = path.join(root, "dist/web");

console.log("[build] collab-web SPA…");
const webBuild = Bun.spawnSync(["bun", "run", "build"], { cwd: collabWebDir, stdout: "inherit", stderr: "inherit" });
if (webBuild.exitCode !== 0) {
	console.error("[build] collab-web build failed");
	process.exit(webBuild.exitCode ?? 1);
}

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });
await fs.cp(path.join(collabWebDir, "dist"), outDir, { recursive: true });

console.log("[build] share-viewer.html…");
const viewerOut = path.join(outDir, "s", "share-viewer.html");
const viewerBuild = Bun.spawnSync(["bun", "run", "gen:share-viewer", viewerOut], {
	cwd: codingAgentDir,
	stdout: "inherit",
	stderr: "inherit",
});
if (viewerBuild.exitCode !== 0) {
	console.error("[build] share-viewer build failed");
	process.exit(viewerBuild.exitCode ?? 1);
}

console.log(`[build] done → ${outDir}`);
