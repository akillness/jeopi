import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAuthBrokerConfig } from "jeopi-ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const CLEAR_BROKER_ENV = {
	JEOPI_AUTH_BROKER_URL: undefined,
	JEOPI_AUTH_BROKER_TOKEN: undefined,
} as const;

describe("auth-broker config.yml key resolution", () => {
	let agentDir = "";

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeopi-ai-auth-broker-config-"));
	});

	afterEach(async () => {
		if (agentDir) await removeWithRetries(agentDir);
		agentDir = "";
	});

	async function writeConfig(yaml: string, filename = "config.yml"): Promise<void> {
		await Bun.write(path.join(agentDir, filename), yaml);
	}

	test("nested YAML keys resolve broker url and token", async () => {
		await writeConfig(
			["auth:", "  broker:", "    url: https://broker.example", "    token: nested-token", ""].join("\n"),
		);
		await withEnv(CLEAR_BROKER_ENV, async () => {
			const config = await resolveAuthBrokerConfig({ agentDir });
			expect(config).toEqual({ url: "https://broker.example", token: "nested-token" });
		});
	});

	test("legacy flat dotted keys still resolve", async () => {
		await writeConfig(['"auth.broker.url": https://flat.example', '"auth.broker.token": flat-token', ""].join("\n"));
		await withEnv(CLEAR_BROKER_ENV, async () => {
			const config = await resolveAuthBrokerConfig({ agentDir });
			expect(config).toEqual({ url: "https://flat.example", token: "flat-token" });
		});
	});

	test("nested values win over flat dotted keys", async () => {
		await writeConfig(
			[
				'"auth.broker.url": https://flat.example',
				'"auth.broker.token": flat-token',
				"auth:",
				"  broker:",
				"    url: https://nested.example",
				"    token: nested-token",
				"",
			].join("\n"),
		);
		await withEnv(CLEAR_BROKER_ENV, async () => {
			const config = await resolveAuthBrokerConfig({ agentDir });
			expect(config).toEqual({ url: "https://nested.example", token: "nested-token" });
		});
	});

	test("config.yaml nested keys resolve broker url and token", async () => {
		await writeConfig(
			["auth:", "  broker:", "    url: https://broker.example", "    token: yaml-token", ""].join("\n"),
			"config.yaml",
		);
		await withEnv(CLEAR_BROKER_ENV, async () => {
			const config = await resolveAuthBrokerConfig({ agentDir });
			expect(config).toEqual({ url: "https://broker.example", token: "yaml-token" });
		});
	});
});
