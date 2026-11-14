import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "jeopi-agent-core";
import type { SessionEntry, SessionMessageEntry, ShakeConfig } from "jeopi-agent-core/compaction";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	applyShakeRegion,
	applyShakeRegions,
	collectShakeRegions,
	DEFAULT_SHAKE_CONFIG,
	estimateTokens,
} from "jeopi-agent-core/compaction";
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from "jeopi-ai";

let idCounter = 0;
function nextId(): string {
	return `entry-${idCounter++}`;
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date().toISOString(), message };
}

function toolResultMessage(toolName: string, text: string, extra?: Partial<ToolResultMessage>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${idCounter++}`,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
		...extra,
	};
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

/** Repeat a representative code line enough to clear ~`approxTokens` tokens. */
function fencedBlock(approxTokens: number, lang = "ts"): string {
	const line = "const value = computeSomething(alpha, beta, gamma, delta, epsilon);";
	const count = Math.ceil((approxTokens * 4) / line.length);
	return `\`\`\`${lang}\n${Array(count).fill(line).join("\n")}\n\`\`\``;
}

function xmlBlock(approxTokens: number, tag = "example"): string {
	const line = "  payload row with identifiers alpha beta gamma delta epsilon zeta;";
	const count = Math.ceil((approxTokens * 4) / line.length);
	return `<${tag}>\n${Array(count).fill(line).join("\n")}\n</${tag}>`;
}

function cfg(over: Partial<ShakeConfig> = {}): ShakeConfig {
	return { protectTokens: 0, minSavings: 0, protectedTools: [], fenceMinTokens: 50, ...over };
}

describe("collectShakeRegions — tool results", () => {
	test("collects unprotected tool results and applyShakeRegion sets prunedAt", () => {
		const tr = toolResultMessage("bash", "x".repeat(400));
		const entry = messageEntry(tr);
		const regions = collectShakeRegions([entry], cfg());

		expect(regions).toHaveLength(1);
		const region = regions[0];
		expect(region.kind).toBe("toolResult");
		expect(region.tokens).toBeGreaterThan(0);

		applyShakeRegion(region, "[shaken]");
		expect(tr.prunedAt).toBeGreaterThan(0);
		expect(tr.content).toEqual([{ type: "text", text: "[shaken]" }]);
	});

	test("never collects protected tools", () => {
		const entry = messageEntry(toolResultMessage("skill", "y".repeat(800)));
		const regions = collectShakeRegions([entry], cfg({ protectedTools: ["skill"] }));
		expect(regions).toHaveLength(0);
	});

	test("never collects already-pruned tool results", () => {
		const entry = messageEntry(toolResultMessage("bash", "z".repeat(800), { prunedAt: Date.now() }));
		const regions = collectShakeRegions([entry], cfg());
		expect(regions).toHaveLength(0);
	});

	test("honors the protect-recent token window", () => {
		const text = "word ".repeat(160); // ~ deterministic token block
		const older = messageEntry(toolResultMessage("bash", text));
		const middle = messageEntry(toolResultMessage("bash", text));
		const recent = messageEntry(toolResultMessage("bash", text));
		const perEntry = estimateTokens(older.message);
		// Window covers the most recent ~1.5 entries → middle & recent protected, older eligible.
		const regions = collectShakeRegions([older, middle, recent], cfg({ protectTokens: Math.floor(perEntry * 1.5) }));

		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(older);
	});

	test("minSavings gates the whole batch", () => {
		const entry = messageEntry(toolResultMessage("bash", "q".repeat(800)));
		const tokens = estimateTokens(entry.message);
		expect(collectShakeRegions([entry], cfg({ minSavings: tokens * 10 }))).toHaveLength(0);
		expect(collectShakeRegions([entry], cfg({ minSavings: 0 }))).toHaveLength(1);
	});
});

