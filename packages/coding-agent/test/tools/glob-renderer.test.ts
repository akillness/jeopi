import { describe, expect, it } from "bun:test";
import { getThemeByName } from "jeopi-cli/modes/theme/theme";
import { sanitizeText } from "jeopi-utils";
import { globToolRenderer } from "../../src/tools/glob";

describe("globToolRenderer", () => {
	it("indents inline glob output and avoids accent-colored success headers", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 2,
				files: ["src/a.ts", "src/b.ts"],
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
			.render(240);
		const plainLines = sanitizeText(renderedLines.join("\n")).split("\n");

		expect(plainLines.every(line => line.startsWith(" "))).toBe(true);
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", uiTheme.symbol("icon.search")));
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", "Find"));
	});

	it("renders a timed-out empty scan as incomplete, not a definitive no-files claim", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "Glob timed out after 5s before finding any matches" }],
			details: {
				fileCount: 0,
				files: [],
				truncated: true,
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "**/*.ts" })
			.render(240);
		const plainText = sanitizeText(renderedLines.join("\n"));

		expect(plainText).toContain("No matches before timeout (scan incomplete)");
		expect(plainText).not.toContain("No files found");
		expect(plainText).toContain("timed out");
	});

	it("renders a genuinely empty scan as a definitive no-files claim", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "No files found matching pattern" }],
			details: {
				fileCount: 0,
				files: [],
				truncated: false,
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "**/*.ts" })
			.render(240);
		const plainText = sanitizeText(renderedLines.join("\n"));

		expect(plainText).toContain("No files found");
		expect(plainText).not.toContain("scan incomplete");
	});
});
