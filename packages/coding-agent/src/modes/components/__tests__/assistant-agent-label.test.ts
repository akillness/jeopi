/**
 * jeo TUI identity contract: a name label on its own line leads assistant
 * segments with visible prose (jeo-code's `agentLabel()` ported to jeopi).
 * Tool-call-only blocks stay unlabeled, and an empty `ui.agentLabel` disables
 * the label entirely.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "jeopi-ai";
import { Settings } from "../../../config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "../../theme/theme";
import { AssistantMessageComponent, setAssistantAgentLabel } from "../assistant-message";

const strip = (lines: readonly string[]): string =>
	lines
		.join("\n")
		.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	} as AssistantMessage;
}

describe("assistant agent label (jeo identity)", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	afterEach(() => {
		setAssistantAgentLabel("jeo");
	});

	it("leads a reply with the label on its own line", () => {
		const component = new AssistantMessageComponent(
			assistantMessage([{ type: "text", text: "The fix is in place." }]),
		);
		const lines = strip(component.render(80)).split("\n");
		const labelLine = lines.findIndex(line => line.trim() === "jeo");
		const proseLine = lines.findIndex(line => line.includes("The fix is in place."));
		expect(labelLine).toBeGreaterThanOrEqual(0);
		expect(proseLine).toBeGreaterThan(labelLine);
	});

	it("leads a visible thinking block with the label too", () => {
		const component = new AssistantMessageComponent(
			assistantMessage([{ type: "thinking", thinking: "Considering the edge cases first." }]),
			false,
		);
		const text = strip(component.render(80));
		expect(text).toContain("jeo");
		expect(text).toContain("Considering the edge cases first.");
	});

	it("leaves tool-call-only blocks unlabeled", () => {
		const component = new AssistantMessageComponent(
			assistantMessage([
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
			] as AssistantMessage["content"]),
		);
		expect(strip(component.render(80))).not.toContain("jeo");
	});

	it("an empty label disables the identity line", () => {
		setAssistantAgentLabel("");
		const component = new AssistantMessageComponent(assistantMessage([{ type: "text", text: "Done." }]));
		const lines = strip(component.render(80)).split("\n");
		expect(lines.some(line => line.trim() === "jeo")).toBe(false);
		expect(lines.some(line => line.includes("Done."))).toBe(true);
	});
});
