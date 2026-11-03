import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "jeopi-ai/providers/mock";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import * as sdk from "jeopi-cli/sdk";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { createMessengerSessionBridge } from "../../src/messenger/session";
import type { MessengerMessage } from "../../src/messenger/types";

const root = process.argv[2];
if (!root || process.env.HOME !== root) throw new Error("Fixture requires an isolated HOME");
const cwd = path.join(root, "workspace");
const agentDir = path.join(root, "agent");
const sessionDir = path.join(root, "sessions");
await fs.mkdir(path.join(cwd, ".jeopi"), { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
const authStorage = await AuthStorage.create(":memory:");
authStorage.setRuntimeApiKey("mock", "fixture-only-key");
const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
registerMockApi("messenger-model-role-test");
const models = ["first", "second"].map(id => createMockModel({ id, handler: () => ({ content: [id] }) }));
const getAvailable = spyOn(registry, "getAvailable").mockReturnValue(models);
const getAll = spyOn(registry, "getAll").mockReturnValue(models);
const find = spyOn(registry, "find").mockImplementation((provider, id) =>
	models.find(model => model.provider === provider && model.id === id),
);
const realCreate = sdk.createAgentSession;
const creation = spyOn(sdk, "createAgentSession").mockImplementation(options =>
	realCreate({ ...options, agentDir, authStorage, modelRegistry: registry }),
);
const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
const config = {
	cwd,
	sessionDir,
	toolNames: [],
	platforms: { discord: { tokenEnv: "UNUSED", allowedUserIds: ["alice", "bob"] } },
};
function message(text: string, senderId: string): MessengerMessage {
	return {
		platform: "discord",
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
	const id = process.argv[3];
	const sender = process.argv[4];
	if (!id || !sender) throw new Error("Fixture requires a model and sender");
	await Bun.write(
		path.join(cwd, ".jeopi", "settings.json"),
		JSON.stringify({ modelRoles: { default: `mock/${id}` } }),
	);
	const bridge = createMessengerSessionBridge(config);
	try {
		const signal = new AbortController().signal;
		const responses = [await bridge.reply(message(`message-${sender}`, sender), signal)];
		await Bun.write(
			path.join(root, "model-result.json"),
			JSON.stringify({ responses, networkCalls: network.mock.calls.length }),
		);
	} finally {
		await bridge.close();
	}
} finally {
	network.mockRestore();
	creation.mockRestore();
	find.mockRestore();
	getAll.mockRestore();
	getAvailable.mockRestore();
	authStorage.close();
}
