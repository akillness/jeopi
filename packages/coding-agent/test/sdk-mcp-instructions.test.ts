import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "jeopi-ai";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { createAgentSession } from "jeopi-cli/sdk";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { getAgentDir, removeSyncWithRetries, Snowflake, setAgentDir } from "jeopi-utils";
import { SERVER_INSTRUCTIONS } from "./fixtures/instructions-mcp";

// Contract: a deferred interactive (`hasUI`) session runs MCP discovery off the
// first-paint path, so an MCP server's `instructions` are not available when the
// prompt is first built. Once the background connection completes — and the
// resulting `refreshMCPTools` rebuilds the system prompt — that server's
// instructions MUST join the prompt for the rest of the session. Regression
// guard: a prior version gated instruction inclusion on `!deferMCPDiscoveryForUI`,
// which dropped server instructions permanently for every UI session.
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");

describe("createAgentSession MCP server instructions (deferred UI)", () => {
	let registryDir: string;
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let originalAgentDir: string;
	// Discovery resolves user-level MCP config from `os.homedir()`; redirect it
	// to an empty dir so the test connects ONLY to the fixture server and never
	// spawns the developer's real MCP servers.
	let isolatedHome: string;

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-mcp-instr-registry-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		isolatedHome = path.join(os.tmpdir(), `pi-sdk-mcp-instr-home-${Snowflake.next()}`);
		fs.mkdirSync(isolatedHome, { recursive: true });
		originalAgentDir = getAgentDir();
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		for (const dir of [registryDir, isolatedHome]) {
			if (dir && fs.existsSync(dir)) {
				removeSyncWithRetries(dir);
			}
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-instr-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		setAgentDir(tempDir);
		spyOn(os, "homedir").mockReturnValue(isolatedHome);
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					instr: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] },
				},
			}),
		);
	});

	afterEach(() => {
		setAgentDir(originalAgentDir);
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		mock.restore();
	});

	it("folds server instructions into the prompt once deferred discovery connects", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
		});
		try {
			// First paint: discovery is still in flight, so the server's
			// instructions are not yet present.
			expect(session.systemPrompt.join("\n")).not.toContain(SERVER_INSTRUCTIONS);

			// Background connect + `refreshMCPTools` rebuild must surface the
			// instructions. This is a genuine integration wait: discovery spawns
			// the fixture as a real subprocess and connects asynchronously, and
			// the SDK fires that work fire-and-forget with no completion promise
			// or event exposed to await — so fake timers cannot drive it and we
			// poll the live prompt with a generous ceiling, exiting the instant
			// the rebuilt prompt carries the instructions.
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(50);
				prompt = session.systemPrompt.join("\n");
			}

			expect(prompt).toContain(SERVER_INSTRUCTIONS);
			// The instructions are framed under the MCP section, not pasted raw.
			expect(prompt).toContain("MCP Server Instructions");
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("omits deferred server instructions when mcpDiscoveryEnabled is true until a server tool is activated", async () => {
		const { session, mcpManager } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: false,
		});
		expect(mcpManager).toBeDefined();
		try {
			// Genuine integration wait: real stdio subprocess connect may outlive
			// STARTUP_TIMEOUT_MS (250 ms) and finish via background refresh.
			const deadline = Date.now() + 12_000;
			while (
				(!mcpManager!.getServerInstructions().has("instr") ||
					!session.getDiscoverableTools({ source: "mcp" }).some(tool => tool.name === "mcp__instr_do_thing")) &&
				Date.now() < deadline
			) {
				await Bun.sleep(50);
			}

			expect(session.isMCPDiscoveryEnabled()).toBe(true);
			// Confirm instructions are loaded on the manager so omission is non-vacuous.
			expect(mcpManager!.getServerInstructions().get("instr")).toBe(SERVER_INSTRUCTIONS);
			const initialPrompt = session.systemPrompt.join("\n");
			expect(initialPrompt).not.toContain("## MCP Server Instructions");
			expect(initialPrompt).not.toContain(SERVER_INSTRUCTIONS);

			const activated = await session.activateDiscoveredMCPTools(["mcp__instr_do_thing"]);
			expect(activated).toEqual(["mcp__instr_do_thing"]);

			const afterActivation = session.systemPrompt.join("\n");
			expect(afterActivation).toContain("## MCP Server Instructions");
			expect(afterActivation).toContain("### instr");
			expect(afterActivation).toContain(SERVER_INSTRUCTIONS);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("includes only discoveryDefaultServers instructions initially and adds other servers when activated", async () => {
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					alpha: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] },
					beta: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] },
				},
			}),
		);
		const { session, mcpManager } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDefaultServers": ["alpha"],
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: false,
		});
		expect(mcpManager).toBeDefined();
		try {
			// Genuine integration wait: wait until both real stdio subprocesses
			// have finished connecting and registered their tools & instructions.
			const deadline = Date.now() + 12_000;
			while (
				(!mcpManager!.getServerInstructions().has("alpha") ||
					!mcpManager!.getServerInstructions().has("beta") ||
					!session.getDiscoverableTools({ source: "mcp" }).some(tool => tool.name === "mcp__beta_do_thing") ||
					!session.systemPrompt.join("\n").includes("### alpha")) &&
				Date.now() < deadline
			) {
				await Bun.sleep(50);
			}

			expect(session.isMCPDiscoveryEnabled()).toBe(true);
			expect(mcpManager!.getServerInstructions().get("alpha")).toBe(SERVER_INSTRUCTIONS);
			expect(mcpManager!.getServerInstructions().get("beta")).toBe(SERVER_INSTRUCTIONS);
			const initialPrompt = session.systemPrompt.join("\n");
			expect(initialPrompt).toContain("## MCP Server Instructions");
			expect(initialPrompt).toContain("### alpha");
			expect(initialPrompt).not.toContain("### beta");

			const activated = await session.activateDiscoveredMCPTools(["mcp__beta_do_thing"]);
			expect(activated).toEqual(["mcp__beta_do_thing"]);

			const afterBetaActivation = session.systemPrompt.join("\n");
			expect(afterBetaActivation).toContain("### alpha");
			expect(afterBetaActivation).toContain("### beta");
		} finally {
			await session.dispose();
		}
	}, 20_000);
});
