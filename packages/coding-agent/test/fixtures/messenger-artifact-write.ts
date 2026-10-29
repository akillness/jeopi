import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "jeopi-ai/providers/mock";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { createMessengerSessionBridge } from "../../src/messenger/session";

const root = process.argv[2];
const enabled = process.argv[3] === "enabled";
if (!root || process.env.HOME !== root) throw new Error("Isolated HOME required");
const cwd = path.join(root, "workspace");
const agentDir = path.join(root, "agent");
await fs.mkdir(cwd, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
const authStorage = await AuthStorage.create(":memory:");
authStorage.setRuntimeApiKey("mock", "fixture-only");
const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
registerMockApi("messenger-artifact-write");
const model = createMockModel({
	responses: [
		{
			content: [
				{
					type: "toolCall",
					name: "write",
					arguments: { path: "result.txt", content: "written by authorized agent\n" },
				},
			],
		},
		{ content: ["finished"] },
	],
});
const bridge = createMessengerSessionBridge(
	{
		cwd,
		sessionDir: path.join(root, "sessions"),
		toolNames: enabled ? ["write"] : [],
		platforms: { discord: { tokenEnv: "UNUSED", allowedUserIds: ["alice"] } },
	},
	{ agentDir, authStorage, modelRegistry, model },
);
try {
	await bridge.reply(
		{
			platform: "discord",
			accountId: "bot",
			channelId: "room",
			senderId: "alice",
			messageId: "1",
			text: "write result",
			direct: true,
			mentioned: false,
		},
		new AbortController().signal,
	);
} finally {
	await bridge.close();
	authStorage.close();
}
