import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "jeopi-ai/dialect";
import { convertAnthropicMessages, streamAnthropic } from "jeopi-ai/providers/anthropic";
import type { AssistantMessage, Message, Model, ModelSpec, ToolResultMessage, UserMessage } from "jeopi-ai/types";
import { buildModel } from "jeopi-catalog/build";

/**
 * Regression: Anthropic-compatible reasoning endpoints often emit `thinking`
 * blocks without a first-party Anthropic signature, but still expect those
 * blocks back as native `type: "thinking"` on continuation. Demoting unsigned
 * thinking to text strips the reasoning chain and can destabilize follow-up
 * tool-call argument serialization (the upstream cause behind #2005's `todo`
 * renderer crash).
 *
 * Official Anthropic omits unsigned private reasoning instead of replaying it
 * as plaintext, while keeping native signed blocks and public tool history.
 */
function makeModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "custom-anthropic",
		id: "reasoning-model",
		name: "Reasoning Anthropic-Compatible Model",
		baseUrl: "https://llm.example.com/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

function makeUser(text = "continue"): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeAssistantThinking(thinking: string, tail: AssistantMessage["content"][number][] = []): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking, thinkingSignature: "" }, ...tail],
		api: "anthropic-messages",
		provider: "custom-anthropic",
		model: "reasoning-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

interface WireThinkingBlock {
	type: "thinking";
	thinking: string;
	signature: string;
}
interface WireTextBlock {
	type: "text";
	text: string;
}
interface WireToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}
type WireBlock = WireThinkingBlock | WireTextBlock | WireToolUseBlock | { type: string; [key: string]: unknown };

function assistantWireBlocks(messages: Message[], model: Model<"anthropic-messages">): WireBlock[] {
	const params = convertAnthropicMessages(messages, model, false);
	const assistant = params.find(p => p.role === "assistant");
	return (assistant?.content as WireBlock[] | undefined) ?? [];
}

