import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { Settings } from "jeopi-cli/config/settings";
import { disposeAllVmContexts, disposeVmContextsByOwner } from "jeopi-cli/eval/js/context-manager";
import { executeJs } from "jeopi-cli/eval/js/executor";
import type { ToolSession } from "jeopi-cli/tools";
import { TempDir } from "jeopi-utils";

setDefaultTimeout(20_000);

function makeToolSession(cwd: string, ownerId: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getEvalKernelOwnerId: () => ownerId,
		settings: Settings.isolated(),
	};
}

afterEach(async () => {
	await disposeAllVmContexts();
});

describe("js executor owner cleanup", () => {
	it("disposes only the target owner's VM context while keeping other owners alive", async () => {
		using tempDir = TempDir.createSync("@jeopi-js-owner-");
		const sessionA = makeToolSession(tempDir.path(), "owner-a");
		const sessionB = makeToolSession(tempDir.path(), "owner-b");

		await executeJs("globalThis.ownerMarker = 'a';", {
			sessionId: "js:owner-a",
			session: sessionA,
		});
		await executeJs("globalThis.ownerMarker = 'b';", {
			sessionId: "js:owner-b",
			session: sessionB,
		});

		await disposeVmContextsByOwner("owner-a");

		const afterDisposeA = await executeJs("return typeof globalThis.ownerMarker;", {
			sessionId: "js:owner-a",
			session: sessionA,
		});
		const afterDisposeB = await executeJs("return globalThis.ownerMarker;", {
			sessionId: "js:owner-b",
			session: sessionB,
		});

		expect(afterDisposeA.output).toContain("undefined");
		expect(afterDisposeB.output).toContain("b");
	});

	it("keeps a shared VM context alive until the last owner is disposed", async () => {
		using tempDir = TempDir.createSync("@jeopi-js-shared-owner-");
		const sessionA = makeToolSession(tempDir.path(), "owner-a");
		const sessionB = makeToolSession(tempDir.path(), "owner-b");

		await executeJs("globalThis.sharedCounter = 41;", {
			sessionId: "js:shared",
			session: sessionA,
		});
		await executeJs("globalThis.sharedCounter += 1;", {
			sessionId: "js:shared",
			session: sessionB,
		});

		await disposeVmContextsByOwner("owner-a");

		const stillAlive = await executeJs("return globalThis.sharedCounter;", {
			sessionId: "js:shared",
			session: sessionB,
		});
		expect(stillAlive.output).toContain("42");

		await disposeVmContextsByOwner("owner-b");

		const resetAfterLastOwner = await executeJs("return typeof globalThis.sharedCounter;", {
			sessionId: "js:shared",
			session: sessionB,
		});
		expect(resetAfterLastOwner.output).toContain("undefined");
	});
});
