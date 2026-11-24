import { describe, expect, it } from "bun:test";
import { loadExtensions } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import type { Extension, ToolResultEvent } from "../../src/extensibility/extensions/types";
import {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isWriteToolResult,
} from "../../src/extensibility/legacy-pi-coding-agent-shim";

function makeEvent(toolName: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: `call_${toolName}`,
		toolName,
		input: {},
		content: [{ type: "text", text: "ok" }],
		isError: false,
		details: undefined,
	} as unknown as ToolResultEvent;
}

describe("legacy-pi-coding-agent-shim tool result guards", () => {
	const cases: Array<{ name: string; guard: (e: ToolResultEvent) => boolean }> = [
		{ name: "bash", guard: isBashToolResult },
		{ name: "read", guard: isReadToolResult },
		{ name: "edit", guard: isEditToolResult },
		{ name: "write", guard: isWriteToolResult },
		{ name: "grep", guard: isGrepToolResult },
		{ name: "find", guard: isFindToolResult },
		{ name: "ls", guard: isLsToolResult },
	];

	for (const { name, guard } of cases) {
		it(`narrows only toolName === "${name}"`, () => {
			expect(guard(makeEvent(name))).toBe(true);
			for (const other of cases) {
				if (other.name === name) continue;
				expect(guard(makeEvent(other.name))).toBe(false);
			}
			expect(guard(makeEvent("custom_tool"))).toBe(false);
		});
	}
});

describe("ExtensionRunner.emitToolResult malformed output guard", () => {
	it("ignores malformed non-array content and non-boolean isError returned by tool_result handlers", async () => {
		const loaded = await loadExtensions([], "/tmp");
		const ext: Extension = {
			path: "/tmp/malformed-tool-result-ext.ts",
			resolvedPath: "/tmp/malformed-tool-result-ext.ts",
			handlers: new Map([
				[
					"tool_result",
					[
						async () =>
							({
								content: "not-an-array",
								isError: "not-a-boolean",
							}) as unknown as Record<string, unknown>,
					],
				],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
			assistantThinkingRenderers: [],
		};
		const runner = new ExtensionRunner([ext], loaded.runtime, "/tmp", {} as never, {} as never);
		const result = await runner.emitToolResult(makeEvent("bash"));
		expect(result).toBeUndefined();
	});
});