describe("Anthropic-compatible unsigned thinking replay (#2005)", () => {
	it("preserves unsigned thinking for non-official reasoning endpoints", () => {
		const blocks = assistantWireBlocks(
			[
				makeUser("solve x"),
				makeAssistantThinking("plan: read the file, then edit", [{ type: "text", text: "Sure." }]),
			],
			makeModel(),
		);
		expect(blocks[0]).toEqual({
			type: "thinking",
			thinking: "plan: read the file, then edit",
			signature: "",
		});
		expect(blocks[1]).toEqual({ type: "text", text: "Sure." });
	});

	it("sends context_management for API-key Anthropic-compatible thinking requests", async () => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamAnthropic(
			makeModel(),
			{ systemPrompt: [], messages: [makeUser("continue")] },
			{
				apiKey: "sk-ant-api-test",
				signal: AbortSignal.abort(),
				thinkingEnabled: true,
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as {
			thinking?: { type?: string };
			context_management?: { edits?: Array<{ type?: string; keep?: string }> };
		};
		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.context_management).toEqual({
			edits: [{ type: "clear_thinking_20251015", keep: "all" }],
		});
	});

	it("sanitizes lone surrogates in tool arguments regardless of origin API", () => {
		const loneSurrogate = "broken \ud83d end";
		const makeToolCallAssistant = (api: AssistantMessage["api"]): AssistantMessage => ({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "write",
					arguments: { text: loneSurrogate, nested: { parts: [loneSurrogate] } },
				},
			],
			api,
			provider: api === "anthropic-messages" ? "custom-anthropic" : "openai",
			model: "reasoning-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		});

		// Cross-API replay: Anthropic's strict UTF-8 validation rejects lone
		// surrogates, so string leaves are deep-sanitized.
		const crossBlocks = assistantWireBlocks([makeUser(), makeToolCallAssistant("openai-responses")], makeModel());
		const crossToolUse = crossBlocks.find(block => block.type === "tool_use") as WireToolUseBlock;
		expect(crossToolUse.input.text).toBe("broken \ufffd end");
		expect((crossToolUse.input.nested as { parts: string[] }).parts[0]).toBe("broken \ufffd end");

		// Same-API replay sanitizes too: the model itself can emit lone-surrogate
		// escapes in its own tool-argument JSON (streamed out fine, 400 on replay).
		const sameBlocks = assistantWireBlocks([makeUser(), makeToolCallAssistant("anthropic-messages")], makeModel());
		const sameToolUse = sameBlocks.find(block => block.type === "tool_use") as WireToolUseBlock;
		expect(sameToolUse.input.text).toBe("broken \ufffd end");
		expect((sameToolUse.input.nested as { parts: string[] }).parts[0]).toBe("broken \ufffd end");
	});

	it("sanitizes payload replacements before SDK JSON serialization", async () => {
		const splitSurrogate = `render \`"icon.ghost": "\\ud83d${String.fromCharCode(0xdc7b)}"\``;
		const { promise: bodyPromise, resolve } = Promise.withResolvers<string>();
		const controller = new AbortController();
		const fakeFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const raw = init?.body;
			resolve(typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array));
			controller.abort();
			return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		streamAnthropic(
			makeModel(),
			{ systemPrompt: [], messages: [makeUser("continue")] },
			{
				apiKey: "sk-ant-test",
				signal: controller.signal,
				fetch: fakeFetch,
				onPayload: payload => {
					const request = payload as { messages?: Array<{ role: string; content: unknown }> };
					if (!Array.isArray(request.messages)) throw new Error("Anthropic payload missing messages");
					request.messages.push({
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "toolu_surrogate",
								name: "write",
								input: { text: splitSurrogate },
							},
						],
					});
					return request;
				},
			},
		);

		const body = await bodyPromise;
		expect(body).not.toContain("\\udc7b");
		expect(body).toContain("\ufffd");
	});

	it("covers the Xiaomi MiMo Anthropic-compatible reporter configuration without provider allowlists", () => {
		const model = makeModel({
			provider: "user-custom",
			id: "mimo-v2.5-pro",
			name: "MiMo V2.5 Pro (Singapore)",
			baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
			maxTokens: 131_072,
			contextWindow: 1_048_576,
		});
		const blocks = assistantWireBlocks([makeUser(), makeAssistantThinking("hidden reasoning")], model);
		expect(blocks[0]).toEqual({ type: "thinking", thinking: "hidden reasoning", signature: "" });
	});

	it("preserves legacy known non-signing endpoints even if model.reasoning is false", () => {
		const model = makeModel({ provider: "custom", baseUrl: "https://api.deepseek.com/v1", reasoning: false });
		const blocks = assistantWireBlocks([makeUser(), makeAssistantThinking("deepseek reasoning")], model);
		expect(blocks[0]?.type).toBe("thinking");
	});

	it.each(
		["claude-opus-5-5", "claude-sonnet-5-5"].flatMap(modelId =>
			["same-model unsigned", "cross-model signed", "openai-responses", "openai-completions"].map(origin => ({
				modelId,
				origin,
			})),
		),
	)(
		"excludes private reasoning but preserves visible text and tool pairs: $modelId / $origin",
		({ modelId, origin }) => {
			const model = makeModel({ id: modelId, provider: "anthropic", baseUrl: "https://api.anthropic.com" });
			const assistant = makeAssistantThinking("PRIVATE_REASONING_MUST_NOT_BE_PLAINTEXT", [
				{ type: "text", text: "I inspected the license." },
				{ type: "toolCall", id: "toolu_read_license", name: "read", arguments: { path: "LICENSE" } },
			]);
			assistant.provider = origin.startsWith("openai") ? "openai" : model.provider;
			assistant.api = origin.startsWith("openai") ? origin : "anthropic-messages";
			assistant.model = origin === "same-model unsigned" ? modelId : "previous-model";
			if (origin === "cross-model signed") {
				assistant.content[0] = {
					type: "thinking",
					thinking: "PRIVATE_REASONING_MUST_NOT_BE_PLAINTEXT",
					thinkingSignature: "foreign-model-signature",
				};
			}
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "toolu_read_license",
				toolName: "read",
				content: [{ type: "text", text: "License allows the requested edit." }],
				isError: false,
				timestamp: 1,
			};
			const current = {
				...makeAssistantThinking("unused"),
				provider: model.provider,
				model: modelId,
				content: [{ type: "text" as const, text: "The tool result is ready." }],
			};
			const messages: Message[] = [
				makeUser("Read the license."),
				assistant,
				result,
				current,
				makeUser("Continue the coding task."),
			];
			const before = structuredClone(messages);
			const params = convertAnthropicMessages(messages, model, false);
			expect(params.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
			expect(params[1]!.content).toEqual([
				{ type: "text", text: "I inspected the license." },
				{ type: "tool_use", id: "toolu_read_license", name: "read", input: { path: "LICENSE" } },
			]);
			expect(params[2]!.content).toContainEqual(
				expect.objectContaining({
					type: "tool_result",
					tool_use_id: "toolu_read_license",
					content: "License allows the requested edit.",
				}),
			);
			expect(messages).toEqual(before);
		},
	);

	it.each(["claude-opus-5-5", "claude-sonnet-5-5"])(
		"omits unsigned-thinking-only assistant envelopes on official %s",
		modelId => {
			const model = makeModel({ id: modelId, provider: "anthropic", baseUrl: "https://api.anthropic.com" });
			const user = makeUser("Continue the coding task.");
			const thinkingOnly = {
				...makeAssistantThinking("PRIVATE_ONLY_REASONING"),
				provider: model.provider,
				model: modelId,
			};
			expect(convertAnthropicMessages([user, thinkingOnly], model, false)).toEqual([
				{ role: "user", content: "Continue the coding task." },
			]);
		},
	);

	it.each(["claude-opus-5-5", "claude-sonnet-5-5"])(
		"preserves same-model signed and opaque redacted thinking on official %s",
		modelId => {
			const model = makeModel({ id: modelId, provider: "anthropic", baseUrl: "https://api.anthropic.com" });
			const assistant = { ...makeAssistantThinking("unused"), provider: model.provider, model: modelId };
			assistant.content = [
				{ type: "thinking", thinking: "Signed native reasoning.", thinkingSignature: "native-signature" },
				{ type: "redactedThinking", data: "opaque-native-blob" },
				{ type: "text", text: "Visible answer." },
			];
			expect(assistantWireBlocks([makeUser(), assistant], model)).toEqual([
				{ type: "thinking", thinking: "Signed native reasoning.", signature: "native-signature" },
				{ type: "redacted_thinking", data: "opaque-native-blob" },
				{ type: "text", text: "Visible answer." },
			]);
		},
	);

	it("still degrades unsigned thinking to text for non-reasoning unknown endpoints", () => {
		const model = makeModel({ reasoning: false, baseUrl: "https://plain.example.com/anthropic" });
		const blocks = assistantWireBlocks([makeUser(), makeAssistantThinking("scratch")], model);
		expect(blocks[0]?.type).toBe("text");
		expect((blocks[0] as WireTextBlock).text).toBe(renderDemotedThinking(model.id, "scratch"));
	});

	it("keeps thinking → tool_use pairing intact across continuation conversion", () => {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_reasoning_1",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: 0,
		};
		const model = makeModel();
		const messages: Message[] = [
			makeUser("read README"),
			makeAssistantThinking("I need to call the read tool", [
				{ type: "toolCall", id: "toolu_reasoning_1", name: "read", arguments: { path: "README.md" } },
			]),
			toolResult,
		];
		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map(p => p.role)).toEqual(["user", "assistant", "user"]);
		const assistantBlocks = params[1].content as WireBlock[];
		expect(assistantBlocks[0]?.type).toBe("thinking");
		expect(assistantBlocks[1]?.type).toBe("tool_use");
		expect((assistantBlocks[1] as WireToolUseBlock).id).toBe("toolu_reasoning_1");
	});
});
