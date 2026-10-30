import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord } from "jeopi-utils";
import { loadMessengerConfig, validateMessengerEnvironment } from "./config";
import { DISCORD_API, DISCORD_GATEWAY_INTENTS, discordGatewayUrl } from "./discord";
import { MessengerHttpError, messengerFetchJson } from "./http";
import { installMessengerService, messengerServicePlan } from "./service";

// Flow modelled on Aside's Discord channel setup: one application, credentials verified before they are
// stored, the owner taken from an authoritative source, a gateway handshake before success, and reruns that
// repair the same setup instead of creating another.

export const DISCORD_TOKEN_ENV = "JEOPI_DISCORD_BOT_TOKEN";
const TOKEN_FILE = "discord-token";
const RUN_SCRIPT = "run-discord.sh";
const MESSAGE_CONTENT = 1 << 18;
const MESSAGE_CONTENT_LIMITED = 1 << 19;
/** The only application flags a bot token may change: the limited presence, member, and message intents. */
const EDITABLE_INTENT_FLAGS = (1 << 13) | (1 << 15) | MESSAGE_CONTENT_LIMITED;
const ADMINISTRATOR = 1n << 3n;
const EVERYTHING = (1n << 53n) - 1n;
/** What the gateway needs in a request channel: read, reply, react, attach, and open request threads. */
export const DISCORD_REQUIRED_PERMISSIONS: ReadonlyArray<readonly [name: string, bit: bigint]> = [
	["View Channels", 1n << 10n],
	["Send Messages", 1n << 11n],
	["Read Message History", 1n << 16n],
	["Add Reactions", 1n << 6n],
	["Attach Files", 1n << 15n],
	["Create Public Threads", 1n << 35n],
	["Send Messages in Threads", 1n << 38n],
];
const REQUIRED_MASK = DISCORD_REQUIRED_PERMISSIONS.reduce((mask, [, bit]) => mask | bit, 0n);
const REQUEST_CHANNEL_TYPES = new Set([0, 5]);
const THREAD_TYPES = new Set([10, 11, 12]);
const INVITE_POLL_MS = 3_000;
const GATEWAY_PROBE_MS = 20_000;
const DM_TEST_MESSAGE = "jeopi messenger is set up for this bot. Reply here to test the connection.";

export interface DiscordSetupIO {
	readonly interactive: boolean;
	say(line: string): void;
	ask(question: string): Promise<string>;
	askSecret(question: string): Promise<string>;
}

export interface DiscordSetupOptions {
	/** messenger.json to create or update; its directory becomes the private profile directory. */
	configPath: string;
	channelIds?: string[];
	userIds?: string[];
	toolNames?: string[];
	artifacts?: boolean;
	service?: boolean;
	/** Open the owner's DM channel, allow it, and send one test message. Default true. */
	dmTest?: boolean;
	inviteWaitMs?: number;
}

export interface DiscordSetupDeps {
	fetch?: typeof fetch;
	WebSocket?: typeof WebSocket;
	env?: Record<string, string | undefined>;
	sleep?: (ms: number) => Promise<void>;
	/** argv that starts this jeopi build; defaults to the running runtime and entry. */
	jeopiCommand?: string[];
	installService?: typeof installMessengerService;
}

export interface DiscordSetupResult {
	configPath: string;
	botName: string;
	applicationId: string;
	inviteUrl: string;
	allowedUserIds: string[];
	allowedChannelIds: string[];
	runScript: string;
	service?: string;
}

interface DiscordBot {
	id: string;
	username: string;
	applicationId: string;
	flags: number;
	ownerIds: string[];
}

interface RequestChannel {
	id: string;
	name: string;
	guildName: string;
}

type DiscordApi = (method: string, route: string, body?: unknown) => Promise<unknown>;

