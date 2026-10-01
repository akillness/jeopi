import { loadMessengerConfig, validateMessengerEnvironment } from "../messenger/config";
import type { MessengerSessionBridge } from "../messenger/session";
import { type MessengerAdapter, type MessengerConfig, MessengerFatalError } from "../messenger/types";

export const MESSENGER_ACTIONS = ["check", "run"] as const;
export type MessengerAction = (typeof MESSENGER_ACTIONS)[number];
export interface MessengerCommandArgs {
	action: MessengerAction;
	flags: { config: string };
}

/** Check is deliberately local-only: it never imports the SDK or starts a transport. */
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
	let bridge: MessengerSessionBridge | undefined;
	let failure: Error | undefined;
	try {
		const [{ createMessengerSessionBridge }, { createMessengerGateway }, telegram, discord, slack] =
			await Promise.all([
				import("../messenger/session"),
				import("../messenger/gateway"),
				import("../messenger/telegram"),
				import("../messenger/discord"),
				import("../messenger/slack"),
			]);
		if (controller.signal.aborted) return;
		bridge = createMessengerSessionBridge(config);
		const adapters: MessengerAdapter[] = [];
		if (config.platforms.telegram) adapters.push(telegram.createTelegramAdapter(config.platforms.telegram));
		if (config.platforms.discord) adapters.push(discord.createDiscordAdapter(config.platforms.discord));
		if (config.platforms.slack) adapters.push(slack.createSlackAdapter(config.platforms.slack));
		const gateway = createMessengerGateway(config, adapters, bridge.reply);
		process.stdout.write(`Starting messenger: ${platforms.join(", ")}. Press Ctrl+C to stop.\n`);
		await gateway.run(controller.signal);
	} catch (error) {
		failure =
			error instanceof MessengerFatalError
				? error
				: new Error("Messenger gateway failed; check local configuration and provider access");
	} finally {
		controller.abort();
		try {
			await bridge?.close();
		} catch {
			failure ??= new Error("Messenger session shutdown failed");
		} finally {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		}
	}
	if (failure) throw failure;
}
