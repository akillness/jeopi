import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "jeopi-ai";
import { isEnoent } from "jeopi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { initializeExtensions } from "../modes/runtime-init";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import { messengerConversationKey } from "./gateway";
import { type MessengerConfig, MessengerFatalError, type MessengerReply } from "./types";

const SUPPORTED_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	bash: true,
	edit: true,
	write: true,
};

export interface MessengerSessionBridge {
	reply: MessengerReply;
	close(): Promise<void>;
}

/** Explicit SDK resources for embedded callers; security policy remains bridge-owned. */
export interface MessengerSessionDependencies {
	agentDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model;
}

/** One Main session owns the SDK's process-global lifecycle until gateway shutdown. */
export function createMessengerSessionBridge(
	config: MessengerConfig,
	dependencies?: MessengerSessionDependencies,
): MessengerSessionBridge {
	const toolNames = [...config.toolNames];
	if (new Set(toolNames).size !== toolNames.length || toolNames.some(name => !Object.hasOwn(SUPPORTED_TOOLS, name))) {
		throw new Error("Unsupported messenger tools");
	}
	const cwd = path.resolve(config.cwd);
	const sessionDir = path.resolve(config.sessionDir);
	const settings = Settings.isolated({
		"autolearn.enabled": false,
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"memory.backend": "off",
		"advisor.enabled": false,
		"goal.enabled": false,
		"magicKeywords.enabled": false,
		"todo.enabled": false,
		"tools.discoveryMode": "off",
		"mcp.discoveryMode": false,
		"tools.approvalMode": "always-ask",
		includeWorkspaceTree: false,
	});
	let session: AgentSession | undefined;
	let initialization: Promise<void> | undefined;
	let activeRoute: string | undefined;
	let activeTurn: Promise<void> | undefined;
	let closed = false;
	let closing: Promise<void> | undefined;
	let runtimeFailed = false;

	async function constrainTools(current: AgentSession): Promise<void> {
		settings.set(
			"tools.approval",
			Object.fromEntries(current.getAllToolNames().map(name => [name, toolNames.includes(name) ? "allow" : "deny"])),
		);
		await current.setActiveToolsByName(toolNames);
		const actual = current.getActiveToolNames();
		if (actual.length !== toolNames.length || actual.some(name => !toolNames.includes(name))) {
			throw new Error("Messenger tool isolation failed");
		}
	}

	async function initialize(route: string, file: string): Promise<void> {
		const sessionManager = await SessionManager.open(file, sessionDir, undefined, {
			initialCwd: cwd,
			suppressBreadcrumb: true,
		});
		const result = await createAgentSession({
			cwd,
			agentDir: dependencies?.agentDir,
			authStorage: dependencies?.authStorage,
			modelRegistry: dependencies?.modelRegistry,
			model: dependencies?.model,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			preloadedCustomToolPaths: [],
			customTools: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames,
			hasUI: false,
			autoApprove: false,
		});
		session = result.session;
		await constrainTools(session);
		const reportFailure = (): void => {
			runtimeFailed = true;
		};
		await initializeExtensions(session, {
			reportSendError: reportFailure,
			reportRuntimeError: reportFailure,
			onShutdown: reportFailure,
		});
		await constrainTools(session);
		activeRoute = route;
	}

	const reply: MessengerReply = async (message, signal) => {
		if (closed || signal.aborted) throw new Error("Messenger session is closed");
		if (activeTurn) throw new Error("Messenger turns must be serialized");
		const finished = Promise.withResolvers<void>();
		activeTurn = finished.promise;
		let aborting: Promise<void> | undefined;
		const onAbort = (): void => {
			if (session && !aborting) {
				aborting = session.abort({ reason: USER_INTERRUPT_LABEL });
				aborting.catch(() => {
					runtimeFailed = true;
				});
			}
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
			const directory = await fs.lstat(sessionDir);
			if (!directory.isDirectory() || directory.isSymbolicLink())
				throw new Error("Invalid messenger session directory");
			await fs.chmod(sessionDir, 0o700);
			const route = new Bun.CryptoHasher("sha256")
				.update(JSON.stringify([cwd, messengerConversationKey(message)]))
				.digest("hex");
			// Deterministic filenames are the route map; missing files are created atomically by SessionManager.
			const file = path.join(sessionDir, `${route}.jsonl`);
			const stat = await fs.lstat(file).catch((error: unknown) => {
				if (isEnoent(error)) return undefined;
				throw error;
			});
			if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("Invalid messenger session file");
			if (stat) await fs.chmod(file, 0o600);
			if (closed || signal.aborted) throw new Error("Messenger request aborted");
			if (!initialization) {
				initialization = initialize(route, file).catch(() => {
					// SDK startup may already have torn down process-global lifecycle resources.
					closed = true;
					throw new MessengerFatalError();
				});
			}
			await initialization;
			const current = session;
			if (!current) throw new Error("Messenger session unavailable");
			if (closed || signal.aborted) throw new Error("Messenger request aborted");
			if (activeRoute !== route) {
				const switched = await current.switchSession(file);
				if (!switched) throw new Error("Messenger session switch cancelled");
				activeRoute = route;
			}
			await fs.chmod(file, 0o600);
			await constrainTools(current);
			if (closed || signal.aborted || runtimeFailed) throw new Error("Messenger session unavailable");
			// Slash-looking text is ordinary user data, never an extension command or developer message.
			const dispatched = await current.prompt(message.text, { expandPromptTemplates: false });
			await current.waitForIdle();
			await current.sessionManager.flush();
			if (!dispatched || closed || signal.aborted || runtimeFailed) throw new Error("Messenger request failed");
			const last = current.state.messages.at(-1);
			if (last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
				throw new Error("Messenger response unavailable");
			}
			const text = last.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			if (!text.trim()) throw new Error("Messenger response is empty");
			return text;
		} finally {
			signal.removeEventListener("abort", onAbort);
			await aborting?.catch(() => {});
			activeTurn = undefined;
			finished.resolve();
		}
	};

	function close(): Promise<void> {
		if (closing) return closing;
		closed = true;
		closing = (async () => {
			await initialization?.catch(() => {});
			const current = session;
			if (!current) return;
			try {
				await current.abort({ reason: USER_INTERRUPT_LABEL });
				await activeTurn;
				await current.sessionManager.flush();
			} finally {
				await current.dispose();
			}
		})();
		return closing;
	}

	return { reply, close };
}
