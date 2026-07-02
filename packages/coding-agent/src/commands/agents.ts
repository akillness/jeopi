/**
 * Manage bundled task agents.
 */
import { APP_NAME } from "jeopi-utils";
import { Args, Command, Flags, renderCommandHelp } from "jeopi-utils/cli";
import { type AgentsAction, type AgentsCommandArgs, runAgentsCommand } from "../cli/agents-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: AgentsAction[] = ["unpack"];

export default class Agents extends Command {
	static description = "Manage bundled task agents";

	static args = {
		action: Args.string({
			description: "Agents action",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		force: Flags.boolean({ char: "f", description: "Overwrite existing agent files" }),
		json: Flags.boolean({ description: "Output JSON" }),
		dir: Flags.string({ description: "Output directory (overrides --user/--project)" }),
		user: Flags.boolean({ description: "Write to ~/.jeopi/agent/agents (default)" }),
		project: Flags.boolean({ description: "Write to ./.jeopi/agents" }),
	};

	static examples = [
		"# Export bundled agents into user config (default)\n  jeopi agents unpack",
		"# Export bundled agents into project config\n  jeopi agents unpack --project",
		"# Overwrite existing local agent files\n  jeopi agents unpack --project --force",
		"# Export into a custom directory\n  jeopi agents unpack --dir ./tmp/agents --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Agents);
		if (!args.action) {
			renderCommandHelp(APP_NAME, "agents", Agents);
			return;
		}

		const cmd: AgentsCommandArgs = {
			action: args.action as AgentsAction,
			flags: {
				force: flags.force,
				json: flags.json,
				dir: flags.dir,
				user: flags.user,
				project: flags.project,
			},
		};

		await initTheme();
		await runAgentsCommand(cmd);
	}
}
