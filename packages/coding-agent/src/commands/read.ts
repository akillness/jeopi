/**
 * Show what the read tool will return for a path, URL, or internal URI.
 */
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { initTheme } from "../modes/theme/theme";

export default class Read extends Command {
	static description = "Show what the read tool will return for a path, URL, or internal URI";

	static args = {
		path: Args.string({
			description:
				"Path, URL, or internal URI to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	};

	static examples = [
		"jeopi read src/foo.ts",
		"jeopi read src/foo.ts:50-100",
		"jeopi read src/foo.ts:raw",
		"jeopi read https://example.com",
		"jeopi read omp://",
		"jeopi read issue://123",
		"jeopi read path/to/archive.zip:dir/file.ts",
		"jeopi read path/to/db.sqlite:users:42",
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Read);
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