describe("collectShakeRegions — fenced / XML blocks", () => {
	test("detects a large fenced block and applyShakeRegion splices it out", () => {
		const fence = fencedBlock(120);
		const text = `intro line\n${fence}\noutro line`;
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		const regions = collectShakeRegions([entry], cfg());

		expect(regions).toHaveLength(1);
		const region = regions[0];
		expect(region.kind).toBe("block");
		if (region.kind !== "block") throw new Error("expected block region");
		expect(text.slice(region.start, region.end)).toBe(fence);

		applyShakeRegion(region, "[shaken]");
		const block = (entry.message as AssistantMessage).content[0] as TextContent;
		expect(block.text).toBe("intro line\n[shaken]\noutro line");
	});

	test("ignores fenced blocks below fenceMinTokens", () => {
		const text = "intro\n```ts\nconst a = 1;\n```\noutro";
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		expect(collectShakeRegions([entry], cfg({ fenceMinTokens: 400 }))).toHaveLength(0);
	});

	test("detects a top-level XML block", () => {
		const xml = xmlBlock(120);
		const text = `before\n${xml}\nafter`;
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		const regions = collectShakeRegions([entry], cfg());

		expect(regions).toHaveLength(1);
		const region = regions[0];
		if (region.kind !== "block") throw new Error("expected block region");
		expect(text.slice(region.start, region.end)).toBe(xml);
	});

	test("never targets toolCall blocks and points blockIndex at the text block", () => {
		const fence = fencedBlock(120);
		const toolCall: ToolCall = { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "x" } };
		const entry = messageEntry(
			assistantMessage([{ type: "text", text: "tiny" }, toolCall, { type: "text", text: `pre\n${fence}\npost` }]),
		);
		const regions = collectShakeRegions([entry], cfg());

		expect(regions).toHaveLength(1);
		const region = regions[0];
		if (region.kind !== "block") throw new Error("expected block region");
		expect(region.blockIndex).toBe(2);
	});

	test("does not cross message boundaries — each large block stays in its own entry", () => {
		const a = messageEntry(assistantMessage([{ type: "text", text: `a\n${fencedBlock(120)}\na` }]));
		const b = messageEntry(assistantMessage([{ type: "text", text: `b\n${fencedBlock(120, "py")}\nb` }]));
		const regions = collectShakeRegions([a, b], cfg());

		expect(regions).toHaveLength(2);
		expect(regions[0].entry).toBe(a);
		expect(regions[1].entry).toBe(b);
	});

	test("ignores unterminated fences (conservative)", () => {
		const text = `intro\n\`\`\`ts\n${"const a = 1;\n".repeat(60)}`; // never closes
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		expect(collectShakeRegions([entry], cfg())).toHaveLength(0);
	});
});

describe("applyShakeRegions — multi-region ordering", () => {
	test("splices two blocks in one text block correctly (highest-start-first)", () => {
		const first = fencedBlock(80);
		const second = fencedBlock(80, "py");
		const text = `head\n${first}\nmiddle\n${second}\ntail`;
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		const regions = collectShakeRegions([entry], cfg());
		expect(regions).toHaveLength(2);

		applyShakeRegions([
			{ region: regions[0], replacement: "[A]" },
			{ region: regions[1], replacement: "[B]" },
		]);
		const block = (entry.message as AssistantMessage).content[0] as TextContent;
		expect(block.text).toBe("head\n[A]\nmiddle\n[B]\ntail");
	});
});

describe("shake config presets", () => {
	test("aggressive preset protects skill and drops everything else", () => {
		expect(AGGRESSIVE_SHAKE_CONFIG.protectTokens).toBe(0);
		expect(AGGRESSIVE_SHAKE_CONFIG.minSavings).toBe(0);
		expect(AGGRESSIVE_SHAKE_CONFIG.protectedTools).toContain("skill");
	});

	test("default preset keeps a protect window", () => {
		expect(DEFAULT_SHAKE_CONFIG.protectTokens).toBeGreaterThan(0);
		expect(DEFAULT_SHAKE_CONFIG.protectedTools).toContain("skill");
	});

	test("empty branch yields no regions", () => {
		expect(collectShakeRegions([] as SessionEntry[], AGGRESSIVE_SHAKE_CONFIG)).toHaveLength(0);
	});
});

describe("collectShakeRegions — useless results", () => {
	test("useless tool result inside the protect window yields a region; identical plain result does not", () => {
		const text = "No matches found in any scanned file.\n".repeat(20);
		const flagged = messageEntry(toolResultMessage("search", text, { useless: true }));
		const plain = messageEntry(toolResultMessage("search", text));
		// Window far larger than the whole branch: only the flagged result bypasses it.
		const regions = collectShakeRegions([flagged, plain], cfg({ protectTokens: 1_000_000 }));
		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(flagged);
	});

	test("an error result never bypasses the window even when flagged", () => {
		const entry = messageEntry(toolResultMessage("search", "boom\n".repeat(50), { useless: true, isError: true }));
		expect(collectShakeRegions([entry], cfg({ protectTokens: 1_000_000 }))).toHaveLength(0);
	});
});

