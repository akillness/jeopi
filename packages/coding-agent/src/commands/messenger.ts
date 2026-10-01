import { APP_NAME } from "jeopi-utils";
import { Args, Command, Flags, renderCommandHelp } from "jeopi-utils/cli";
import { MESSENGER_ACTIONS, type MessengerAction, runMessengerCommand } from "../cli/messenger-cli";

export default class Messenger extends Command {
	static description = "Run authorized Discord, Telegram, and Slack text bots";

	static args = {
		action: Args.string({ description: "Sub-command", required: false, options: [...MESSENGER_ACTIONS] }),
	};

	static flags = {
		config: Flags.string({ description: "Path to messenger JSON configuration" }),
	};

	static examples = [
		"jeopi messenger check --config ./messenger.json",
		"jeopi messenger run --config ./messenger.json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Messenger);
		if (!args.action) {
			renderCommandHelp(APP_NAME, "messenger", Messenger);
			return;
		}
		if (!flags.config) throw new Error("Messenger requires --config <file>");
		await runMessengerCommand({ action: args.action as MessengerAction, flags: { config: flags.config } });
	}
}
