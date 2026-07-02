import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "jeopi-catalog/models";
import { KeybindingsManager } from "jeopi-cli/config/keybindings";
import type { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { ModelSelectorComponent } from "jeopi-cli/modes/components/model-selector";
import { SessionSelectorComponent } from "jeopi-cli/modes/components/session-selector";
import { initTheme } from "jeopi-cli/modes/theme/theme";
import type { SessionInfo } from "jeopi-cli/session/session-listing";
import { setKeybindings, type TUI } from "jeopi-tui";

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
});

function createSession(id: string, title: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 0,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
	};
}

describe("component escape bindings", () => {
	it("uses app.interrupt for session selector cancel without changing Ctrl+C exit", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.interrupt": "alt+x",
		});
		setKeybindings(keybindings);

		const onCancel = vi.fn();
		const onExit = vi.fn();
		const selector = new SessionSelectorComponent(
			[createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
			() => {},
			onCancel,
			onExit,
		);

		selector.handleInput("\x1b");
		expect(onCancel).not.toHaveBeenCalled();

		selector.handleInput("\x1bx");
		expect(onCancel).toHaveBeenCalledTimes(1);

		selector.handleInput("\x03");
		expect(onExit).toHaveBeenCalledTimes(1);
	});

	it("uses tui.select.cancel for model selector cancellation", async () => {
		const keybindings = KeybindingsManager.inMemory({
			"tui.select.cancel": "ctrl+g",
		});
		setKeybindings(keybindings);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		}

		const settings = Settings.isolated({
			modelRoles: {
				default: `${model.provider}/${model.id}`,
			},
		});
		const modelRegistry = {
			getAll: () => [model],
			getDiscoverableProviders: () => [],
		} as unknown as ModelRegistry;
		const ui = {
			requestRender: vi.fn(),
		} as unknown as TUI;
		const onCancel = vi.fn();

		const selector = new ModelSelectorComponent(
			ui,
			model,
			settings,
			modelRegistry,
			[{ model, thinkingLevel: "off" }],
			() => {},
			onCancel,
		);

		await Bun.sleep(0);

		selector.handleInput("\x1b");
		expect(onCancel).not.toHaveBeenCalled();

		selector.handleInput("\x07");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
