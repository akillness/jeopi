import { APP_NAME } from "jeopi-utils";
import { Args, Command, Flags, renderCommandHelp } from "jeopi-utils/cli";
import { MESSENGER_ACTIONS, type MessengerAction, runMessengerCommand } from "../cli/messenger-cli";

export default class Messenger extends Command {
	static description = "Set up and run authorized Discord, Telegram, and Slack text bots";

	static args = {
		action: Args.string({ description: "Sub-command", required: false, options: [...MESSENGER_ACTIONS] }),
	};

	static flags = {
		config: Flags.string({ description: "Path to messenger JSON configuration" }),
		channel: Flags.string({
			description: "setup: Discord request channel or thread ID (repeatable)",
			multiple: true,
		}),
		user: Flags.string({
			description: "setup: allowed Discord user ID (default: the application owner)",
			multiple: true,
		}),
		tools: Flags.string({ description: "setup: comma-separated tools for remote chats (default: none)" }),
		artifacts: Flags.boolean({ description: "setup: enable Discord file exchange in ./artifacts" }),
		service: Flags.boolean({ description: "setup: run the gateway as a login service (launchd or systemd --user)" }),
		"no-dm": Flags.boolean({ description: "setup: skip opening and testing the owner's DM channel" }),
	};

	static examples = [
		"jeopi messenger setup --config ~/.jeopi/discord/messenger.json --service",
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
		await runMessengerCommand({
			action: args.action as MessengerAction,
			flags: {
				config: flags.config,
				channel: flags.channel,
				user: flags.user,
				tools: flags.tools,
				artifacts: flags.artifacts,
				service: flags.service,
				"no-dm": flags["no-dm"],
			},
		});
	}
}
