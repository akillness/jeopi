import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildBunInstallArgs,
	buildHomebrewUpdateArgs,
	buildMiseForceInstallArgs,
	buildMiseUpgradeArgs,
	fetchNewerPublishedVersion,
	getLatestRelease,
	pruneBunInstallCache,
	replaceBinaryForUpdate,
	resolveBunGlobalNodeModulesDirFromLocations,
	resolveUpdateMethodForTest,
	sweepStaleBackups,
} from "jeopi-cli/cli/update-cli";
import { removeWithRetries } from "jeopi-utils";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});
describe("update-cli install target detection", () => {
	it("uses bun update when prioritized omp is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses binary update when prioritized omp is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/omp", undefined);

		expect(method).toBe("binary");
	});

	it("uses Homebrew update when prioritized omp resolves into the Homebrew formula", async () => {
		const dir = await makeTempDir();
		const prefix = path.join(dir, "opt", "omp");
		const linkedBin = path.join(dir, "bin");
		await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
		await fs.mkdir(linkedBin, { recursive: true });
		await Bun.write(path.join(prefix, "bin", "omp"), "binary");
		await fs.symlink(path.join(prefix, "bin", "omp"), path.join(linkedBin, "omp"));

		const method = resolveUpdateMethodForTest(path.join(linkedBin, "omp"), "/Users/test/.bun/bin", {
			homebrewPrefix: prefix,
		});

		expect(method).toBe("brew");
	});

	it("uses mise update when prioritized omp is in an active mise bin path", () => {
		const method = resolveUpdateMethodForTest(
			"/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin/omp",
			undefined,
			{
				miseBinDirs: ["/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin"],
			},
		);

		expect(method).toBe("mise");
	});

	it("uses mise update when prioritized omp is a mise shim", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/share/mise/shims/omp", undefined, {
			miseDataDir: "/Users/test/.local/share/mise",
		});

		expect(method).toBe("mise");
	});
});

describe("update-cli package manager commands", () => {
	it("targets the Homebrew tap formula and switches to reinstall for forced updates", () => {
		expect(buildHomebrewUpdateArgs(false)).toEqual(["upgrade", "akillness/tap/jeopi"]);
		expect(buildHomebrewUpdateArgs(true)).toEqual(["reinstall", "akillness/tap/jeopi"]);
	});

	it("targets the mise GitHub backend tool and force-reinstalls the checked version when requested", () => {
		expect(buildMiseUpgradeArgs()).toEqual(["upgrade", "github:akillness/jeopi", "--bump"]);
		expect(buildMiseForceInstallArgs("15.10.5")).toEqual(["install", "--force", "github:akillness/jeopi@15.10.5"]);
	});
});

