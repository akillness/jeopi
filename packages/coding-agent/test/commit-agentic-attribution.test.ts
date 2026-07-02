import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "jeopi-catalog/models";
import { runCommitAgentSession } from "jeopi-cli/commit/agentic/agent";
import * as toolsModule from "jeopi-cli/commit/agentic/tools";
import { Settings } from "jeopi-cli/config/settings";
import type { CreateAgentSessionResult } from "jeopi-cli/sdk";
import * as sdkModule from "jeopi-cli/sdk";
import type { PromptOptions } from "jeopi-cli/session/agent-session";

describe("commit agent prompt attribution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("marks generated commit prompts and reminders as agent-attributed", async () => {
		const prompts: Array<{ text: string; options?: PromptOptions }> = [];
		const session = {
			prompt: async (text: string, options?: PromptOptions) => {
				prompts.push({ text, options });
			},
			subscribe: () => () => {},
			dispose: async () => {},
		};

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as unknown as CreateAgentSessionResult);
		vi.spyOn(toolsModule, "createCommitTools").mockReturnValue([]);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 model to exist");
		}

		await runCommitAgentSession({
			cwd: "/tmp",
			model,
			settings: Settings.isolated(),
			modelRegistry: {} as never,
			authStorage: {} as never,
			changelogTargets: [],
			requireChangelog: false,
		});

		expect(prompts).toHaveLength(4);
		for (const prompt of prompts) {
			expect(prompt.options?.attribution).toBe("agent");
			expect(prompt.options?.expandPromptTemplates).toBe(false);
		}
	});
});
