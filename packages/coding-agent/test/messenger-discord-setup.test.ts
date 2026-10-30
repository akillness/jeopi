import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { loadMessengerConfig } from "../src/messenger/config";
import {
	type DiscordSetupIO,
	type DiscordSetupOptions,
	discordRunScript,
	setupDiscordMessenger,
} from "../src/messenger/discord-setup";
import {
	installMessengerService,
	launchdPlist,
	type MessengerServicePlan,
	messengerServicePlan,
	systemdUnit,
} from "../src/messenger/service";

const TOKEN = "fake.bot-token.DO-NOT-PRINT";
const BOT = "900000000000000001";
const APP = "900000000000000002";
const OWNER = "633281085282844672";
const GUILD = "900000000000000010";
const GENERAL = "900000000000000011";
const LOCKED = "900000000000000012";
const SECOND = "900000000000000013";
const DM = "900000000000000099";
const REQUIRED = (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 6n) | (1n << 15n) | (1n << 35n) | (1n << 38n);
const SEND_MESSAGES = 1n << 11n;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function profile(): Promise<string> {
	const root = await fs.mkdtemp(path.join(tmpdir(), "discord-setup-"));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	return path.join(root, "discord");
}

type Handler = unknown | ((body: unknown) => unknown);

interface FakeDiscord {
	routes: Record<string, Handler>;
	calls: Array<{ route: string; body: unknown; auth: string | null }>;
	events: string[];
	fetch: typeof fetch;
	WebSocket: typeof WebSocket;
}

function fakeDiscord(
	options: { flags?: number; guilds?: unknown[]; channels?: unknown[]; gateway?: number } = {},
): FakeDiscord {
	const events: string[] = [];
	const calls: FakeDiscord["calls"] = [];
	const routes: Record<string, Handler> = {
		"GET /users/@me": { id: BOT, username: "soft", bot: true },
		"GET /applications/@me": { id: APP, flags: options.flags ?? 1 << 19, owner: { id: OWNER } },
		"PATCH /applications/@me": (body: unknown) => ({ id: APP, flags: (body as { flags: number }).flags }),
		"GET /users/@me/guilds": options.guilds ?? [{ id: GUILD, name: "home" }],
		[`GET /guilds/${GUILD}`]: {
			id: GUILD,
			owner_id: OWNER,
			roles: [
				{ id: GUILD, permissions: String(REQUIRED) },
				{ id: "role-bot", permissions: "0" },
			],
		},
		[`GET /guilds/${GUILD}/members/${BOT}`]: { roles: ["role-bot"] },
		[`GET /guilds/${GUILD}/channels`]: options.channels ?? [
			{ id: GENERAL, name: "general", type: 0, permission_overwrites: [] },
			{
				id: LOCKED,
				name: "locked",
				type: 0,
				permission_overwrites: [{ id: GUILD, type: 0, allow: "0", deny: String(SEND_MESSAGES) }],
			},
			{ id: "900000000000000014", name: "voice", type: 2, permission_overwrites: [] },
		],
		[`GET /channels/${LOCKED}`]: { id: LOCKED, name: "locked", type: 0, guild_id: GUILD },
		"POST /users/@me/channels": (body: unknown) => {
			expect(body).toEqual({ recipient_id: OWNER });
			return { id: DM, type: 1 };
		},
		[`POST /channels/${DM}/messages`]: () => {
			events.push("dm-message");
			return { id: "m1" };
		},
		"GET /gateway/bot": { url: "wss://gateway.discord.gg", session_start_limit: { remaining: 999 } },
	};
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const route = `${init?.method ?? "GET"} ${url.pathname.replace("/api/v10", "")}`;
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ route, body, auth: new Headers(init?.headers).get("authorization") });
		if (!(route in routes)) return new Response("{}", { status: 404 });
		const handler = routes[route];
		const value = typeof handler === "function" ? handler(body) : handler;
		return value instanceof Response ? value : Response.json(value);
	}) as typeof fetch;
	class FakeGateway extends EventTarget {
		constructor(readonly url: string) {
			super();
			queueMicrotask(() =>
				this.dispatchEvent(
					new MessageEvent("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41_250 } }) }),
				),
			);
		}
		send(data: string): void {
			const packet = JSON.parse(data);
			if (packet.op !== 2) return;
			events.push(`identify:${packet.d.token === TOKEN}:${packet.d.intents}`);
			queueMicrotask(() => {
				if (options.gateway) this.dispatchEvent(Object.assign(new Event("close"), { code: options.gateway }));
				else {
					events.push("ready");
					this.dispatchEvent(
						new MessageEvent("message", {
							data: JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "s" } }),
						}),
					);
				}
			});
		}
		close(): void {}
	}
	return { routes, calls, events, fetch: fetchImpl, WebSocket: FakeGateway as unknown as typeof WebSocket };
}

function recordingIO(interactive = false, answers: string[] = []): DiscordSetupIO & { lines: string[] } {
	const lines: string[] = [];
	return {
		interactive,
		lines,
		say: line => void lines.push(line),
		ask: async () => answers.shift() ?? "",
		askSecret: async () => answers.shift() ?? "",
	};
}

