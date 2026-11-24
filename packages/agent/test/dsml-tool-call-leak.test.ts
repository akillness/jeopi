import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, Message, Model } from "jeopi-ai";
import { AssistantMessageEventStream } from "jeopi-ai/utils/event-stream";
import { buildModel } from "jeopi-catalog/build";
import { agentLoop } from "../src/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "../src/types";

const deepseekModel: Model = buildModel({
	id: "deepseek-chat",
	name: "DeepSeek Chat",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8192,
});

function makeAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: deepseekModel.api,
		provider: deepseekModel.provider,
		model: deepseekModel.id,
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function scriptedStream(responses: string[]) {
	let idx = 0;
	const seenContexts: Context[] = [];
	const fn = (_model: Model, ctx: Context) => {
		seenContexts.push(structuredClone(ctx));
		const text = responses[Math.min(idx++, responses.length - 1)]!;
		const msg = makeAssistant(text);
		const stream = new AssistantMessageEventStream();
		void (async () => {
			stream.push({ type: "start", partial: msg });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: msg });
			stream.push({ type: "done", reason: "stop", message: msg });
			stream.end();
		})();
		return stream;
	};
	return { fn, seenContexts };
}

const identityConvert = (msgs: AgentMessage[]): Message[] => msgs as Message[];

describe("malformed DSML tool-call leak guard", () => {
	it("strips leaked unfenced DSML markup and nudges the model to recover cleanly", async () => {
		const leaked =
			'Let me inspect the file.\nbash\n<｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>';
		const { fn, seenContexts } = scriptedStream([leaked, "Recovered with clean plain answer."]);
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: deepseekModel, convertToLlm: identityConvert };

		const stream = agentLoop(
			[{ role: "user", content: "check files", timestamp: Date.now() }],
			context,
			config,
			undefined,
			fn,
		);
		for await (const _ of stream) {
			// drain
		}
		const produced = await stream.result();

		expect(seenContexts).toHaveLength(2);
		const replayedAssistant = seenContexts[1]!.messages.find(m => m.role === "assistant") as AssistantMessage;
		const replayedText = replayedAssistant.content.map(c => (c.type === "text" ? c.text : "")).join("");
		expect(replayedText).not.toContain("DSML");
		expect(replayedText).toContain("Let me inspect the file.");
		const nudgeMsg = seenContexts[1]!.messages.at(-1);
		expect(nudgeMsg?.role).toBe("user");
		expect(produced.at(-1)?.role).toBe("assistant");
	});

	it("leaves fenced DSML documentation untouched without triggering a retry", async () => {
		const fenced = 'Example tag:\n```xml\n<｜DSML｜invoke name="bash"></｜DSML｜invoke>\n```';
		const { fn, seenContexts } = scriptedStream([fenced]);
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: deepseekModel, convertToLlm: identityConvert };

		const stream = agentLoop(
			[{ role: "user", content: "show example", timestamp: Date.now() }],
			context,
			config,
			undefined,
			fn,
		);
		for await (const _ of stream) {
			// drain
		}
		await stream.result();
		expect(seenContexts).toHaveLength(1);
	});

	it("bounds DSML leak recovery nudges so a persistently degraded model cannot loop forever", async () => {
		const leaked = '<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command">ls</｜DSML｜parameter>';
		const { fn, seenContexts } = scriptedStream([leaked, leaked, leaked, leaked]);
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: deepseekModel, convertToLlm: identityConvert };

		const stream = agentLoop(
			[{ role: "user", content: "run ls", timestamp: Date.now() }],
			context,
			config,
			undefined,
			fn,
		);
		for await (const _ of stream) {
			// drain
		}
		await stream.result();
		expect(seenContexts).toHaveLength(3);
	});
});
