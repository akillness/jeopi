import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetPluginTrustForTests,
	pluginTrustKey,
	resolvePluginTrust,
	setPluginTrustHandler,
} from "jeopi-cli/extensibility/plugins/trust";
import * as piUtils from "jeopi-utils";

describe("plugin trust gate", () => {
	let storeDir: string;
	let storePath: string;
	let originalTrustAllPlugins: string | undefined;

	beforeEach(() => {
		storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-trust-"));
		storePath = path.join(storeDir, "plugin-trust.json");
		spyOn(piUtils, "getPluginTrustStorePath").mockReturnValue(storePath);
		originalTrustAllPlugins = Bun.env.PI_TRUST_ALL_PLUGINS;
		delete Bun.env.PI_TRUST_ALL_PLUGINS;
		__resetPluginTrustForTests();
	});

	afterEach(() => {
		if (originalTrustAllPlugins === undefined) {
			delete Bun.env.PI_TRUST_ALL_PLUGINS;
		} else {
			Bun.env.PI_TRUST_ALL_PLUGINS = originalTrustAllPlugins;
		}
		__resetPluginTrustForTests();
		spyOn(piUtils, "getPluginTrustStorePath").mockRestore();
		fs.rmSync(storeDir, { recursive: true, force: true });
	});

	const plugin = { name: "@demo/plugin", version: "1.0.0" };

	it("denies by default when no trust handler is registered (headless/CI safe default)", async () => {
		const trusted = await resolvePluginTrust(plugin);
		expect(trusted).toBe(false);
		expect(fs.existsSync(storePath)).toBe(false);
	});

	it("persists a grant and does not re-prompt on the next call", async () => {
		let calls = 0;
		setPluginTrustHandler(async () => {
			calls++;
			return true;
		});

		expect(await resolvePluginTrust(plugin)).toBe(true);
		expect(await resolvePluginTrust(plugin)).toBe(true);
		expect(calls).toBe(1);

		const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
		expect(onDisk[pluginTrustKey(plugin)]).toBe("granted");
	});

	it("persists a denial and does not re-prompt on the next call", async () => {
		let calls = 0;
		setPluginTrustHandler(async () => {
			calls++;
			return false;
		});

		expect(await resolvePluginTrust(plugin)).toBe(false);
		expect(await resolvePluginTrust(plugin)).toBe(false);
		expect(calls).toBe(1);

		const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
		expect(onDisk[pluginTrustKey(plugin)]).toBe("denied");
	});

	it("treats a dismissed prompt (null) as a one-shot skip, not a cached decision", async () => {
		let calls = 0;
		setPluginTrustHandler(async () => {
			calls++;
			return null;
		});

		expect(await resolvePluginTrust(plugin)).toBe(false);
		expect(await resolvePluginTrust(plugin)).toBe(false);
		expect(calls).toBe(2);
		expect(fs.existsSync(storePath)).toBe(false);
	});

	it("re-prompts after a version bump instead of reusing the previous version's grant", async () => {
		setPluginTrustHandler(async () => true);
		expect(await resolvePluginTrust(plugin)).toBe(true);

		const bumped = { name: plugin.name, version: "2.0.0" };
		let bumpedCalls = 0;
		setPluginTrustHandler(async () => {
			bumpedCalls++;
			return false;
		});
		expect(await resolvePluginTrust(bumped)).toBe(false);
		expect(bumpedCalls).toBe(1);
	});

	it("PI_TRUST_ALL_PLUGINS bypasses the gate entirely without prompting or persisting", async () => {
		Bun.env.PI_TRUST_ALL_PLUGINS = "true";
		let calls = 0;
		setPluginTrustHandler(async () => {
			calls++;
			return false;
		});

		expect(await resolvePluginTrust(plugin)).toBe(true);
		expect(calls).toBe(0);
		expect(fs.existsSync(storePath)).toBe(false);
	});
});
