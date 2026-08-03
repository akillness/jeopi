import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, StopReason, TextContent, ToolCall, Usage } from "jeopi-ai";
import { salvageLeakedToolCalls } from "jeopi-ai/dialect";

const TOOLS = [
	{
		name: "read",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, count: { type: "number" } },
			required: ["path"],
		},
	},
	{
		name: "write",
		description: "Write a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
	},
	{
		// Internal name differs from the name the model sees on the wire, mirroring
		// the custom-tool mechanism (e.g. GPT-5 trained on `apply_patch`).
		name: "edit",
		customWireName: "apply_patch",
		description: "Apply a patch",
		parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
	},
] as unknown as NonNullable<Context["tools"]>;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: AssistantMessage["content"], stopReason: StopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason,
		timestamp: 0,
	};
}

function text(body: string, stopReason: StopReason = "stop"): AssistantMessage {
	return assistant([{ type: "text", text: body }], stopReason);
}

/** The user-visible half of the turn: every text block concatenated, as rendered. */
function visibleText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("");
}

function toolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

const PROSE = "I need to audit the current state first.";
const READ_INVOKE = '<invoke name="read">\n<parameter name="path">src/agent-loop.ts</parameter>\n</invoke>';

/**
 * The reported bug verbatim: a `stop` turn whose visible text carries a
 * fully-formed call and zero runnable tool calls. Reused by the guard tests so
 * each refusal differs from this salvageable baseline by exactly one variable.
 */
const LEAKED = `${PROSE}\n\n<invoke name="read">\n<parameter name="path">src/agent-loop.ts</parameter>\n<parameter name="count">3</parameter>\n</invoke>\n`;

describe("salvageLeakedToolCalls — recovery", () => {
	it("turns a leaked bare invoke into a runnable call and strips the markup from the visible text", () => {
		const salvaged = salvageLeakedToolCalls(text(LEAKED), TOOLS);
		if (!salvaged) throw new Error("expected the leaked turn to be salvaged");

		// The announced work becomes runnable: right tool, right parsed arguments.
		expect(salvaged.calls.map(call => call.name)).toEqual(["read"]);
		expect(salvaged.calls[0]?.arguments).toEqual({ path: "src/agent-loop.ts", count: 3 });
		// The loop must see a tool turn carrying the call as real content, not a finished answer.
		expect(salvaged.message.stopReason).toBe("toolUse");
		expect(toolCalls(salvaged.message).map(call => call.name)).toEqual(["read"]);
		// The user-visible half of the bug: prose survives, raw markup is gone.
		const visible = visibleText(salvaged.message);
		expect(visible).toContain(PROSE);
		expect(visible).not.toContain("<invoke");
		expect(visible).not.toContain("<parameter");
	});

	it("recovers a call wrapped in a <function_calls> envelope", () => {
		const salvaged = salvageLeakedToolCalls(
			text(`Auditing now.\n\n<function_calls>\n${READ_INVOKE}\n</function_calls>\n`),
			TOOLS,
		);
		if (!salvaged) throw new Error("expected the wrapped turn to be salvaged");

		expect(salvaged.calls.map(call => call.name)).toEqual(["read"]);
		expect(salvaged.calls[0]?.arguments).toEqual({ path: "src/agent-loop.ts" });
		expect(salvaged.message.stopReason).toBe("toolUse");
		const visible = visibleText(salvaged.message);
		expect(visible).toContain("Auditing now.");
		expect(visible).not.toContain("<function_calls");
		expect(visible).not.toContain("<invoke");
	});

	it("recovers every leaked invoke in the turn, preserving emission order", () => {
		const body = [
			"Reading both files, then writing.",
			"",
			'<invoke name="read">\n<parameter name="path">first.ts</parameter>\n</invoke>',
			'<invoke name="write">\n<parameter name="path">second.ts</parameter>\n<parameter name="content">hi</parameter>\n</invoke>',
			'<invoke name="read">\n<parameter name="path">third.ts</parameter>\n</invoke>',
			"",
		].join("\n");

		const salvaged = salvageLeakedToolCalls(text(body), TOOLS);
		if (!salvaged) throw new Error("expected the multi-call turn to be salvaged");

		expect(salvaged.calls.map(call => call.name)).toEqual(["read", "write", "read"]);
		expect(salvaged.calls.map(call => call.arguments.path)).toEqual(["first.ts", "second.ts", "third.ts"]);
		// Order must survive into the dispatched content, not just the returned list.
		expect(toolCalls(salvaged.message).map(call => call.arguments.path)).toEqual([
			"first.ts",
			"second.ts",
			"third.ts",
		]);
	});

	it("accepts a call that names an available tool by its customWireName", () => {
		const body =
			'Patching.\n\n<invoke name="apply_patch">\n<parameter name="input">*** Begin Patch</parameter>\n</invoke>\n';

		const salvaged = salvageLeakedToolCalls(text(body), TOOLS);
		if (!salvaged) throw new Error("expected the custom-wire-name call to be salvaged");

		// `edit` is offered to the model as `apply_patch`; the loop's dispatcher
		// matches that wire name, so it must survive salvage unchanged.
		expect(salvaged.calls.map(call => call.name)).toEqual(["apply_patch"]);
		expect(salvaged.calls[0]?.arguments).toEqual({ input: "*** Begin Patch" });
		expect(salvaged.message.stopReason).toBe("toolUse");
	});

	it("leaves the input message untouched when it salvages", () => {
		const original = text(LEAKED);

		const salvaged = salvageLeakedToolCalls(original, TOOLS);
		if (!salvaged) throw new Error("expected the leaked turn to be salvaged");

		expect(original.stopReason).toBe("stop");
		expect(toolCalls(original)).toEqual([]);
		expect(visibleText(original)).toBe(LEAKED);
	});
});