function discordApi(token: string, fetchImpl: typeof fetch): DiscordApi {
	return (method, route, body) =>
		messengerFetchJson(
			`${DISCORD_API}${route}`,
			{
				method,
				headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			undefined,
			fetchImpl,
		);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function discordInviteUrl(applicationId: string): string {
	const query = new URLSearchParams({ client_id: applicationId, scope: "bot", permissions: String(REQUIRED_MASK) });
	return `https://discord.com/oauth2/authorize?${query}`;
}

async function resolveToken(
	env: Record<string, string | undefined>,
	tokenPath: string,
	io: DiscordSetupIO,
): Promise<string> {
	let token = env[DISCORD_TOKEN_ENV]?.trim();
	if (!token) {
		try {
			token = (await Bun.file(tokenPath).text()).trim();
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	if (!token && io.interactive) {
		io.say("Developer Portal > your application > Bot > Reset Token, then paste it here (input is hidden).");
		token = (await io.askSecret("Discord bot token: ")).trim();
	}
	if (!token) throw new Error(`Set ${DISCORD_TOKEN_ENV} or run this command in a terminal to enter the bot token`);
	if (/\s/u.test(token)) throw new Error("The Discord bot token must not contain whitespace");
	return token;
}

async function inspectBot(api: DiscordApi): Promise<DiscordBot> {
	let user: unknown;
	let app: unknown;
	try {
		user = await api("GET", "/users/@me");
		app = await api("GET", "/applications/@me");
	} catch (error) {
		if (error instanceof MessengerHttpError && error.status === 401) {
			throw new Error("Discord rejected the bot token; copy a fresh one from Bot > Reset Token");
		}
		throw new Error("Could not reach Discord to verify the bot token");
	}
	if (!isRecord(user) || user.bot !== true || !str(user.id)) {
		throw new Error("The token does not belong to a bot user; copy it from the Bot page, not OAuth2");
	}
	if (!isRecord(app) || !str(app.id)) throw new Error("Discord returned no application for this bot");
	const team = isRecord(app.team) ? app.team : undefined;
	const ownerIds = team
		? [
				str(team.owner_user_id),
				...records(team.members)
					.filter(member => member.membership_state === 2)
					.map(member => (isRecord(member.user) ? str(member.user.id) : undefined)),
			]
		: [isRecord(app.owner) ? str(app.owner.id) : undefined];
	return {
		id: user.id as string,
		username: str(user.username) ?? "bot",
		applicationId: app.id as string,
		flags: typeof app.flags === "number" ? app.flags : 0,
		ownerIds: [...new Set(ownerIds.filter((id): id is string => Boolean(id)))],
	};
}

async function ensureMessageContentIntent(api: DiscordApi, bot: DiscordBot, io: DiscordSetupIO): Promise<void> {
	if (bot.flags & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED)) return;
	let flags = 0;
	try {
		const updated = await api("PATCH", "/applications/@me", {
			flags: (bot.flags & EDITABLE_INTENT_FLAGS) | MESSAGE_CONTENT_LIMITED,
		});
		flags = isRecord(updated) && typeof updated.flags === "number" ? updated.flags : 0;
	} catch {
		// Verified or large applications must use the portal toggle.
	}
	if (!(flags & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED))) {
		throw new Error(
			`Enable Message Content Intent at https://discord.com/developers/applications/${bot.applicationId}/bot, then rerun`,
		);
	}
	io.say("Enabled Message Content Intent for the application.");
}

async function waitForGuilds(
	api: DiscordApi,
	inviteUrl: string,
	io: DiscordSetupIO,
	sleep: (ms: number) => Promise<void>,
	waitMs: number,
): Promise<Record<string, unknown>[]> {
	let guilds = records(await api("GET", "/users/@me/guilds"));
	if (guilds.length) return guilds;
	if (!io.interactive) throw new Error(`Invite the bot to a server, then rerun: ${inviteUrl}`);
	io.say(`Invite the bot to your server (choose the server and authorize):\n  ${inviteUrl}`);
	io.say("Waiting for the bot to join…");
	for (const deadline = Date.now() + waitMs; Date.now() < deadline; ) {
		await sleep(INVITE_POLL_MS);
		guilds = records(await api("GET", "/users/@me/guilds"));
		if (guilds.length) return guilds;
	}
	throw new Error(`The bot has not joined a server yet; invite it, then rerun: ${inviteUrl}`);
}

/** Discord sends permission bitfields as decimal strings. */
function bits(value: unknown): bigint {
	return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

/** Discord's documented order: @everyone and role bits, Administrator, then @everyone/role/member overwrites. */
export function discordChannelPermissions(
	guild: Record<string, unknown>,
	memberRoleIds: string[],
	channel: Record<string, unknown>,
	botId: string,
): bigint {
	if (guild.owner_id === botId) return EVERYTHING;
	const guildId = str(guild.id);
	const roles = new Map(records(guild.roles).map(role => [str(role.id), bits(role.permissions)]));
	let permissions = roles.get(guildId) ?? 0n;
	for (const id of memberRoleIds) permissions |= roles.get(id) ?? 0n;
	if (permissions & ADMINISTRATOR) return EVERYTHING;
	const overwrites = records(channel.permission_overwrites);
	const everyone = overwrites.find(overwrite => overwrite.id === guildId);
	if (everyone) permissions = (permissions & ~bits(everyone.deny)) | bits(everyone.allow);
	let allow = 0n;
	let deny = 0n;
	for (const overwrite of overwrites) {
		if (overwrite.type === 0 && memberRoleIds.includes(str(overwrite.id) ?? "")) {
			allow |= bits(overwrite.allow);
			deny |= bits(overwrite.deny);
		}
	}
	permissions = (permissions & ~deny) | allow;
	const member = overwrites.find(overwrite => overwrite.type === 1 && overwrite.id === botId);
	if (member) permissions = (permissions & ~bits(member.deny)) | bits(member.allow);
	return permissions;
}

function missingPermissions(permissions: bigint): string[] {
	return DISCORD_REQUIRED_PERMISSIONS.filter(([, bit]) => !(permissions & bit)).map(([name]) => name);
}

async function selectChannels(
	api: DiscordApi,
	bot: DiscordBot,
	guilds: Record<string, unknown>[],
	requested: string[] | undefined,
	inviteUrl: string,
	io: DiscordSetupIO,
): Promise<RequestChannel[]> {
	const guildCache = new Map<
		string,
		{ guild: Record<string, unknown>; roles: string[]; channels: Record<string, unknown>[] }
	>();
	const loadGuild = async (guildId: string) => {
		let entry = guildCache.get(guildId);
		if (!entry) {
			const [guild, member, channels] = await Promise.all([
				api("GET", `/guilds/${guildId}`),
				api("GET", `/guilds/${guildId}/members/${bot.id}`),
				api("GET", `/guilds/${guildId}/channels`),
			]);
			entry = {
				guild: isRecord(guild) ? guild : {},
				roles:
					isRecord(member) && Array.isArray(member.roles) ? member.roles.filter(id => typeof id === "string") : [],
				channels: records(channels),
			};
			guildCache.set(guildId, entry);
		}
		return entry;
	};
	const guildIds = new Set(guilds.map(guild => str(guild.id)));
	const nameOf = (guildId: string): string => str(guilds.find(guild => guild.id === guildId)?.name) ?? guildId;

	if (requested?.length) {
		const selected: RequestChannel[] = [];
		for (const id of requested) {
			let channel: unknown;
			try {
				channel = await api("GET", `/channels/${id}`);
			} catch {
				throw new Error(`The bot cannot see channel ${id}; invite it to that server: ${inviteUrl}`);
			}
			if (!isRecord(channel) || !str(channel.guild_id) || !guildIds.has(str(channel.guild_id))) {
				throw new Error(`Channel ${id} is not in a server the bot has joined; invite it: ${inviteUrl}`);
			}
			const guildId = channel.guild_id as string;
			const { guild, roles, channels } = await loadGuild(guildId);
			// Threads inherit the parent's permissions; the guild listing carries the overwrites.
			const targetId = typeof channel.type === "number" && THREAD_TYPES.has(channel.type) ? channel.parent_id : id;
			const target = channels.find(candidate => candidate.id === targetId) ?? channel;
			const missing = missingPermissions(discordChannelPermissions(guild, roles, target, bot.id));
			if (missing.length) throw new Error(`The bot lacks ${missing.join(", ")} in #${str(channel.name) ?? id}`);
			selected.push({ id, name: str(channel.name) ?? id, guildName: nameOf(guildId) });
		}
		return selected;
	}

	const candidates: RequestChannel[] = [];
	for (const guildId of guildIds) {
		if (!guildId) continue;
		const { guild, roles, channels } = await loadGuild(guildId);
		for (const channel of channels) {
			if (typeof channel.type !== "number" || !REQUEST_CHANNEL_TYPES.has(channel.type) || !str(channel.id)) continue;
			if (missingPermissions(discordChannelPermissions(guild, roles, channel, bot.id)).length) continue;
			candidates.push({
				id: channel.id as string,
				name: str(channel.name) ?? (channel.id as string),
				guildName: nameOf(guildId),
			});
		}
	}
	if (!candidates.length) {
		throw new Error(
			`No text channel grants the bot ${DISCORD_REQUIRED_PERMISSIONS.map(([name]) => name).join(", ")}; grant them or pass --channel`,
		);
	}
	if (candidates.length === 1) return candidates;
	const listing = candidates.map(
		(channel, index) => `  ${index + 1}. #${channel.name} in ${channel.guildName} (${channel.id})`,
	);
	if (!io.interactive) throw new Error(`Several channels qualify; pass --channel <id>:\n${listing.join("\n")}`);
	io.say(`Channels where the bot can work:\n${listing.join("\n")}`);
	const answer = (await io.ask("Request channel number [1]: ")).trim();
	const index = answer ? Number.parseInt(answer, 10) - 1 : 0;
	const choice = candidates[index];
	if (!choice) throw new Error("No channel selected");
	return [choice];
}

async function openOwnerDm(api: DiscordApi, userId: string, io: DiscordSetupIO): Promise<string | undefined> {
	try {
		const channel = await api("POST", "/users/@me/channels", { recipient_id: userId });
		const id = isRecord(channel) ? str(channel.id) : undefined;
		if (id) return id;
	} catch {
		// Reported below; server requests still work.
	}
	io.say(`Could not open a DM with ${userId}; DMs to the bot will be ignored until its DM channel is allowed.`);
	return undefined;
}

async function probeGateway(api: DiscordApi, token: string, WebSocketImpl: typeof WebSocket): Promise<void> {
	const discovery = await api("GET", "/gateway/bot");
	const url = discordGatewayUrl(isRecord(discovery) ? discovery.url : undefined);
	const result = Promise.withResolvers<void>();
	const socket = new WebSocketImpl(url);
	const timer = setTimeout(
		() => result.reject(new Error("Discord Gateway did not confirm the bot session in time")),
		GATEWAY_PROBE_MS,
	);
	socket.addEventListener("message", (event: MessageEvent) => {
		let packet: unknown;
		try {
			packet = typeof event.data === "string" ? JSON.parse(event.data) : undefined;
		} catch {
			return;
		}
		if (!isRecord(packet)) return;
		if (packet.op === 10) {
			socket.send(
				JSON.stringify({
					op: 2,
					d: {
						token,
						intents: DISCORD_GATEWAY_INTENTS,
						properties: { os: process.platform, browser: "jeopi", device: "jeopi" },
					},
				}),
			);
		} else if (packet.op === 0 && packet.t === "READY") {
			result.resolve();
		}
	});
	socket.addEventListener("close", (event: CloseEvent) => {
		if (event.code === 4004) result.reject(new Error("Discord Gateway rejected the bot token (4004)"));
		else if (event.code === 4013 || event.code === 4014) {
			result.reject(new Error("Discord Gateway refused the message intents (4014); enable Message Content Intent"));
		} else result.reject(new Error(`Discord Gateway closed before the session was ready (${event.code})`));
	});
	socket.addEventListener("error", () => result.reject(new Error("Discord Gateway connection failed")));
	try {
		await result.promise;
	} finally {
		clearTimeout(timer);
		try {
			socket.close(1000);
		} catch {
			// Already closed.
		}
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The token is read from the 0600 file at launch, so it never lands in this script or a service definition. */
export function discordRunScript(command: string[], configName: string, tokenEnv: string, envPath: string): string {
	return `#!/bin/sh
# Generated by \`jeopi messenger setup\`: starts this profile's Discord gateway.
set -eu
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
token_file="$dir/${TOKEN_FILE}"
case "$(ls -ln "$token_file" | cut -c5-10)" in
	------) ;;
	*) echo "${TOKEN_FILE} must be readable by its owner only (chmod 600)" >&2; exit 1 ;;
esac
PATH=${shellQuote(envPath)}
export PATH
${tokenEnv}=$(cat "$token_file")
export ${tokenEnv}
exec ${command.map(shellQuote).join(" ")} messenger run --config "$dir/${configName}"
`;
}

async function writePrivate(file: string, content: string, mode: number): Promise<void> {
	const temporary = `${file}.${process.pid}.tmp`;
	await Bun.write(temporary, content);
	await fs.chmod(temporary, mode);
	await fs.rename(temporary, file);
}

async function readExistingConfig(configPath: string): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await Bun.file(configPath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	try {
		const value: unknown = JSON.parse(text);
		if (isRecord(value)) return value;
	} catch {
		// Fall through to the refusal below.
	}
	throw new Error(`${configPath} exists but is not a JSON object; fix or move it before setup`);
}

function currentJeopiCommand(): string[] {
	const entry = Bun.main;
	return entry === process.execPath || entry.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, entry];
}

/** Create or repair a Discord messenger profile with as few manual steps as Discord allows. */
export async function setupDiscordMessenger(
	options: DiscordSetupOptions,
	io: DiscordSetupIO,
	deps: DiscordSetupDeps = {},
): Promise<DiscordSetupResult> {
	const env = deps.env ?? process.env;
	const configPath = path.resolve(options.configPath);
	const directory = path.dirname(configPath);
	const tokenPath = path.join(directory, TOKEN_FILE);
	const runScript = path.join(directory, RUN_SCRIPT);

	const token = await resolveToken(env, tokenPath, io);
	const api = discordApi(token, deps.fetch ?? fetch);
	const bot = await inspectBot(api);
	io.say(`Bot ${bot.username} (${bot.id}), application ${bot.applicationId}`);
	await ensureMessageContentIntent(api, bot, io);

	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await writePrivate(tokenPath, `${token}\n`, 0o600);

	const inviteUrl = discordInviteUrl(bot.applicationId);
	const guilds = await waitForGuilds(api, inviteUrl, io, deps.sleep ?? Bun.sleep, options.inviteWaitMs ?? 300_000);
	const existing = await readExistingConfig(configPath);
	const platforms = isRecord(existing?.platforms) ? existing.platforms : {};
	const previous = isRecord(platforms.discord) ? platforms.discord : {};
	const previousList = (key: string): string[] | undefined => {
		const value = previous[key];
		return Array.isArray(value) && value.length ? value.filter(id => typeof id === "string") : undefined;
	};

	const userIds = options.userIds?.length ? options.userIds : (previousList("allowedUserIds") ?? bot.ownerIds);
	if (!userIds.length) throw new Error("Could not identify the application owner; pass --user <your Discord user id>");
	let channelIds: string[];
	if (options.channelIds?.length || !previousList("allowedChannelIds")) {
		const channels = await selectChannels(api, bot, guilds, options.channelIds, inviteUrl, io);
		for (const channel of channels) io.say(`Request channel: #${channel.name} in ${channel.guildName}`);
		channelIds = channels.map(channel => channel.id);
	} else {
		channelIds = previousList("allowedChannelIds") as string[];
	}
	const dmChannel = options.dmTest === false ? undefined : await openOwnerDm(api, userIds[0], io);
	const allowedChannelIds = [...new Set([...channelIds, ...(dmChannel ? [dmChannel] : [])])];
	const tokenEnv = str(previous.tokenEnv) ?? DISCORD_TOKEN_ENV;

	const discord: Record<string, unknown> = { ...previous, tokenEnv, allowedUserIds: userIds, allowedChannelIds };
	if (options.artifacts) discord.artifactDir = "./artifacts";
	const config = {
		...existing,
		cwd: str(existing?.cwd) ?? "./workspace",
		sessionDir: str(existing?.sessionDir) ?? "./sessions",
		toolNames: options.toolNames ?? (Array.isArray(existing?.toolNames) ? existing.toolNames : []),
		platforms: { ...platforms, discord },
	};
	for (const relative of [config.cwd, config.sessionDir, discord.artifactDir]) {
		if (typeof relative === "string")
			await fs.mkdir(path.resolve(directory, relative), { recursive: true, mode: 0o700 });
	}
	await writePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
	const envPath = [...new Set([path.dirname(process.execPath), ...(env.PATH ?? "/usr/bin:/bin").split(":")])].join(
		":",
	);
	await writePrivate(
		runScript,
		discordRunScript(deps.jeopiCommand ?? currentJeopiCommand(), path.basename(configPath), tokenEnv, envPath),
		0o700,
	);
	// The same loader `messenger run` uses must accept what was written.
	const written = await loadMessengerConfig(configPath);
	validateMessengerEnvironment(
		{ ...written, platforms: { discord: written.platforms.discord } },
		{ [tokenEnv]: token },
	);

	await probeGateway(api, token, deps.WebSocket ?? WebSocket);
	io.say("Discord Gateway accepted the bot session and intents.");

	let service: string | undefined;
	if (options.service) {
		service = await (deps.installService ?? installMessengerService)(messengerServicePlan(directory, runScript));
		io.say(`Gateway running as ${service}`);
	}
	if (dmChannel) {
		try {
			await api("POST", `/channels/${dmChannel}/messages`, { content: DM_TEST_MESSAGE });
			io.say("Sent a test DM to the owner.");
		} catch {
			io.say(
				"Could not send the test DM (the owner may block DMs from server members); server requests still work.",
			);
		}
	}
	return {
		configPath,
		botName: bot.username,
		applicationId: bot.applicationId,
		inviteUrl,
		allowedUserIds: userIds,
		allowedChannelIds,
		runScript,
		...(service ? { service } : {}),
	};
}
