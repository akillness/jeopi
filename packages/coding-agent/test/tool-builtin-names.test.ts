import { describe, expect, it } from "bun:test";
import { normalizeToolName, normalizeToolNames } from "jeopi-cli/tools/builtin-names";

describe("builtin tool name normalization", () => {
	it.each([
		{ input: "READ", expected: "read" },
		{ input: "Ast_Grep", expected: "ast_grep" },
		{ input: "YIELD", expected: "yield" },
		{ input: "Report_Finding", expected: "report_finding" },
		{ input: "REPORT_TOOL_ISSUE", expected: "report_tool_issue" },
		{ input: "Resolve", expected: "resolve" },
		{ input: "GOAL", expected: "goal" },
		{ input: "SeArCh", expected: "grep" },
		{ input: "FIND", expected: "glob" },
		{ input: "mcp__Calendar__CreateEvent", expected: "mcp__Calendar__CreateEvent" },
		{ input: "MyPlugin.Search", expected: "MyPlugin.Search" },
		{ input: "ReadDocument", expected: "ReadDocument" },
	])("resolves $input to $expected without renaming external tools", ({ input, expected }) => {
		expect(normalizeToolName(input)).toBe(expected);
	});

	it("deduplicates builtin aliases but keeps case-distinct external tools in first-seen order", () => {
		expect(
			normalizeToolNames([
				"SeArCh",
				"mcp__Calendar__CreateEvent",
				"GREP",
				"mcp__calendar__createevent",
				"FIND",
				"MyPlugin.Search",
				"glob",
				"MyPlugin.Search",
				"myplugin.search",
				"READ",
				"read",
			]),
		).toEqual([
			"grep",
			"mcp__Calendar__CreateEvent",
			"mcp__calendar__createevent",
			"glob",
			"MyPlugin.Search",
			"myplugin.search",
			"read",
		]);
	});
});