describe("salvageLeakedToolCalls — refusal", () => {
	it("refuses a truncated turn, whose markup may be cut mid-argument", () => {
		// Same text and tools as the salvageable baseline; only the stop reason differs.
		expect(salvageLeakedToolCalls(text(LEAKED, "length"), TOOLS)).toBeUndefined();
	});

	it("refuses a turn that already called a tool natively, treating the markup as documentation", () => {
		const documenting = assistant([
			{ type: "text", text: `Tool calls look like this:\n\n${READ_INVOKE}\n` },
			{ type: "toolCall", id: "tc_1", name: "read", arguments: { path: "already.ts" } },
		]);

		expect(salvageLeakedToolCalls(documenting, TOOLS)).toBeUndefined();
	});

	it("refuses when no tools are available to dispatch to", () => {
		expect(salvageLeakedToolCalls(text(LEAKED), [])).toBeUndefined();
		expect(salvageLeakedToolCalls(text(LEAKED), undefined)).toBeUndefined();
	});

	it("refuses markup that only appears inside a fenced code block", () => {
		const body = `The syntax is:\n\n\`\`\`\n${READ_INVOKE}\n\`\`\`\n\nThat is all.\n`;

		expect(salvageLeakedToolCalls(text(body), TOOLS)).toBeUndefined();
	});

	it("refuses entirely when invokes appear both inside and outside a fence, rather than guessing", () => {
		const body = `The syntax is:\n\n\`\`\`\n${READ_INVOKE}\n\`\`\`\n\nNow doing it:\n\n${READ_INVOKE}\n`;

		expect(salvageLeakedToolCalls(text(body), TOOLS)).toBeUndefined();
	});

	it("refuses when a recovered call names a tool that is not available", () => {
		const body =
			'Cleaning up.\n\n<invoke name="delete_everything">\n<parameter name="path">/</parameter>\n</invoke>\n';

		expect(salvageLeakedToolCalls(text(body), TOOLS)).toBeUndefined();
	});

	it("refuses an ordinary prose answer that carries no invoke markup", () => {
		const body = "The audit is complete. Nothing needs changing, so I did not call any tools.";

		expect(salvageLeakedToolCalls(text(body), TOOLS)).toBeUndefined();
	});
});