async function run(
	discord: FakeDiscord,
	configPath: string,
	options: Partial<DiscordSetupOptions> = {},
	env: Record<string, string | undefined> = { JEOPI_DISCORD_BOT_TOKEN: TOKEN, PATH: "/usr/bin:/bin" },
	io = recordingIO(),
	installService?: (plan: MessengerServicePlan) => Promise<string>,
) {
	const result = await setupDiscordMessenger({ configPath, ...options }, io, {
		fetch: discord.fetch,
		WebSocket: discord.WebSocket,
		env,
		sleep: async () => {},
		jeopiCommand: ["/opt/bun", "/opt/jeopi/cli.js"],
		installService,
	});
	return { result, io };
}

async function mode(file: string): Promise<number> {
	return (await fs.stat(file)).mode & 0o777;
}

describe("jeopi messenger setup (Discord)", () => {
	test("turns a bot token into a verified, owner-locked profile without printing the token", async () => {
		const dir = await profile();
		const configPath = path.join(dir, "messenger.json");
		const discord = fakeDiscord({ flags: (1 << 15) | (1 << 23) });
		const plans: MessengerServicePlan[] = [];
		const { result, io } = await run(discord, configPath, { service: true }, undefined, recordingIO(), async plan => {
			plans.push(plan);
			discord.events.push("service");
			return "fake service";
		});

		const patch = discord.calls.find(call => call.route === "PATCH /applications/@me");
		expect(patch?.body).toEqual({ flags: (1 << 15) | (1 << 19) });
		expect(result.allowedUserIds).toEqual([OWNER]);
		expect(result.allowedChannelIds).toEqual([GENERAL, DM]);
		expect(result.inviteUrl).toBe(
			`https://discord.com/oauth2/authorize?client_id=${APP}&scope=bot&permissions=${REQUIRED}`,
		);
		expect(discord.events).toEqual([
			`identify:true:${(1 << 9) | (1 << 12) | (1 << 15)}`,
			"ready",
			"service",
			"dm-message",
		]);
		expect(plans[0]?.runScript).toBe(path.join(dir, "run-discord.sh"));

		expect(await mode(dir)).toBe(0o700);
		expect(await mode(path.join(dir, "discord-token"))).toBe(0o600);
		expect(await mode(path.join(dir, "run-discord.sh"))).toBe(0o700);
		expect((await Bun.file(path.join(dir, "discord-token")).text()).trim()).toBe(TOKEN);
		const config = await loadMessengerConfig(configPath);
		expect(config.platforms.discord).toEqual({
			tokenEnv: "JEOPI_DISCORD_BOT_TOKEN",
			allowedUserIds: [OWNER],
			allowedChannelIds: [GENERAL, DM],
		});
		expect(config.toolNames).toEqual([]);
		expect(config.cwd).toBe(path.join(dir, "workspace"));
		const written = [
			io.lines.join("\n"),
			await Bun.file(configPath).text(),
			await Bun.file(path.join(dir, "run-discord.sh")).text(),
		].join("\n");
		expect(written).not.toContain(TOKEN);
		expect(discord.calls.every(call => call.auth === `Bot ${TOKEN}`)).toBe(true);
	});

	test("stops with the invite link before the bot joins a server, then resumes from the saved token", async () => {
		const dir = await profile();
		const configPath = path.join(dir, "messenger.json");
		const uninvited = fakeDiscord({ guilds: [] });
		await expect(run(uninvited, configPath)).rejects.toThrow(
			`Invite the bot to a server, then rerun: https://discord.com/oauth2/authorize?client_id=${APP}&scope=bot&permissions=${REQUIRED}`,
		);
		expect(await Bun.file(configPath).exists()).toBe(false);

		const { result } = await run(fakeDiscord(), configPath, {}, { PATH: "/usr/bin:/bin" });
		expect(result.allowedChannelIds).toEqual([GENERAL, DM]);
	});

	test("interactive setup waits for the invite, asks for the token, and lets the user pick among channels", async () => {
		const dir = await profile();
		const discord = fakeDiscord({
			channels: [
				{ id: GENERAL, name: "general", type: 0, permission_overwrites: [] },
				{ id: SECOND, name: "jeo-request", type: 0, permission_overwrites: [] },
			],
		});
		let guildChecks = 0;
		discord.routes["GET /users/@me/guilds"] = () => (++guildChecks < 3 ? [] : [{ id: GUILD, name: "home" }]);
		const io = recordingIO(true, [TOKEN, "2"]);
		const { result } = await run(discord, path.join(dir, "messenger.json"), { dmTest: false }, { PATH: "/bin" }, io);
		expect(guildChecks).toBe(3);
		expect(result.allowedChannelIds).toEqual([SECOND]);
		expect(io.lines.join("\n")).toContain(result.inviteUrl);
	});

	test("refuses ambiguous or under-privileged channels with an actionable message", async () => {
		const dir = await profile();
		const configPath = path.join(dir, "messenger.json");
		await expect(run(fakeDiscord(), configPath, { channelIds: [LOCKED] })).rejects.toThrow(
			"The bot lacks Send Messages in #locked",
		);
		const two = fakeDiscord({
			channels: [
				{ id: GENERAL, name: "general", type: 0, permission_overwrites: [] },
				{ id: SECOND, name: "jeo-request", type: 0, permission_overwrites: [] },
			],
		});
		await expect(run(two, configPath)).rejects.toThrow(
			/Several channels qualify; pass --channel <id>:[\s\S]*jeo-request/,
		);
	});

	test("fails before claiming success when the Gateway refuses the message intents", async () => {
		const dir = await profile();
		await expect(run(fakeDiscord({ gateway: 4014 }), path.join(dir, "messenger.json"))).rejects.toThrow(
			"Discord Gateway refused the message intents (4014)",
		);
	});

	test("a rerun repairs the Discord block and keeps the rest of the configuration", async () => {
		const dir = await profile();
		const configPath = path.join(dir, "messenger.json");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(
			configPath,
			JSON.stringify({
				cwd: "./code",
				toolNames: ["read"],
				platforms: {
					telegram: { tokenEnv: "TG_TOKEN", allowedUserIds: ["42"] },
					discord: { tokenEnv: "JEOPI_DISCORD_BOT_TOKEN", allowedUserIds: ["7"], allowedChannelIds: [GENERAL] },
				},
			}),
		);
		await run(fakeDiscord(), configPath, { userIds: [OWNER] });
		const config = JSON.parse(await Bun.file(configPath).text());
		expect(config.cwd).toBe("./code");
		expect(config.toolNames).toEqual(["read"]);
		expect(config.platforms.telegram).toEqual({ tokenEnv: "TG_TOKEN", allowedUserIds: ["42"] });
		expect(config.platforms.discord.allowedUserIds).toEqual([OWNER]);
		expect(config.platforms.discord.allowedChannelIds).toEqual([GENERAL, DM]);
	});

	test("the run script refuses a shared token file and otherwise exports the token to the gateway command", async () => {
		const dir = await profile();
		await fs.mkdir(dir, { recursive: true });
		const script = path.join(dir, "run-discord.sh");
		const command = ["/bin/sh", "-c", 'printf "%s|%s" "$JEOPI_DISCORD_BOT_TOKEN" "$*"', "sh"];
		await Bun.write(script, discordRunScript(command, "messenger.json", "JEOPI_DISCORD_BOT_TOKEN", "/usr/bin:/bin"));
		const token = path.join(dir, "discord-token");
		await Bun.write(token, `${TOKEN}\n`);

		await fs.chmod(token, 0o644);
		const shared = await $`/bin/sh ${script}`.quiet().nothrow();
		expect(shared.exitCode).toBe(1);
		expect(shared.stderr.toString()).toContain("discord-token must be readable by its owner only");

		await fs.chmod(token, 0o600);
		const ok = await $`/bin/sh ${script}`.quiet().nothrow();
		expect(ok.exitCode).toBe(0);
		expect(ok.stdout.toString()).toBe(`${TOKEN}|messenger run --config ${dir}/messenger.json`);
	});
});

