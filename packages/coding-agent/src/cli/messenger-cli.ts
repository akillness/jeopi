import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { loadMessengerConfig, validateMessengerEnvironment } from "../messenger/config";
import { createDiscordAdapter } from "../messenger/discord";
import { type DiscordSetupIO, type DiscordSetupResult, setupDiscordMessenger } from "../messenger/discord-setup";
import { createMessengerGateway } from "../messenger/gateway";
import { createMessengerSessionPool, type MessengerSessionPool } from "../messenger/session-pool";
import { createSlackAdapter } from "../messenger/slack";
import { createTelegramAdapter } from "../messenger/telegram";
import type { MessengerAdapter, MessengerConfig } from "../messenger/types";

export const MESSENGER_ACTIONS = ["check", "run", "setup"] as const;
export type MessengerAction = (typeof MESSENGER_ACTIONS)[number];
export interface MessengerSetupFlags {
	channel?: string[];
	user?: string[];
	tools?: string;
	artifacts?: boolean;
	service?: boolean;
	"no-dm"?: boolean;
}
export interface MessengerCommandArgs {
	action: MessengerAction;
	flags: { config: string } & MessengerSetupFlags;
}

/** Conversations answered at once; each conversation runs in its own session process. */
const MESSENGER_CONCURRENCY = 4;

function terminalSetupIO(): DiscordSetupIO {
	const question = async (prompt: string, hidden: boolean): Promise<string> => {
		// Hidden input: readline still reads keys but echoes into a sink.
		const output = hidden ? new Writable({ write: (_chunk, _encoding, done) => done() }) : process.stdout;
		if (hidden) process.stdout.write(prompt);
		const rl = createInterface({ input: process.stdin, output, terminal: true });
		try {
			return await rl.question(hidden ? "" : prompt);
		} finally {
			rl.close();
			if (hidden) process.stdout.write("\n");
		}
	};
	return {
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		say: line => process.stdout.write(`${line}\n`),
		ask: prompt => question(prompt, false),
		askSecret: prompt => question(prompt, true),
	};
}

function splitList(values: string[] | undefined): string[] | undefined {
	const items = values
		?.flatMap(value => value.split(","))
		.map(value => value.trim())
		.filter(Boolean);
	return items?.length ? items : undefined;
}

async function runSetup(flags: MessengerCommandArgs["flags"]): Promise<void> {
	const io = terminalSetupIO();
	let result: DiscordSetupResult;
	try {
		result = await setupDiscordMessenger(
			{
				configPath: flags.config,
				channelIds: splitList(flags.channel),
				userIds: splitList(flags.user),
				toolNames: flags.tools === undefined ? undefined : (splitList([flags.tools]) ?? []),
				artifacts: flags.artifacts,
				service: flags.service,
				dmTest: !flags["no-dm"],
			},
			io,
		);
	} catch (error) {
		// Setup errors are written for the user and never carry the token.
		process.stderr.write(`Discord setup stopped: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
		return;
	}
	io.say("");
	io.say(`Discord messenger ready: ${result.configPath}`);
	io.say(`  allowed users: ${result.allowedUserIds.join(", ")}`);
	io.say(`  allowed channels: ${result.allowedChannelIds.join(", ")}`);
	io.say(`  invite (other servers): ${result.inviteUrl}`);
	io.say(result.service ? `  service: ${result.service}` : `  start: ${result.runScript}  (or rerun with --service)`);
	io.say("Test: DM the bot, and mention it in the request channel; it replies in a thread.");
}

/**
 * Check is deliberately local-only: it never starts a transport. The gateway process itself never loads the
 * SDK; every conversation's AgentSession lives in its own session process.
 */
export async function runMessengerCommand(cmd: MessengerCommandArgs): Promise<void> {
	if (!MESSENGER_ACTIONS.includes(cmd.action)) throw new Error("Unknown messenger action");
	if (!cmd.flags.config) throw new Error("Messenger requires --config <file>");
	if (cmd.action === "setup") {
		await runSetup(cmd.flags);
		return;
	}
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
