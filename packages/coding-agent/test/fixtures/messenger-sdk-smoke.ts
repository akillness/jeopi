import { spyOn } from "bun:test";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMockModel, registerMockApi } from "jeopi-ai/providers/mock";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { createMessengerSessionBridge } from "../../src/messenger/session";
import type { MessengerMessage } from "../../src/messenger/types";

// Executed only in a child with a temporary HOME and no inherited provider credentials.
const root = process.argv[2];
if (!root || process.env.HOME !== root) throw new Error("Smoke fixture requires an isolated HOME");
const cwd = join(root, "workspace");
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
await mkdir(join(cwd, ".jeopi", "prompts"), { recursive: true });
await mkdir(join(cwd, ".jeopi", "skills", "ambient"), { recursive: true });
await mkdir(agentDir, { recursive: true });
const marker = "AMBIENT_DISCOVERY_MUST_NOT_REACH_MODEL";
await writeFile(join(cwd, ".jeopi", "prompts", "danger.md"), marker);
await writeFile(
	join(cwd, ".jeopi", "skills", "ambient", "SKILL.md"),
	`---\nname: ambient\ndescription: ${marker}\n---\n${marker}\n`,
);
const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Real SDK smoke attempted network"));
const authStorage = await AuthStorage.create(":memory:");
authStorage.setRuntimeApiKey("mock", "fixture-only-key");
const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
registerMockApi("messenger-sdk-smoke");
const requests: Array<{ tools: string[]; users: string[]; ambient: boolean }> = [];
const model = createMockModel({
	handler(context) {
		const users = context.messages
			.filter(message => message.role === "user")
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(block => block.type === "text")
							.map(block => block.text)
							.join(""),
			);
		requests.push({
			tools: context.tools?.map(tool => tool.name) ?? [],
			users,
			ambient: JSON.stringify(context).includes(marker),
		});
		return { content: [JSON.stringify(users)] };
	},
});
const bridge = createMessengerSessionBridge(
	{
		cwd,
		sessionDir,
		toolNames: [],
		platforms: { telegram: { tokenEnv: "UNUSED", allowedUserIds: ["alice", "bob"] } },
	},
	{ agentDir, authStorage, modelRegistry, model },
);
function message(text: string, senderId = "alice"): MessengerMessage {
	return {
		platform: "telegram",
		accountId: "bot",
		channelId: "room",
		senderId,
		messageId: text,
		text,
		direct: true,
		mentioned: false,
	};
}
try {
	const signal = new AbortController().signal;
	const replies = [
		await bridge.reply(message("/danger"), signal),
		await bridge.reply(message("bob isolated", "bob"), signal),
		await bridge.reply(message("alice continues"), signal),
	];
	await bridge.close();
	const journals = (await readdir(sessionDir)).filter(name => name.endsWith(".jsonl"));
	await writeFile(
		join(root, "result.json"),
		JSON.stringify({
			replies,
			requests,
			networkCalls: network.mock.calls.length,
			directoryMode: (await stat(sessionDir)).mode & 0o777,
			journalModes: await Promise.all(journals.map(async name => (await stat(join(sessionDir, name))).mode & 0o777)),
		}),
	);
} finally {
	await bridge.close();
	authStorage.close();
	network.mockRestore();
}
