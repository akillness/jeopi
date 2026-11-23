import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "arktype";
import { AuthStorage, type TSchema } from "jeopi-ai";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import type { CustomTool } from "jeopi-cli/extensibility/custom-tools/types";
import { type MCPLoadResult, MCPManager, type MCPToolDetails } from "jeopi-cli/mcp";
import { createAgentSession } from "jeopi-cli/sdk";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { getAgentDir, removeSyncWithRetries, Snowflake, setAgentDir } from "jeopi-utils";
import { MANY_TOOL_COUNT, manyToolName } from "./fixtures/many-tools-mcp";

// Contracts for deferred (hasUI) MCP discovery follow-ups:
//
// 1. `tools.discoveryMode: "auto"` is resolved at session build time against a
//    registry that cannot yet contain the deferred MCP tools. When the
//    background connect reports a toolset large enough to cross the auto
//    threshold, the session MUST upgrade to discovery mode — register and
//    activate `search_tool_bm25`, mark discovery enabled, and expose the MCP
//    tools as discoverable — instead of force-activating all of them.
//
// 2. A session disposed while servers are still connecting MUST NOT be touched
//    by the late discovery result: no tools resurrected onto the disposed
//    session and the manager's transports disconnected.
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const SMALL_FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");

describe("createAgentSession deferred MCP auto discovery", () => {
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
		registryDir = path.join(os.tmpdir(), `pi-sdk-mcp-auto-registry-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		isolatedHome = path.join(os.tmpdir(), `pi-sdk-mcp-auto-home-${Snowflake.next()}`);
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
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-auto-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		setAgentDir(tempDir);
		spyOn(os, "homedir").mockReturnValue(isolatedHome);
	});

	afterEach(() => {
		setAgentDir(originalAgentDir);
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		mock.restore();
	});

	const writeMcpConfig = (extraArgs: string[] = []) => {
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					many: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH, ...extraArgs] },
				},
			}),
		);
	};

	const baseOptions = () => ({
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

	it("flips auto discovery on when the deferred MCP toolset crosses the threshold", async () => {
		writeMcpConfig();
		// A small explicit toolset keeps the pre-discovery registry far below the
		// 40-tool auto threshold; the fixture's 45 tools must push it across.
		const { session } = await createAgentSession({ ...baseOptions(), toolNames: ["read", "edit", "bash"] });
		try {
			// Genuine integration wait: discovery spawns the fixture as a real
			// subprocess and connects asynchronously, and the SDK fires that work
			// fire-and-forget with no completion promise or event exposed — fake
			// timers cannot drive a child process, so poll the live session with
			// a generous ceiling, exiting the instant discovery flips on.
			const deadline = Date.now() + 30_000;
			while (!session.isMCPDiscoveryEnabled() && Date.now() < deadline) {
				await Bun.sleep(50);
			}

			expect(session.isMCPDiscoveryEnabled()).toBe(true);
			const activeNames = session.getActiveToolNames();
			expect(activeNames).toContain("search_tool_bm25");
			// Discovery mode means the MCP tools are searchable, NOT force-activated.
			expect(activeNames.filter(name => name.startsWith("mcp__"))).toEqual([]);
			const discoverable = session.getDiscoverableTools({ source: "mcp" });
			expect(discoverable.length).toBe(MANY_TOOL_COUNT);
		} finally {
			await session.dispose();
		}
	}, 40_000);

	it("does not force-activate or persist incremental onToolsChanged tools while deferred discoverAndConnect is in flight", async () => {
		const makeMcpCustomTool = (serverName: string, mcpToolName: string): CustomTool<TSchema, MCPToolDetails> =>
			({
				name: `mcp__${serverName}_${mcpToolName}`,
				label: `${serverName}/${mcpToolName}`,
				description: `Stub tool ${serverName}/${mcpToolName}`,
				parameters: type({}),
				mcpServerName: serverName,
				mcpToolName,
				async execute() {
					return { content: [{ type: "text", text: "ok" }] };
				},
			}) as unknown as CustomTool<TSchema, MCPToolDetails>;

		let onToolsChangedHandler: ((tools: CustomTool<TSchema, MCPToolDetails>[]) => void) | undefined;
		const origSetOnToolsChanged = MCPManager.prototype.setOnToolsChanged;
		spyOn(MCPManager.prototype, "setOnToolsChanged").mockImplementation(function (
			this: MCPManager,
			handler: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void,
		) {
			onToolsChangedHandler = handler;
			return origSetOnToolsChanged.call(this, handler);
		});

		const discoverStarted = Promise.withResolvers<void>();
		const discoverDeferred = Promise.withResolvers<MCPLoadResult>();
		spyOn(MCPManager.prototype, "discoverAndConnect").mockImplementation(() => {
			discoverStarted.resolve();
			return discoverDeferred.promise;
		});

		const sessionManager = SessionManager.inMemory();
		const { session } = await createAgentSession({
			...baseOptions(),
			sessionManager,
			settings: Settings.isolated({ "tools.discoveryMode": "auto" }),
		});
		try {
			await discoverStarted.promise;
			expect(onToolsChangedHandler).toBeDefined();
			expect(session.isMCPDiscoveryEnabled()).toBe(false);

			// Observe each `refreshMCPTools` completion deterministically without timers.
			const origRefresh = session.refreshMCPTools.bind(session);
			const firstRefreshDone = Promise.withResolvers<void>();
			const secondRefreshDone = Promise.withResolvers<void>();
			let refreshCalls = 0;
			spyOn(session, "refreshMCPTools").mockImplementation(async (tools, opts) => {
				await origRefresh(tools, opts);
				refreshCalls += 1;
				if (refreshCalls === 1) firstRefreshDone.resolve();
				if (refreshCalls === 2) secondRefreshDone.resolve();
			});

			// Fire incremental `onToolsChanged` for a small fast server while `discoverAndConnect` is still pending.
			const fastTool = makeMcpCustomTool("fast", "ping");
			onToolsChangedHandler!([fastTool]);
			await firstRefreshDone.promise;

			// Must NOT force-activate or persist the incremental tool while discovery is still in flight.
			expect(session.isMCPDiscoveryEnabled()).toBe(false);
			expect(session.getToolByName("mcp__fast_ping")).toBeDefined();
			expect(session.getActiveToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
			expect(sessionManager.getEntries().filter(entry => entry.type === "mcp_tool_selection")).toEqual([]);

			// Now finish `discoverAndConnect` with enough tools to cross TOOL_DISCOVERY_AUTO_THRESHOLD (40).
			const allTools = [
				fastTool,
				...Array.from({ length: MANY_TOOL_COUNT }, (_, i) => makeMcpCustomTool("many", manyToolName(i))),
			];
			discoverDeferred.resolve({
				tools: allTools,
				errors: new Map(),
				connectedServers: ["fast", "many"],
				exaApiKeys: [],
			});
			await secondRefreshDone.promise;

			expect(session.isMCPDiscoveryEnabled()).toBe(true);
			const activeNames = session.getActiveToolNames();
			expect(activeNames).toContain("search_tool_bm25");
			expect(activeNames.filter(name => name.startsWith("mcp__"))).toEqual([]);
			expect(session.getDiscoverableTools({ source: "mcp" })).toHaveLength(MANY_TOOL_COUNT + 1);
			expect(sessionManager.getEntries().filter(entry => entry.type === "mcp_tool_selection")).toEqual([]);
		} finally {
			await session.dispose();
		}
	});

	it("drops an early-connected server's tools when a slower server later pushes total tools past the auto threshold", async () => {
		// Real two-server integration test: `fast` connects before STARTUP_TIMEOUT_MS
		// while `many` (45 tools) finishes later via background `onToolsChanged`.
		// Once `many` pushes the total past 40, discovery must upgrade, `fast`'s tool
		// must NOT stick around as active, and no `mcp_tool_selection` may be persisted.
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					fast: { type: "stdio", command: process.execPath, args: [SMALL_FIXTURE_PATH] },
					many: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH, "--delay", "450"] },
				},
			}),
		);
		const sessionManager = SessionManager.inMemory();
		const { session } = await createAgentSession({
			...baseOptions(),
			sessionManager,
			settings: Settings.isolated({ "tools.discoveryMode": "auto" }),
		});
		try {
			// Genuine integration wait: real stdio subprocesses connect fire-and-forget
			// with no awaitable completion promise exposed on the SDK result.
			const deadline = Date.now() + 30_000;
			while (
				(!session.isMCPDiscoveryEnabled() ||
					session.getDiscoverableTools({ source: "mcp" }).length < MANY_TOOL_COUNT + 1) &&
				Date.now() < deadline
			) {
				await Bun.sleep(50);
			}

			expect(session.isMCPDiscoveryEnabled()).toBe(true);
			const activeNames = session.getActiveToolNames();
			expect(activeNames).toContain("search_tool_bm25");
			expect(activeNames.filter(name => name.startsWith("mcp__"))).toEqual([]);
			expect(session.getDiscoverableTools({ source: "mcp" })).toHaveLength(MANY_TOOL_COUNT + 1);
			expect(sessionManager.getEntries().filter(entry => entry.type === "mcp_tool_selection")).toEqual([]);
		} finally {
			await session.dispose();
		}
	}, 40_000);

	it("disposing mid-connect disconnects the manager and never resurrects tools", async () => {
		// Stall `initialize` in the real fixture subprocess so the connect is
		// guaranteed to still be in flight when dispose() runs. Deterministic
		// time control cannot order a race against a child process.
		writeMcpConfig(["--delay", "750"]);
		const { session, mcpManager } = await createAgentSession({
			...baseOptions(),
			toolNames: ["read", "edit", "bash"],
		});
		expect(mcpManager).toBeDefined();
		if (!mcpManager) throw new Error("expected deferred session to own an MCPManager");
		const disconnectSpy = spyOn(mcpManager, "disconnectAll");

		await session.dispose();
		expect(session.isDisposed).toBe(true);

		// Genuine integration wait (see above): the deferred task notices the
		// disposed session once the stalled connect resolves and must disconnect
		// instead of refreshing tools. Exits the instant the spy fires.
		const deadline = Date.now() + 30_000;
		while (disconnectSpy.mock.calls.length === 0 && Date.now() < deadline) {
			await Bun.sleep(50);
		}
		expect(disconnectSpy).toHaveBeenCalled();
		expect(session.getActiveToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
		expect(session.getActiveToolNames()).not.toContain("search_tool_bm25");
		expect(session.isMCPDiscoveryEnabled()).toBe(false);
	}, 40_000);

	it("disconnects the owned MCP manager when a top-level session disposes", async () => {
		writeMcpConfig();
		const { session, mcpManager } = await createAgentSession({
			...baseOptions(),
			toolNames: ["read", "edit", "bash"],
		});
		expect(mcpManager).toBeDefined();
		if (!mcpManager) throw new Error("expected owning session to create an MCPManager");
		try {
			// Let the deferred connect FINISH first, so a later disconnectAll can
			// only originate from dispose() itself — not the mid-connect disposal
			// path (covered by the test above). Genuine integration wait: discovery
			// connects a real subprocess fire-and-forget with no awaitable signal,
			// and fake timers cannot drive a child process; poll the live session
			// with a generous ceiling, exiting the instant discovery flips on.
			const deadline = Date.now() + 30_000;
			while (!session.isMCPDiscoveryEnabled() && Date.now() < deadline) {
				await Bun.sleep(50);
			}
			expect(session.isMCPDiscoveryEnabled()).toBe(true);
			expect(mcpManager.getConnectedServers()).toContain("many");

			const disconnectSpy = spyOn(mcpManager, "disconnectAll");
			await session.dispose();
			expect(disconnectSpy).toHaveBeenCalled();
		} finally {
			// dispose() already tore it down; this is idempotent belt-and-braces.
			await mcpManager.disconnectAll();
		}
	}, 40_000);

	it("does not disconnect a reused parent MCP manager when a child session disposes", async () => {
		writeMcpConfig();
		const parent = await createAgentSession({
			...baseOptions(),
			toolNames: ["read", "edit", "bash"],
		});
		expect(parent.mcpManager).toBeDefined();
		if (!parent.mcpManager) throw new Error("expected parent session to create an MCPManager");
		const parentManager = parent.mcpManager;
		try {
			// A subagent-style session reuses the parent's manager via
			// `mcpManager` and therefore does NOT own it.
			const child = await createAgentSession({
				...baseOptions(),
				hasUI: false,
				toolNames: ["read"],
				mcpManager: parentManager,
			});
			const disconnectSpy = spyOn(parentManager, "disconnectAll");
			await child.session.dispose();
			expect(disconnectSpy).not.toHaveBeenCalled();
		} finally {
			await parent.session.dispose();
			await parentManager.disconnectAll();
		}
	}, 40_000);
});
