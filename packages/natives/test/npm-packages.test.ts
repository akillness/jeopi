import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { leafPackageNamesForTag } from "../native/loader-state.js";
import { buildLeafManifest, generateNpmPackages, LEAF_TARGETS, leafPackageName } from "../scripts/gen-npm-packages";

describe("native leaf package naming", () => {
	it("publishes the win32 leaf under the windows-x64 alias and keeps the loader probing both names", () => {
		// The registry rejects `jeopi-natives-win32-x64` with `403 … spam
		// detection`; the alias is the published name, so the generator, the
		// core optionalDependencies source (LEAF_TARGETS), and the runtime
		// loader must agree on it.
		const win32 = LEAF_TARGETS.find(target => target.tag === "win32-x64");
		expect(win32 && leafPackageName(win32)).toBe("jeopi-natives-windows-x64");
		expect(leafPackageNamesForTag("win32-x64")).toEqual(["jeopi-natives-windows-x64", "jeopi-natives-win32-x64"]);
		// Every other tag keeps the derived name with no alias probing.
		for (const target of LEAF_TARGETS.filter(target => target.tag !== "win32-x64")) {
			expect(leafPackageName(target)).toBe(`jeopi-natives-${target.tag}`);
			expect(leafPackageNamesForTag(target.tag)).toEqual([`jeopi-natives-${target.tag}`]);
		}
		const manifest = buildLeafManifest({
			tag: "win32-x64",
			os: "win32",
			cpu: "x64",
			npmName: "jeopi-natives-windows-x64",
			files: ["pi_natives.win32-x64-baseline.node"],
			version: "15.5.15",
		});
		expect(manifest.name).toBe("jeopi-natives-windows-x64");
	});
});

describe("generated native npm leaf packages", () => {
	it("builds an x64 leaf manifest that exposes all addon files without package exports", () => {
		const addonFiles = ["pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64-modern.node"];
		const manifest = buildLeafManifest({
			tag: "linux-x64",
			os: "linux",
			cpu: "x64",
			files: addonFiles,
			version: "15.5.15",
		});

		expect(manifest.name).toBe("jeopi-natives-linux-x64");
		expect(manifest.version).toBe("15.5.15");
		expect(manifest.os).toEqual(["linux"]);
		expect(manifest.cpu).toEqual(["x64"]);
		expect(addonFiles).toContain(manifest.main.slice("./".length));
		expect(manifest.files).toContain("*.node");
		expect(manifest.files).toContain("README.md");
		expect("exports" in manifest).toBe(false);
	});

	it("uses the default addon as the main entry for non-x64 leaves", () => {
		const addonFiles = ["pi_natives.darwin-arm64.node"];
		const manifest = buildLeafManifest({
			tag: "darwin-arm64",
			os: "darwin",
			cpu: "arm64",
			files: addonFiles,
			version: "15.5.15",
		});

		expect(manifest.name).toBe("jeopi-natives-darwin-arm64");
		expect(manifest.os).toEqual(["darwin"]);
		expect(manifest.cpu).toEqual(["arm64"]);
		expect(manifest.main).toBe("./pi_natives.darwin-arm64.node");
		expect(addonFiles).toContain(manifest.main.slice("./".length));
		expect("exports" in manifest).toBe(false);
	});

	it("generates every leaf package by copying present addon files", async () => {
		const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-npm-"));
		try {
			await fs.mkdir(path.join(packageDir, "native"));
			await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ version: "15.5.15" }));
			const addonFiles = [
				"pi_natives.linux-x64-baseline.node",
				"pi_natives.linux-x64-modern.node",
				"pi_natives.linux-arm64.node",
				"pi_natives.darwin-x64-baseline.node",
				"pi_natives.darwin-arm64.node",
				"pi_natives.win32-x64-baseline.node",
			];
			for (const file of addonFiles) {
				await Bun.write(path.join(packageDir, "native", file), file);
			}

			const leaves = await generateNpmPackages({ packageDir });
			expect(leaves.map(leaf => leaf.tag)).toEqual([
				"linux-x64",
				"linux-arm64",
				"darwin-x64",
				"darwin-arm64",
				"win32-x64",
			]);
			const linuxX64 = leaves.find(leaf => leaf.tag === "linux-x64");
			expect(linuxX64?.files).toEqual(["pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64-modern.node"]);
			expect(await Bun.file(path.join(packageDir, "npm/linux-x64/pi_natives.linux-x64-modern.node")).text()).toBe(
				"pi_natives.linux-x64-modern.node",
			);
			const manifest = await Bun.file(path.join(packageDir, "npm/linux-x64/package.json")).json();
			expect(manifest.main).toBe("./pi_natives.linux-x64-baseline.node");
			expect("exports" in manifest).toBe(false);
		} finally {
			await fs.rm(packageDir, { recursive: true, force: true });
		}
	});

	it("reports missing leaves during dry runs without writing generated packages", async () => {
		const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-npm-dry-"));
		const logSpy = spyOn(console, "log").mockImplementation(() => {});
		try {
			await fs.mkdir(path.join(packageDir, "native"));
			await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ version: "15.5.15" }));
			await Bun.write(path.join(packageDir, "native/pi_natives.darwin-arm64.node"), "darwin");

			const leaves = await generateNpmPackages({ packageDir, dryRun: true });
			expect(leaves.filter(leaf => leaf.missing).map(leaf => leaf.tag)).toEqual([
				"linux-x64",
				"linux-arm64",
				"darwin-x64",
				"win32-x64",
			]);
			expect(await Bun.file(path.join(packageDir, "npm/darwin-arm64/package.json")).exists()).toBe(false);
		} finally {
			logSpy.mockRestore();
			await fs.rm(packageDir, { recursive: true, force: true });
		}
	});
});