describe("collectShakeRegions — error, aborted, mixed-image, and pairing preservation", () => {
	test("never collects isError tool results even with aggressive config", () => {
		const entry = messageEntry(toolResultMessage("bash", "fatal error details\n".repeat(120), { isError: true }));
		expect(collectShakeRegions([entry], cfg())).toHaveLength(0);
	});

	test("never collects aborted tool results or results from aborted/errored assistant turns", () => {
		const abortedDetailsResult = messageEntry(
			toolResultMessage("task", "partial cancelled task output\n".repeat(100), {
				details: { aborted: true },
			}),
		);
		const abortedTurnCallId = "call-aborted-turn";
		const abortedAssistant = messageEntry({
			...assistantMessage([
				{ type: "text", text: `partial\n${fencedBlock(120)}` },
				{ type: "toolCall", id: abortedTurnCallId, name: "bash", arguments: { command: "sleep 99" } },
			]),
			stopReason: "aborted",
			errorMessage: "Request aborted",
		});
		const abortedPairedResult = messageEntry(
			toolResultMessage("bash", "Tool execution was aborted\n".repeat(80), {
				toolCallId: abortedTurnCallId,
				isError: false,
			}),
		);
		const erroredAssistant = messageEntry({
			...assistantMessage([{ type: "text", text: `error trace\n${fencedBlock(120)}` }]),
			stopReason: "error",
			errorMessage: "Provider failed",
		});

		const regions = collectShakeRegions(
			[abortedDetailsResult, abortedAssistant, abortedPairedResult, erroredAssistant],
			cfg(),
		);
		expect(regions).toHaveLength(0);
	});

	test("never collects mixed-image tool results so images are never dropped", () => {
		const mixed = messageEntry({
			role: "toolResult",
			toolCallId: "call-mixed-img",
			toolName: "read_image",
			content: [
				{ type: "text", text: "screenshot analysis ".repeat(150) },
				{ type: "image", data: "iVBORw0KGgo", mimeType: "image/png" },
			],
			isError: false,
			timestamp: Date.now(),
		});
		const textOnly = messageEntry(toolResultMessage("bash", "normal log output ".repeat(150)));

		const regions = collectShakeRegions([mixed, textOnly], cfg());
		expect(regions).toHaveLength(1);
		expect(regions[0]?.entry).toBe(textOnly);
	});

	test("preserves toolCall/toolResult pairing in multi-tool turns when shaking eligible siblings", () => {
		const errorCallId = "call-err";
		const okCallId = "call-ok";
		const assistantEntry = messageEntry(
			assistantMessage([
				{ type: "toolCall", id: errorCallId, name: "bash", arguments: { command: "false" } },
				{ type: "toolCall", id: okCallId, name: "bash", arguments: { command: "cat big.log" } },
			]),
		);
		const errEntry = messageEntry(
			toolResultMessage("bash", "error output ".repeat(80), { toolCallId: errorCallId, isError: true }),
		);
		const okEntry = messageEntry(
			toolResultMessage("bash", "large output ".repeat(120), { toolCallId: okCallId, isError: false }),
		);

		const regions = collectShakeRegions([assistantEntry, errEntry, okEntry], cfg());
		expect(regions).toHaveLength(1);
		expect(regions[0]?.entry).toBe(okEntry);

		applyShakeRegions([{ region: regions[0]!, replacement: "[shaken — artifact://0]" }]);

		const assistantCalls = (assistantEntry.message as AssistantMessage).content.filter(b => b.type === "toolCall");
		expect(assistantCalls.map(c => c.id)).toEqual([errorCallId, okCallId]);
		expect((errEntry.message as ToolResultMessage).toolCallId).toBe(errorCallId);
		expect((errEntry.message as ToolResultMessage).content[0]).toEqual({
			type: "text",
			text: "error output ".repeat(80),
		});
		expect((okEntry.message as ToolResultMessage).toolCallId).toBe(okCallId);
		expect((okEntry.message as ToolResultMessage).toolName).toBe("bash");
		expect((okEntry.message as ToolResultMessage).content).toEqual([
			{ type: "text", text: "[shaken — artifact://0]" },
		]);
	});
});
