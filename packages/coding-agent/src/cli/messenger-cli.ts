import { loadMessengerConfig, validateMessengerEnvironment } from "../messenger/config";
import { createDiscordAdapter } from "../messenger/discord";
import { createMessengerGateway } from "../messenger/gateway";
import { createMessengerSessionPool, type MessengerSessionPool } from "../messenger/session-pool";
import { createSlackAdapter } from "../messenger/slack";
import { createTelegramAdapter } from "../messenger/telegram";
import type { MessengerAdapter, MessengerConfig } from "../messenger/types";

export const MESSENGER_ACTIONS = ["check", "run"] as const;
export type MessengerAction = (typeof MESSENGER_ACTIONS)[number];
export interface MessengerCommandArgs {
	action: MessengerAction;
	flags: { config: string };
}

/** Conversations answered at once; each conversation runs in its own session process. */
const MESSENGER_CONCURRENCY = 4;

/**
 * Check is deliberately local-only: it never starts a transport. The gateway process itself never loads the
 * SDK; every conversation's AgentSession lives in its own session process.
 */
export async function runMessengerCommand(cmd: MessengerCommandArgs): Promise<void> {
	if (!MESSENGER_ACTIONS.includes(cmd.action)) throw new Error("Unknown messenger action");
	if (!cmd.flags.config) throw new Error("Messenger requires --config <file>");
	// Do not echo parse errors, paths, configuration values, or environment secrets.
	let config: MessengerConfig;
	try {
		config = await loadMessengerConfig(cmd.flags.config);
		validateMessengerEnvironment(config);
	} catch {
		throw new Error("Messenger configuration or required environment is invalid");
	}
	const platforms = Object.keys(config.platforms);
	if (cmd.action === "check") {
		process.stdout.write(
			`Messenger configuration valid: ${platforms.join(", ")}; ${config.toolNames.length} tools enabled. No network checks performed.\n`,
		);
		return;
	}
	if (config.toolNames.length > 0) {
		process.stderr.write(
			"Warning: enabled messenger tools grant authorized remote users local machine authority; this is not a sandbox.\n",
		);
	}

	const controller = new AbortController();
	const stop = (): void => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	let pool: MessengerSessionPool | undefined;
	let failure: Error | undefined;
	try {
		pool = createMessengerSessionPool(config);
		const adapters: MessengerAdapter[] = [];
		if (config.platforms.telegram) adapters.push(createTelegramAdapter(config.platforms.telegram));
		if (config.platforms.discord) adapters.push(createDiscordAdapter(config.platforms.discord));
		if (config.platforms.slack) adapters.push(createSlackAdapter(config.platforms.slack));
		const gateway = createMessengerGateway(config, adapters, pool.reply, { concurrency: MESSENGER_CONCURRENCY });
		process.stdout.write(`Starting messenger: ${platforms.join(", ")}. Press Ctrl+C to stop.\n`);
		await gateway.run(controller.signal);
	} catch {
		failure = new Error("Messenger gateway failed; check local configuration and provider access");
	} finally {
		controller.abort();
		try {
			await pool?.close();
		} catch {
			failure ??= new Error("Messenger session shutdown failed");
		} finally {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		}
	}
	if (failure) throw failure;
}
