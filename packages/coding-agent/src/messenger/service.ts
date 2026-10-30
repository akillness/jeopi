import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

/** A per-user background service that keeps one messenger profile's gateway running. */
export interface MessengerServicePlan {
	/** Stable service name derived from the profile directory. */
	label: string;
	/** Profile directory: working directory and home of the run script and log. */
	directory: string;
	runScript: string;
	logFile: string;
}

export function messengerServicePlan(directory: string, runScript: string): MessengerServicePlan {
	const slug =
		path
			.basename(directory)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "default";
	return {
		label: `dev.jeopi.messenger.${slug}`,
		directory,
		runScript,
		logFile: path.join(directory, "gateway.log"),
	};
}

function xml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** launchd job: starts at login, restarts after a crash (throttled), logs to the profile directory. */
export function launchdPlist(plan: MessengerServicePlan): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${xml(plan.label)}</string>
	<key>ProgramArguments</key>
	<array><string>/bin/sh</string><string>${xml(plan.runScript)}</string></array>
	<key>WorkingDirectory</key><string>${xml(plan.directory)}</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>30</integer>
	<key>StandardOutPath</key><string>${xml(plan.logFile)}</string>
	<key>StandardErrorPath</key><string>${xml(plan.logFile)}</string>
</dict>
</plist>
`;
}

/** systemd --user unit with the same lifecycle as the launchd job. */
export function systemdUnit(plan: MessengerServicePlan): string {
	const quoted = (value: string): string => `"${value.replace(/(["\\])/g, "\\$1")}"`;
	return `[Unit]
Description=jeopi messenger gateway (${plan.label})
After=network-online.target

[Service]
WorkingDirectory=${quoted(plan.directory)}
ExecStart=/bin/sh ${quoted(plan.runScript)}
Restart=always
RestartSec=30
StandardOutput=append:${plan.logFile}
StandardError=append:${plan.logFile}

[Install]
WantedBy=default.target
`;
}

/**
 * Install (or replace) and start the service, then confirm the platform reports it running.
 * Returns a one-line description of where it was installed.
 */
export async function installMessengerService(
	plan: MessengerServicePlan,
	platform: NodeJS.Platform = process.platform,
	home: string = os.homedir(),
): Promise<string> {
	if (platform === "darwin") {
		const file = path.join(home, "Library", "LaunchAgents", `${plan.label}.plist`);
		await Bun.write(file, launchdPlist(plan));
		const domain = `gui/${process.getuid?.() ?? 0}`;
		await $`launchctl bootout ${domain} ${file}`.quiet().nothrow();
		// bootstrap can fail briefly while a replaced job is still exiting.
		let loaded = false;
		for (let attempt = 0; attempt < 5 && !loaded; attempt++) {
			if (attempt) await Bun.sleep(1_000);
			loaded = (await $`launchctl bootstrap ${domain} ${file}`.quiet().nothrow()).exitCode === 0;
		}
		if (!loaded) throw new Error(`launchctl could not load ${file}`);
		for (let attempt = 0; attempt < 20; attempt++) {
			const status = await $`launchctl print ${domain}/${plan.label}`.quiet().nothrow();
			if (status.exitCode === 0 && /\bstate = running\b/.test(status.text()))
				return `launchd job ${plan.label} (${file})`;
			await Bun.sleep(500);
		}
		throw new Error(`launchd job ${plan.label} did not reach the running state; see ${plan.logFile}`);
	}
	if (platform === "linux") {
		const unit = `${plan.label}.service`;
		const file = path.join(home, ".config", "systemd", "user", unit);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, systemdUnit(plan));
		const reload = await $`systemctl --user daemon-reload`.quiet().nothrow();
		const enable = await $`systemctl --user enable ${unit}`.quiet().nothrow();
		const restart = await $`systemctl --user restart ${unit}`.quiet().nothrow();
		if (reload.exitCode !== 0 || enable.exitCode !== 0 || restart.exitCode !== 0) {
			throw new Error(`systemctl --user could not start ${unit}`);
		}
		const active = await $`systemctl --user is-active ${unit}`.quiet().nothrow();
		if (active.text().trim() !== "active") throw new Error(`${unit} is not active; see ${plan.logFile}`);
		return `systemd user unit ${unit} (${file})`;
	}
	throw new Error(
		`Background services are supported on macOS (launchd) and Linux (systemd --user); run ${plan.runScript} under your own process manager`,
	);
}
