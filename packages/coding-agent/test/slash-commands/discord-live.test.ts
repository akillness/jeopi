import { describe, expect, test } from "bun:test";
import type { InteractiveModeContext } from "jeopi-cli/modes/types";
import { type BuiltinSlashCommandRuntime, executeBuiltinSlashCommand } from "jeopi-cli/slash-commands/builtin-registry";

function commandHarness() {
	const errors: string[] = [];
	const ctx = {
		editor: { setText: () => {} },
		sessionManager: { getCwd: () => "/tmp/live-discord-workspace" },
		showError: (message: string) => errors.push(message),
		liveDiscordBridge: undefined,
	} as unknown as InteractiveModeContext;
	return { runtime: { ctx } as BuiltinSlashCommandRuntime, errors };
}

describe("/discord live authorization acknowledgement", () => {
	test("rejects a path without the explicit full-control acknowledgement before loading config", async () => {
		const harness = commandHarness();

		const handled = await executeBuiltinSlashCommand("/discord live /tmp/private-messenger.json", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.errors).toEqual(["Usage: /discord live <private messenger.json> --allow-full-control"]);
	});
});
