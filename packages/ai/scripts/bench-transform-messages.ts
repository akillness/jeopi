// Run from the repo root: bun packages/ai/scripts/bench-transform-messages.ts
import { heapStats } from "bun:jsc";
import { parseArgs } from "node:util";
import { buildModel } from "jeopi-catalog/build";
import { transformMessages } from "../src/providers/transform-messages";
import type { AssistantMessage, Message } from "../src/types";

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		turns: { type: "string", default: "500" },
		samples: { type: "string", default: "11" },
		iterations: { type: "string", default: "100" },
		scenario: { type: "string", default: "native" },
	},
});
function positiveInteger(value: string | undefined): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 1) throw new Error("Expected a positive integer");
	return number;
}
const turns = positiveInteger(values.turns);
const samples = positiveInteger(values.samples);
const iterations = positiveInteger(values.iterations);
if (values.scenario !== "native" && values.scenario !== "mixed") throw new Error("Expected native or mixed scenario");
const convert = transformMessages;
const model = buildModel({
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	name: "Replay benchmark",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
});
const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const messages: Message[] = [];
for (let turn = 0; turn < turns; turn++) {
	const toolCallId = `toolu_${turn}`;
	const foreign = values.scenario === "mixed" && turn % 5 === 0;
	const assistant = (
		content: AssistantMessage["content"],
		stopReason: AssistantMessage["stopReason"],
	): AssistantMessage => ({
		role: "assistant",
		content,
		api: foreign ? "openai-responses" : model.api,
		provider: foreign ? "openai" : model.provider,
		model: foreign ? "gpt-5" : model.id,
		usage,
		stopReason,
		timestamp: turn,
	});
	messages.push(
		{ role: "user", content: `Inspect source ${turn} and explain the next change.`, timestamp: turn },
		assistant(
			[
				{
					type: "thinking",
					thinking: `Plan ${turn}: ${"Check the current implementation. ".repeat(4)}`,
					thinkingSignature: `signature_${turn}`,
				},
				{ type: "redactedThinking", data: `redacted_${turn}` },
				{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: `src/module-${turn}.ts` } },
			],
			"toolUse",
		),
		{
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: `Source ${turn}: ${"export const value = 42;\n".repeat(10)}` }],
			isError: false,
			timestamp: turn,
		},
		assistant(
			[{ type: "text", text: `Result ${turn}: preserve the existing behavior and its public interface.` }],
			"stop",
		),
	);
}
const inputJson = JSON.stringify(messages);
let sink = 0;
for (let warmup = 0; warmup < 100; warmup++) sink += convert(messages, model).length;
const timings: number[] = [];
const retainedBytes: number[] = [];
const retainedCells: number[] = [];
for (let sample = 0; sample < samples; sample++) {
	Bun.gc(true);
	const start = performance.now();
	for (let iteration = 0; iteration < iterations; iteration++) sink += convert(messages, model).length;
	timings.push((performance.now() - start) / iterations);
	Bun.gc(true);
	const before = heapStats();
	// Keep several independent results alive to amplify retained allocation above GC noise.
	const retained: Message[][] = [];
	for (let iteration = 0; iteration < 10; iteration++) {
		retained.push(convert(messages, model));
	}
	Bun.gc(true);
	const after = heapStats();
	retainedBytes.push((after.heapSize - before.heapSize) / retained.length);
	retainedCells.push((after.objectCount - before.objectCount) / retained.length);
	for (const result of retained) sink += result.length;
}
function median(numbers: number[]): number {
	const sorted = [...numbers].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
const output = convert(messages, model);
console.log(
	JSON.stringify(
		{
			runtime: Bun.version,
			platform: process.platform,
			arch: process.arch,
			entrypoint: Bun.main,
			scenario: values.scenario,
			turns,
			messages: messages.length,
			inputBytes: Buffer.byteLength(inputJson),
			samples,
			iterations,
			warmup: 100,
			medianMs: median(timings),
			minMs: Math.min(...timings),
			maxMs: Math.max(...timings),
			timingsMs: timings,
			medianRetainedBytesPerConversion: median(retainedBytes),
			medianRetainedCellsPerConversion: median(retainedCells),
			memoryCaveat:
				"Retained bytes/cells measured after full GC with ten outputs alive; not total allocation or within-call peak.",
			inputHash: Bun.hash(inputJson).toString(16),
			outputHash: Bun.hash(JSON.stringify(output)).toString(16),
			inputHashAfter: Bun.hash(JSON.stringify(messages)).toString(16),
			sink,
		},
		null,
		2,
	),
);
