import * as path from "node:path";
import type { MessengerConfig, MessengerPlatform, MessengerPlatformConfig } from "./types";

const PLATFORMS: MessengerPlatform[] = ["discord", "telegram", "slack"];
const TOOLS: Record<string, true> = { read: true, grep: true, glob: true, bash: true, edit: true, write: true };

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
	if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} contains an unknown setting`);
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() !== value || !value || /[\u0000-\u001f\u007f]/u.test(value)) {
		throw new Error(`${label} must be a nonempty string without surrounding whitespace or control characters`);
	}
	return value;
}

function ids(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a nonempty list of exact IDs`);
	const result = value.map(item => string(item, label));
	if (result.some(id => /[\s*]/u.test(id)) || new Set(result).size !== result.length) {
		throw new Error(`${label} must contain unique exact IDs, without whitespace or wildcards`);
	}
	return result;
}

function envName(value: unknown, fallback: string, label: string): string {
	const result = value === undefined ? fallback : string(value, label);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(result)) throw new Error(`${label} must name an environment variable`);
	return result;
}

export function parseMessengerConfig(value: unknown, baseDir: string): MessengerConfig {
	const input = object(value, "Messenger config");
	keys(input, ["cwd", "sessionDir", "toolNames", "platforms"], "Messenger config");
	const platformsInput = object(input.platforms, "platforms");
	keys(platformsInput, PLATFORMS, "platforms");
	if (Object.keys(platformsInput).length === 0) throw new Error("At least one messenger platform is required");
	const platforms: MessengerConfig["platforms"] = {};
	for (const platform of PLATFORMS) {
		if (!Object.hasOwn(platformsInput, platform)) continue;
		const item = object(platformsInput[platform], `${platform} config`);
		keys(
			item,
			platform === "slack"
				? ["tokenEnv", "appTokenEnv", "allowedUserIds", "allowedChannelIds"]
				: ["tokenEnv", "allowedUserIds", "allowedChannelIds"],
			`${platform} config`,
		);
		const config: MessengerPlatformConfig = {
			tokenEnv: envName(item.tokenEnv, `JEOPI_${platform.toUpperCase()}_BOT_TOKEN`, `${platform}.tokenEnv`),
			allowedUserIds: ids(item.allowedUserIds, `${platform}.allowedUserIds`),
		};
		if (platform === "slack")
			config.appTokenEnv = envName(item.appTokenEnv, "JEOPI_SLACK_APP_TOKEN", "slack.appTokenEnv");
		if (item.allowedChannelIds !== undefined)
			config.allowedChannelIds = ids(item.allowedChannelIds, `${platform}.allowedChannelIds`);
		platforms[platform] = config;
	}
	const toolNames = input.toolNames === undefined ? [] : input.toolNames;
	if (
		!Array.isArray(toolNames) ||
		toolNames.some(name => typeof name !== "string" || !Object.hasOwn(TOOLS, name)) ||
		new Set(toolNames).size !== toolNames.length
	) {
		throw new Error("toolNames must be a unique list drawn from read, grep, glob, bash, edit, write");
	}
	return {
		cwd: path.resolve(baseDir, input.cwd === undefined ? "." : string(input.cwd, "cwd")),
		sessionDir: path.resolve(
			baseDir,
			input.sessionDir === undefined ? ".jeopi/messenger-sessions" : string(input.sessionDir, "sessionDir"),
		),
		toolNames: [...toolNames] as string[],
		platforms,
	};
}

export async function loadMessengerConfig(file: string): Promise<MessengerConfig> {
	let value: unknown;
	try {
		value = await Bun.file(file).json();
	} catch {
		throw new Error("Cannot read messenger configuration as JSON");
	}
	return parseMessengerConfig(value, path.dirname(path.resolve(file)));
}

export function validateMessengerEnvironment(
	config: MessengerConfig,
	env: Record<string, string | undefined> = process.env,
): void {
	for (const platform of PLATFORMS) {
		const item = config.platforms[platform];
		if (!item) continue;
		for (const name of [item.tokenEnv, item.appTokenEnv]) {
			if (name === undefined) continue;
			const token = env[name];
			if (!token?.trim() || token !== token.trim() || /[\s\u0000-\u001f\u007f]/u.test(token)) {
				throw new Error(`${platform} requires a nonempty credential in ${name}`);
			}
		}
	}
}