describe("update-cli bun install command", () => {
	it("pins the official npm registry and bypasses the manifest cache so a stale mirror or snapshot cannot mask a freshly published version", () => {
		// Regression: omp queries https://registry.npmjs.org/<pkg>/latest directly.
		// The install MUST hit the same registry, otherwise:
		//   - a lagging mirror (corp proxy, Taobao, …) rejects the version with
		//     `No version matching "X" (but package exists)`,
		//   - or bun's local manifest snapshot does the same when the user's bun
		//     is already pointed at the official registry but its cache predates
		//     the release.
		// See https://github.com/can1357/oh-my-pi/issues/1686.
		const args = buildBunInstallArgs("15.7.6", "linux-x64");
		expect(args.slice(0, 5)).toEqual([
			"install",
			"-g",
			"--no-cache",
			"--registry=https://registry.npmjs.org/",
			"jeopi-cli@15.7.6",
		]);
	});

	it("pins the native addon core and the platform-specific leaf to the same version so the loader sentinel cannot drift on supported tags", () => {
		// Regression: bun install -g <pkg>@<v> would update only the top-level
		// package, leaving jeopi-natives and the platform leaf
		// at their previous version. The next launch then loaded a stale .node
		// file and aborted at validateLoadedBindings with `The .node file on
		// disk is from a different release than this loader`. See
		// https://github.com/can1357/oh-my-pi/issues/1824.
		for (const tag of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
			const args = buildBunInstallArgs("15.9.0", tag);
			expect(args).toContain("jeopi-natives@15.9.0");
			expect(args).toContain(`jeopi-natives-${tag}@15.9.0`);
		}
		// win32 publishes under the `windows-x64` alias — the registry's name
		// heuristic rejects `jeopi-natives-win32-x64` as spam.
		const win32Args = buildBunInstallArgs("15.9.0", "win32-x64");
		expect(win32Args).toContain("jeopi-natives@15.9.0");
		expect(win32Args).toContain("jeopi-natives-windows-x64@15.9.0");
		expect(win32Args).not.toContain("jeopi-natives-win32-x64@15.9.0");
	});

	it("omits the leaf on unsupported platform tags so an EBADPLATFORM swap does not mask the underlying `no matching version` error", () => {
		// Defensive: an unsupported tag (e.g. linux-arm32) still installs the
		// core natives package — which will fail at module load if the platform
		// truly is unsupported — but we never request a leaf the release
		// pipeline doesn't publish, otherwise bun aborts with EBADPLATFORM
		// and hides the real diagnostic from `loadNative`'s aggregated error.
		const args = buildBunInstallArgs("15.9.0", "linux-arm");
		expect(args).toContain("jeopi-natives@15.9.0");
		expect(args.some(arg => arg.startsWith("jeopi-natives-"))).toBe(false);
	});

	it("startup update notice queries the published CLI package on the pinned registry and surfaces only newer versions", async () => {
		// Regression: the startup notice fetched https://registry.npmjs.org/jeopi/latest —
		// a package that does not exist — so the 404 silently suppressed the
		// "New version X is available" banner forever. The check MUST target the
		// same package `jeopi update` installs.
		const requested: string[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request) => {
			requested.push(String(input instanceof Request ? input.url : input));
			return Promise.resolve(Response.json({ version: "99.0.0" }));
		}) as typeof fetch);
		try {
			await expect(fetchNewerPublishedVersion("1.0.0")).resolves.toBe("99.0.0");
			await expect(fetchNewerPublishedVersion("99.0.0")).resolves.toBeUndefined();
			await expect(fetchNewerPublishedVersion("100.0.0")).resolves.toBeUndefined();
			expect(requested[0]).toBe("https://registry.npmjs.org/jeopi-cli/latest");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("startup update notice swallows registry failures instead of breaking startup", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() =>
			Promise.resolve(new Response("not found", { status: 404 }))) as unknown as typeof fetch);
		try {
			await expect(fetchNewerPublishedVersion("1.0.0")).resolves.toBeUndefined();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("names the phantom package and the manual reinstall escape hatch when the registry 404s the update check", async () => {
		// Regression: globals built before the `jeopi` → `jeopi-cli` rename query
		// the nonexistent `jeopi` package and died with a bare
		// `Failed to fetch release info: Not Found` — zero hint which package the
		// check targeted or how to recover. Self-update can never fix itself once
		// the tracked package name is wrong, so the 404 path must name the
		// package and the manual `bun install -g` recovery.
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() =>
			Promise.resolve(new Response("not found", { status: 404 }))) as unknown as typeof fetch);
		try {
			await expect(getLatestRelease()).rejects.toThrow(
				'Package "jeopi-cli" was not found on https://registry.npmjs.org/',
			);
			await expect(getLatestRelease()).rejects.toThrow("bun install -g jeopi-cli");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("reports the failing package and HTTP status on non-404 registry errors", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() =>
			Promise.resolve(
				new Response("boom", { status: 503, statusText: "Service Unavailable" }),
			)) as unknown as typeof fetch);
		try {
			await expect(getLatestRelease()).rejects.toThrow(
				"Failed to fetch release info for jeopi-cli from https://registry.npmjs.org/: HTTP 503",
			);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("derives global node_modules from supported bun global locations", () => {
		expect(resolveBunGlobalNodeModulesDirFromLocations(path.join("home", ".bun", "bin"), undefined)).toBe(
			path.join("home", ".bun", "install", "global", "node_modules"),
		);
		expect(
			resolveBunGlobalNodeModulesDirFromLocations(undefined, path.join("home", ".bun", "install", "cache")),
		).toBe(path.join("home", ".bun", "install", "global", "node_modules"));
	});
});

describe("update-cli bun cache pruning", () => {
	it("keeps only the newest cached version for filtered global install packages", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "react", "18.3.1@@@1"), "");
		await Bun.write(path.join(dir, "react", "19.2.6@@@1"), "");
		await Bun.write(
			path.join(dir, "react@18.3.1@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "18.3.1" }),
		);
		await Bun.write(
			path.join(dir, "react@19.2.6@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "19.2.6" }),
		);
		await Bun.write(path.join(dir, "jeopi-utils", "15.7.6@@@1"), "");
		await Bun.write(path.join(dir, "jeopi-utils", "15.8.0@@@1"), "");
		await Bun.write(
			path.join(dir, "jeopi-utils@15.7.6@@@1", "package.json"),
			JSON.stringify({ name: "jeopi-utils", version: "15.7.6" }),
		);
		await Bun.write(
			path.join(dir, "jeopi-utils@15.8.0@@@1", "package.json"),
			JSON.stringify({ name: "jeopi-utils", version: "15.8.0" }),
		);
		await Bun.write(path.join(dir, "chalk", "4.1.2@@@1"), "");
		await Bun.write(path.join(dir, "chalk", "5.6.2@@@1"), "");
		await Bun.write(
			path.join(dir, "chalk@4.1.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "4.1.2" }),
		);
		await Bun.write(
			path.join(dir, "chalk@5.6.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "5.6.2" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["react", "jeopi-utils"]));

		expect(result).toEqual({ scannedPackages: 2, removedEntries: 4 });
		expect(await Bun.file(path.join(dir, "react", "18.3.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react@18.3.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react", "19.2.6@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "react@19.2.6@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "jeopi-utils", "15.7.6@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "jeopi-utils@15.7.6@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "jeopi-utils", "15.8.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "jeopi-utils@15.8.0@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk", "4.1.2@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk@4.1.2@@@1", "package.json")).exists()).toBe(true);
	});

	it("keeps current registry-qualified marker entries with their materialized package", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["pkg"]));

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 0 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json")).exists()).toBe(true);
	});

	it("treats a stable release as newer than a matching prerelease", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0-beta.1@@@1"), "");
		await Bun.write(path.join(dir, "pkg", "1.0.0@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0-beta.1" }),
		);
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir);

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 2 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0-beta.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@@1", "package.json")).exists()).toBe(true);
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous jeopi binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});

describe("update-cli binary replacement on locked backups", () => {
	it("treats an EPERM on backup cleanup as a successful, completed update", async () => {
		// Regression: on Windows the binary moved aside during the swap is still
		// the running process image, so unlinking it throws EPERM. That cleanup
		// failure must not turn a verified swap into "Update failed" (issue #845).
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.1700000000000.4242.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		const realUnlink = nodeFs.promises.unlink.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "unlink").mockImplementation(async (p: nodeFs.PathLike) => {
			if (String(p) === backupPath) {
				const err = new Error(`EPERM: operation not permitted, unlink '${p}'`) as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return realUnlink(p);
		});
		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
		} finally {
			spy.mockRestore();
		}

		// New binary is installed and the temp consumed even though the locked
		// backup survives; the next run's sweep reclaims it once it is unlocked.
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).text()).toBe("old binary");
	});
});

describe("update-cli stale backup sweep", () => {
	it("reclaims timestamped and legacy backups while leaving unrelated .bak files", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		await Bun.write(targetPath, "current binary");
		await Bun.write(`${targetPath}.bak`, "legacy backup");
		await Bun.write(`${targetPath}.1700000000000.4242.bak`, "timestamped backup");
		await Bun.write(`${targetPath}.1800000000000.99.bak`, "another backup");
		// Must survive: foreign basename and a non-numeric middle segment.
		await Bun.write(path.join(dir, "notes.bak"), "keep me");
		await Bun.write(`${targetPath}.config.bak`, "keep me too");

		await sweepStaleBackups(targetPath);

		expect(await Bun.file(targetPath).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1800000000000.99.bak`).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "notes.bak")).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.bak`).exists()).toBe(true);
	});
});