describe("messenger login service", () => {
	const dir = "/Users/me/Bots & <Soft> Discord";
	const plan = messengerServicePlan(dir, `${dir}/run-discord.sh`);

	test("derives a stable label and log path from the profile directory", () => {
		expect(plan.label).toBe("dev.jeopi.messenger.bots-soft-discord");
		expect(plan.logFile).toBe(`${dir}/gateway.log`);
		expect(messengerServicePlan("/x/---", "/x/---/run").label).toBe("dev.jeopi.messenger.default");
	});

	test.if(process.platform === "darwin")(
		"writes a launchd plist that plutil accepts, with escaped paths",
		async () => {
			const plist = launchdPlist(plan);
			expect(plist).toContain("<string>/Users/me/Bots &amp; &lt;Soft&gt; Discord/run-discord.sh</string>");
			expect(plist).toContain("<key>KeepAlive</key><true/>");
			const root = await fs.mkdtemp(path.join(tmpdir(), "plist-"));
			cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
			const file = path.join(root, "job.plist");
			await Bun.write(file, plist);
			expect((await $`plutil -lint ${file}`.quiet().nothrow()).exitCode).toBe(0);
			const parsed = JSON.parse((await $`plutil -convert json -o - ${file}`.quiet()).stdout.toString());
			expect(parsed.ProgramArguments).toEqual(["/bin/sh", `${dir}/run-discord.sh`]);
			expect(parsed.WorkingDirectory).toBe(dir);
		},
	);

	test("writes a systemd user unit that restarts the gateway and quotes paths", () => {
		const unit = systemdUnit(plan);
		expect(unit).toContain(`ExecStart=/bin/sh "${dir}/run-discord.sh"`);
		expect(unit).toContain(`WorkingDirectory="${dir}"`);
		expect(unit).toContain("Restart=always");
		expect(unit).toContain("WantedBy=default.target");
	});

	test("other platforms are told to use their own process manager", async () => {
		await expect(installMessengerService(plan, "win32")).rejects.toThrow(
			`run ${dir}/run-discord.sh under your own process manager`,
		);
	});
});
