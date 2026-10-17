import { afterEach, describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown } from "jeopi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

afterEach(() => clearRenderCache());

describe("Markdown shared render cache memory budget", () => {
	it("evicts older large layouts before the entry-count limit while preserving rendered output", () => {
		clearRenderCache();
		let highlights = 0;
		const theme = {
			...defaultMarkdownTheme,
			highlightCode: (code: string): string[] => {
				highlights++;
				return code.split("\n");
			},
		};
		const text = `\`\`\`text\n${`${"x".repeat(63)}\n`.repeat(1024)}\`\`\``;
		const original = new Markdown(text, 0, 0, theme).render(80);
		expect(highlights).toBe(1);
		expect(new Markdown(text, 0, 0, theme).render(80)).toEqual(original);
		expect(highlights).toBe(1);

		// Far fewer than 256 entries, but these full-text keys and rendered
		// layouts must not all survive when the shared byte budget fills.
		for (let width = 81; width <= 120; width++) new Markdown(text, 0, 0, theme).render(width);
		expect(highlights).toBe(41);
		new Markdown(text, 0, 0, theme).render(120);
		expect(highlights).toBe(41);
		expect(new Markdown(text, 0, 0, theme).render(80)).toEqual(original);
		expect(highlights).toBe(42);
		clearRenderCache();
		expect(new Markdown(text, 0, 0, theme).render(80)).toEqual(original);
		expect(highlights).toBe(43);
	});

	it("keeps oversized output in the live instance without retaining it across discarded instances", () => {
		clearRenderCache();
		let highlights = 0;
		const theme = {
			...defaultMarkdownTheme,
			highlightCode: (code: string): string[] => {
				highlights++;
				return code.split("\n");
			},
		};
		const text = `\`\`\`text\n${`${"x".repeat(63)}\n`.repeat(9600)}\`\`\``;
		const live = new Markdown(text, 0, 0, theme);
		const original = live.render(80);
		expect(highlights).toBe(1);
		expect(live.render(80)).toBe(original);
		expect(highlights).toBe(1);
		expect(new Markdown(text, 0, 0, theme).render(80)).toEqual(original);
		expect(highlights).toBe(2);
	});
});
