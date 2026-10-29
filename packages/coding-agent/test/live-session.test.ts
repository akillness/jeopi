import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "jeopi-ai";
import { unregisterCustomApis } from "jeopi-ai/api-registry";
import { createMockModel, registerMockApi } from "jeopi-ai/providers/mock";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { InputController } from "jeopi-cli/modes/controllers/input-controller";
import type { InteractiveModeContext } from "jeopi-cli/modes/types";
import { createAgentSession } from "jeopi-cli/sdk";
import type { AgentSession } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { submitInteractiveInput } from "../src/main";
import { createLiveDiscordBridge, type LiveDiscordBridge } from "../src/messenger/live-session";
import type { MessengerAdapter, MessengerConfig, MessengerMessage } from "../src/messenger/types";

const bridges: LiveDiscordBridge[] = [];

afterEach(async () => {
	await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
});

function config(): MessengerConfig {
	return {
		cwd: "/tmp/live-discord-workspace",
		sessionDir: "/tmp/live-discord-state",
		toolNames: [],
		platforms: {
			discord: {
				tokenEnv: "TEST_DISCORD_TOKEN",
				allowedUserIds: ["authorized-user"],
				allowedChannelIds: ["authorized-channel"],
			},
		},
	};
}

function message(overrides: Partial<MessengerMessage> = {}): MessengerMessage {
	return {
		platform: "discord",
		accountId: "test-bot",
		channelId: "authorized-channel",
		senderId: "authorized-user",
		messageId: "message-1",
		text: "hello from Discord",
		direct: true,
		mentioned: false,
		...overrides,
	};
}

interface SessionFixture {
	ctx: InteractiveModeContext;
	prompts: string[];
	readonly aborts: number;
	readonly listenerCount: number;
	manager: { sessionId: string; sessionFile: string };
	busy: {
		isCompacting: boolean;
		isGeneratingHandoff: boolean;
		isRetrying: boolean;
		isBashRunning: boolean;
		isEvalRunning: boolean;
		hasPostPromptWork: boolean;
	};
	setStreaming(value: boolean): void;
	setPromptImpl(value: (text: string, prepared?: (message: UserMessage) => void) => Promise<boolean>): void;
	setAbortImpl(value: () => Promise<void>): void;
	replaceMessages(value: unknown[]): void;
	emitTurn(text: string, prepared?: (message: UserMessage) => void): void;
	emitEvent(event: unknown): void;
}

function sessionFixture(): SessionFixture {
	const listeners = new Set<(event: unknown) => void>();
	let messages: unknown[] = [];
	const prompts: string[] = [];
	let aborts = 0;
	let abortImpl = async (): Promise<void> => {};
	let isStreaming = false;
	const busy = {
		isCompacting: false,
		isGeneratingHandoff: false,
		isRetrying: false,
		isBashRunning: false,
		isEvalRunning: false,
		hasPostPromptWork: false,
	};
	const emitEvent = (event: unknown): void => {
		if (
			typeof event === "object" &&
			event !== null &&
			"type" in event &&
			event.type === "message_end" &&
			"message" in event
		) {
			messages.push(event.message);
		}
		for (const listener of listeners) listener(event);
	};
	const emitTurn = (text: string, prepared?: (message: UserMessage) => void): void => {
		const user = { role: "user", content: [{ type: "text", text }] } as UserMessage;
		prepared?.(user);
		emitEvent({ type: "message_end", message: user });
		emitEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `answer for ${text}` }],
				stopReason: "stop",
			},
		});
	};
	let promptImpl = async (text: string, prepared?: (message: UserMessage) => void): Promise<boolean> => {
		prompts.push(text);
		emitTurn(text, prepared);
		return true;
	};
	const session = {
		get messages() {
			return messages;
		},
		get isStreaming() {
			return isStreaming;
		},
		get isCompacting() {
			return busy.isCompacting;
		},
		get isGeneratingHandoff() {
			return busy.isGeneratingHandoff;
		},
		get isRetrying() {
			return busy.isRetrying;
		},
		get isBashRunning() {
			return busy.isBashRunning;
		},
		get isEvalRunning() {
			return busy.isEvalRunning;
		},
		get hasPostPromptWork() {
			return busy.hasPostPromptWork;
		},
		subscribe(listener: (event: unknown) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt(text: string, options?: { onPreparedUserMessage?: (message: UserMessage) => void }) {
			return promptImpl(text, options?.onPreparedUserMessage);
		},
		waitForIdle: async () => {},
		abort: async () => {
			aborts++;
			return abortImpl();
		},
	};
	const manager = { sessionId: "session-1", sessionFile: "/tmp/session-1.jsonl" };
	const ctx = {
		session,
		sessionManager: {
			getSessionId: () => manager.sessionId,
			getSessionFile: () => manager.sessionFile,
		},
		shutdownRequested: false,
		isShuttingDown: false,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		prompts,
		get aborts() {
			return aborts;
		},
		get listenerCount() {
			return listeners.size;
		},
		busy,
		manager,
		setStreaming(value) {
			isStreaming = value;
		},
		setPromptImpl(value) {
			promptImpl = value;
		},
		setAbortImpl(value) {
			abortImpl = value;
		},
		replaceMessages(value) {
			messages = value;
		},
		emitTurn,
		emitEvent,
	};
}

function bridgeFixture(fixture: SessionFixture, sendImpl?: (message: MessengerMessage, text: string) => Promise<void>) {
	const delivered: Array<{ message: MessengerMessage; text: string }> = [];
	const adapter: MessengerAdapter = {
		platform: "discord",
		async start(_onMessage, signal) {
			if (signal.aborted) return;
			await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
		},
		async send(incoming, text) {
			if (sendImpl) await sendImpl(incoming, text);
			delivered.push({ message: incoming, text });
		},
	};
	const bridge = createLiveDiscordBridge(
		fixture.ctx,
		config(),
		{
			env: { TEST_DISCORD_TOKEN: "fixture-token" },
			createAdapter: () => adapter,
			pollIntervalMs: 60_000,
		},
		{ acknowledgeFullControl: true },
	);
	bridges.push(bridge);
	void bridge.run();
	return { bridge, delivered };
}

describe("live Discord bridge", () => {
	test("requires explicit full-control acknowledgement before attaching", () => {
		const fixture = sessionFixture();

		expect(() =>
			createLiveDiscordBridge(fixture.ctx, config(), {
				env: { TEST_DISCORD_TOKEN: "fixture-token" },
			}),
		).toThrow("Live Discord requires explicit full-control acknowledgement");
	});

	test("relays local answers only after choosing an allowed destination and never duplicates remote turns", async () => {
		const fixture = sessionFixture();
		const sent = Promise.withResolvers<void>();
		const observed: Array<[string, string]> = [];
		const { bridge } = bridgeFixture(fixture, async (incoming, text) => {
			observed.push([incoming.channelId, text]);
			if (text === "answer for local enabled") sent.resolve();
		});
		await bridge.withLocalTurn("local private", async () => fixture.emitTurn("local private"));
		expect(() => bridge.setRelayDestination("other-channel")).toThrow("explicitly allowed channel ID");
		bridge.setRelayDestination("authorized-channel");
		await bridge.gateway.handle(message({ messageId: "remote" }));
		await bridge.withLocalTurn("local enabled", async prepared => fixture.emitTurn("local enabled", prepared));
		await sent.promise;
		expect(observed).toEqual([
			[
				"authorized-channel",
				"answer for [Discord:remote sender:authorized-user channel:authorized-channel] hello from Discord",
			],
			["authorized-channel", "answer for local enabled"],
		]);
	});
	test("captures the next local answer while the previous Discord delivery is pending", async () => {
		const fixture = sessionFixture();
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const secondSent = Promise.withResolvers<void>();
		const observed: string[] = [];
		const { bridge } = bridgeFixture(fixture, async (_incoming, text) => {
			observed.push(text);
			if (text === "answer for first local") {
				firstStarted.resolve();
				await releaseFirst.promise;
			} else if (text === "answer for second local") secondSent.resolve();
		});
		bridge.setRelayDestination("authorized-channel");
		await bridge.withLocalTurn("first local", async prepared => fixture.emitTurn("first local", prepared));
		await firstStarted.promise;
		await bridge.withLocalTurn("second local", async prepared => fixture.emitTurn("second local", prepared));
		releaseFirst.resolve();
		await secondSent.promise;
		expect(observed).toEqual(["answer for first local", "answer for second local"]);
	});

	test("a pending local submission makes Discord busy and bridge closure does not abort it", async () => {
		const fixture = sessionFixture();
		const { bridge, delivered } = bridgeFixture(fixture);
		bridge.setRelayDestination("authorized-channel");
		const release = Promise.withResolvers<boolean>();
		const local = bridge.withLocalTurn("local preflight", () => release.promise);
		await bridge.gateway.handle(message({ messageId: "during-local" }));
		expect(delivered.map(item => item.text)).toEqual(["The live session is busy. Please try again when it is idle."]);
		expect(fixture.prompts).toEqual([]);
		await bridge.close();
		expect(fixture.aborts).toBe(0);
		release.resolve(true);
		expect(await local).toBe(true);
	});

	test.each(["off", "close"])(
		"%s immediately releases deferred local capture without abort or later delivery",
		async action => {
			const fixture = sessionFixture();
			const { bridge, delivered } = bridgeFixture(fixture);
			bridge.setRelayDestination("authorized-channel");
			const baseline = fixture.listenerCount;
			const release = Promise.withResolvers<void>();
			const local = bridge.withLocalTurn("deferred", async prepared => {
				await release.promise;
				fixture.emitTurn("deferred", prepared);
				return true;
			});
			expect(fixture.listenerCount).toBe(baseline + 1);
			if (action === "off") bridge.setRelayDestination(undefined);
			else await bridge.close();
			expect(fixture.listenerCount).toBe(baseline);
			expect(fixture.aborts).toBe(0);
			release.resolve();
			expect(await local).toBe(true);
			expect(delivered).toEqual([]);
		},
	);

	test("relays the answer to a prepared prompt even when its text was expanded", async () => {
		const fixture = sessionFixture();
		const sent = Promise.withResolvers<string>();
		const { bridge } = bridgeFixture(fixture, async (_message, text) => sent.resolve(text));
		bridge.setRelayDestination("authorized-channel");
		await bridge.withLocalTurn("original input", async prepared => {
			fixture.emitTurn("expanded input with context", prepared);
			return true;
		});
		expect(await sent.promise).toBe("answer for expanded input with context");
	});

	test.each(["same text", "different text"])(
		"suppresses relay when another user turn intervenes with %s",
		async text => {
			const fixture = sessionFixture();
			const warning = Promise.withResolvers<string>();
			Object.assign(fixture.ctx, { showWarning: (value: string) => warning.resolve(value) });
			const { bridge, delivered } = bridgeFixture(fixture);
			bridge.setRelayDestination("authorized-channel");
			await bridge.withLocalTurn("local", async prepared => {
				fixture.emitTurn("local", prepared);
				fixture.emitTurn(text === "same text" ? "local" : "other user");
				return true;
			});
			expect(await warning.promise).toContain("could not safely identify");
			expect(delivered).toEqual([]);
		},
	);

	test.each([true, false])("an ordinary idle Enter relays its answer (input waiter: %s)", async hasWaiter => {
		const fixture = sessionFixture();
		const sent = Promise.withResolvers<string>();
		const { bridge } = bridgeFixture(fixture, async (_message, text) => sent.resolve(text));
		bridge.setRelayDestination("authorized-channel");
		const ctx = fixture.ctx;
		const editor = {
			pendingImages: [],
			pendingImageLinks: [],
			addToHistory() {},
		} as unknown as InteractiveModeContext["editor"];
		Object.assign(ctx, {
			editor,
			liveDiscordBridge: bridge,
			fileSlashCommands: new Set(),
			isKnownSlashCommand: () => false,
			flushPendingBashComponents() {},
			startPendingSubmission: (input: object) => ({ ...input, cancelled: false, started: true }),
			withLocalSubmission: async (_text: string, submit: () => Promise<unknown>) => submit(),
			updatePendingMessagesDisplay() {},
			ui: { requestRender() {} },
			showError: (error: string) => {
				throw new Error(error);
			},
		});
		Object.assign(ctx.sessionManager, { getSessionName: () => "named" });
		const mode = {
			liveDiscordBridge: bridge,
			markPendingSubmissionStarted: () => true,
			finishPendingSubmission() {},
			showError: (error: string) => {
				throw new Error(error);
			},
			checkShutdownRequested: async () => {},
		};
		let submitted: Promise<void> | undefined;
		if (hasWaiter)
			ctx.onInputCallback = input => {
				submitted = submitInteractiveInput(mode, ctx.session, input);
			};
		new InputController(ctx).setupEditorSubmitHandler();
		await editor.onSubmit!("a local question");
		await submitted;
		expect(await sent.promise).toBe("answer for a local question");
	});

	test("routes an authorized Discord message through the active session and returns its assistant reply", async () => {
		const fixture = sessionFixture();
		const { bridge, delivered } = bridgeFixture(fixture);

		await bridge.gateway.handle(message());

		expect(fixture.prompts).toEqual([
			"[Discord:message-1 sender:authorized-user channel:authorized-channel] hello from Discord",
		]);
		expect(delivered.map(item => item.text)).toEqual([
			"answer for [Discord:message-1 sender:authorized-user channel:authorized-channel] hello from Discord",
		]);
		expect(bridge.active).toBe(true);
	});

	test("routes the prompt and reply after the session replaces message history during the turn", async () => {
		const fixture = sessionFixture();
		fixture.setPromptImpl(async text => {
			fixture.prompts.push(text);
			fixture.replaceMessages([{ role: "user", content: [{ type: "text", text }] }]);
			fixture.emitEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "after compaction" }], stopReason: "stop" },
			});
			return true;
		});
		const { bridge, delivered } = bridgeFixture(fixture);

		await bridge.gateway.handle(message({ messageId: "compacted" }));

		expect(fixture.prompts).toEqual([
			"[Discord:compacted sender:authorized-user channel:authorized-channel] hello from Discord",
		]);
		expect(delivered.map(item => item.text)).toEqual(["after compaction"]);
	});

	test("does not treat an agent-attributed developer event as a competing host turn", async () => {
		const fixture = sessionFixture();
		fixture.setPromptImpl(async text => {
			fixture.prompts.push(text);
			fixture.emitEvent({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
			fixture.emitEvent({
				type: "message_end",
				message: { role: "developer", attribution: "agent", content: [{ type: "text", text: "agent note" }] },
			});
			fixture.emitEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "agent event reply" }], stopReason: "stop" },
			});
			return true;
		});
		const { bridge, delivered } = bridgeFixture(fixture);

		await bridge.gateway.handle(message({ messageId: "attributed" }));

		expect(delivered.map(item => item.text)).toEqual(["agent event reply"]);
	});
	test("coalesces concurrent run calls onto one gateway lifetime", async () => {
		const fixture = sessionFixture();
		const { bridge } = bridgeFixture(fixture);

		const first = bridge.run();
		const second = bridge.run();

		expect(second).toBe(first);
		await bridge.close();
	});

	test.each([
		["unauthorized user", { senderId: "intruder" }],
		["unauthorized channel", { channelId: "other-channel" }],
	])("does not prompt or deliver %s", async (_name, overrides) => {
		const fixture = sessionFixture();
		const { bridge, delivered } = bridgeFixture(fixture);

		await bridge.gateway.handle(message(overrides));

		expect(fixture.prompts).toEqual([]);
		expect(delivered).toEqual([]);
	});

	test("rejects a local interactive turn while it is streaming without injecting a prompt", async () => {
		const fixture = sessionFixture();
		fixture.setStreaming(true);
		const { bridge, delivered } = bridgeFixture(fixture);

		await bridge.gateway.handle(message());

		expect(fixture.prompts).toEqual([]);
		expect(delivered.map(item => item.text)).toEqual(["The live session is busy. Please try again when it is idle."]);
	});

	test.each([
		["compaction", "isCompacting"],
		["handoff", "isGeneratingHandoff"],
		["retry", "isRetrying"],
		["bash", "isBashRunning"],
		["evaluation", "isEvalRunning"],
		["post-prompt work", "hasPostPromptWork"],
	] as const)("rejects a Discord turn while %s is active", async (_name, flag) => {
		const fixture = sessionFixture();
		fixture.busy[flag] = true;
		const { bridge, delivered } = bridgeFixture(fixture);

		await bridge.gateway.handle(message());

		expect(fixture.prompts).toEqual([]);
		expect(delivered.map(item => item.text)).toEqual(["The live session is busy. Please try again when it is idle."]);
	});

	test.each(["error", "aborted"] as const)("does not deliver an assistant %s turn", async stopReason => {
		const fixture = sessionFixture();
		fixture.setPromptImpl(async text => {
			fixture.prompts.push(text);
			fixture.emitEvent({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
			fixture.emitEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "partial output" }], stopReason },
			});
			return true;
		});
		const { bridge, delivered } = bridgeFixture(fixture);

		await bridge.gateway.handle(message({ messageId: `assistant-${stopReason}` }));

		expect(delivered.map(item => item.text)).toEqual(["The request could not be completed. Please try again."]);
	});

	test("fails closed when a custom session message interrupts the Discord turn", async () => {
		const fixture = sessionFixture();
		fixture.setPromptImpl(async text => {
			fixture.prompts.push(text);
			fixture.emitEvent({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
			fixture.emitEvent({
				type: "message_end",
				message: {
					role: "developer",
					content: [{ type: "text", text: "default agent developer output" }],
				},
			});
			fixture.emitEvent({
				type: "message_end",
				message: { role: "custom", attribution: "user", content: [{ type: "text", text: "local hook output" }] },
			});
			fixture.emitEvent({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer after interference" }],
					stopReason: "stop",
				},
			});
			return true;
		});
		const { bridge, delivered } = bridgeFixture(fixture);

		await bridge.gateway.handle(message({ messageId: "custom-interference" }));

		expect(delivered.map(item => item.text)).toEqual(["The request could not be completed. Please try again."]);
	});

	test("does not abort or deliver a response after the session changes mid-turn", async () => {
		const fixture = sessionFixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		fixture.setPromptImpl(async text => {
			fixture.prompts.push(text);
			started.resolve();
			await release.promise;
			fixture.emitTurn(text);
			return true;
		});
		const { bridge, delivered } = bridgeFixture(fixture);

		const pending = bridge.gateway.handle(message({ messageId: "switch-during-turn" }));
		await started.promise;
		fixture.manager.sessionId = "session-2";
		release.resolve();
		await pending;

		expect(fixture.aborts).toBe(0);
		expect(fixture.prompts).toEqual([
			"[Discord:switch-during-turn sender:authorized-user channel:authorized-channel] hello from Discord",
		]);
		expect(delivered).toEqual([]);
	});

	test("does not abort a local host turn that starts while Discord delivery is delayed", async () => {
		const fixture = sessionFixture();
		const sendStarted = Promise.withResolvers<void>();
		const releaseSend = Promise.withResolvers<void>();
		const { bridge, delivered } = bridgeFixture(fixture, async () => {
			sendStarted.resolve();
			await releaseSend.promise;
		});

		const pending = bridge.gateway.handle(message({ messageId: "delayed-send" }));
		await sendStarted.promise;
		fixture.emitTurn("local host turn");
		const closing = bridge.close();
		expect(fixture.aborts).toBe(0);

		releaseSend.resolve();
		await Promise.all([closing, pending]);
		expect(delivered.map(item => item.text)).toEqual([
			"answer for [Discord:delayed-send sender:authorized-user channel:authorized-channel] hello from Discord",
		]);
	});

	test("closes promptly while a remote prompt is held, aborting the host without delivering late output", async () => {
		const fixture = sessionFixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const promptCompleted = Promise.withResolvers<void>();
		let hostPromptCompleted = false;
		fixture.setPromptImpl(async text => {
			fixture.prompts.push(text);
			started.resolve();
			await release.promise;
			fixture.emitTurn(text);
			hostPromptCompleted = true;
			promptCompleted.resolve();
			return true;
		});
		const { bridge, delivered } = bridgeFixture(fixture);
		let pendingSettled = false;
		const pending = bridge.gateway.handle(message({ messageId: "held-prompt" })).finally(() => {
			pendingSettled = true;
		});

		await started.promise;
		await bridge.close();
		await pending;
		expect(pendingSettled).toBe(true);
		expect(hostPromptCompleted).toBe(false);
		expect(fixture.aborts).toBe(1);
		expect(delivered).toEqual([]);

		release.resolve();
		await promptCompleted.promise;
		expect(delivered).toEqual([]);
	});

	test("aborts a Discord prompt before its user event and prevents a reply after stop", async () => {
		const fixture = sessionFixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let aborted = false;
		fixture.setAbortImpl(async () => {
			aborted = true;
			release.resolve();
		});
		fixture.setPromptImpl(async text => {
			fixture.prompts.push(text);
			started.resolve();
			await release.promise;
			if (aborted) return false;
			fixture.emitTurn(text);
			return true;
		});
		const { bridge, delivered } = bridgeFixture(fixture);
		const pending = bridge.gateway.handle(message({ messageId: "preflight-stop" }));

		await started.promise;
		await bridge.close();
		expect(fixture.aborts).toBe(1);
		expect(delivered).toEqual([]);
		await pending;
		expect(fixture.prompts).toEqual([
			"[Discord:preflight-stop sender:authorized-user channel:authorized-channel] hello from Discord",
		]);
		expect(delivered).toEqual([]);
	});

	test.each(["transport failure", "external cancellation"] as const)(
		"%s aborts the active remote turn without delivering its answer",
		async cause => {
			const fixture = sessionFixture();
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const transportFailure = Promise.withResolvers<void>();
			const controller = new AbortController();
			const delivered: string[] = [];
			fixture.setPromptImpl(async text => {
				started.resolve();
				await release.promise;
				fixture.emitTurn(text);
				return true;
			});
			fixture.setAbortImpl(async () => release.resolve());
			const adapter: MessengerAdapter = {
				platform: "discord",
				async start(_onMessage, signal) {
					if (signal.aborted) return;
					await Promise.race([
						transportFailure.promise.then(() => {
							throw new Error("transport failed");
						}),
						new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })),
					]);
				},
				async send(_message, text) {
					delivered.push(text);
				},
			};
			const bridge = createLiveDiscordBridge(
				fixture.ctx,
				config(),
				{
					env: { TEST_DISCORD_TOKEN: "fixture-token" },
					createAdapter: () => adapter,
					pollIntervalMs: 60_000,
				},
				{ acknowledgeFullControl: true },
			);
			bridges.push(bridge);
			const running = bridge.run(controller.signal).then(
				() => "stopped",
				() => "failed",
			);
			const pending = bridge.gateway.handle(message({ messageId: "interrupted" }));
			try {
				await started.promise;
				if (cause === "transport failure") transportFailure.resolve();
				else controller.abort();
				expect(await running).toBe(cause === "transport failure" ? "failed" : "stopped");
				await pending;
				expect(fixture.aborts).toBe(1);
				expect(delivered).toEqual([]);
			} finally {
				release.resolve();
				controller.abort();
				await bridge.close();
			}
		},
	);

	test.each(["transport failure", "external cancellation"] as const)("%s never aborts a local turn", async cause => {
		const fixture = sessionFixture();
		const transportFailure = Promise.withResolvers<void>();
		const release = Promise.withResolvers<boolean>();
		const controller = new AbortController();
		const adapter: MessengerAdapter = {
			platform: "discord",
			async start(_onMessage, signal) {
				if (signal.aborted) return;
				await Promise.race([
					transportFailure.promise.then(() => {
						throw new Error("transport failed");
					}),
					new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })),
				]);
			},
			async send() {},
		};
		const bridge = createLiveDiscordBridge(
			fixture.ctx,
			config(),
			{
				env: { TEST_DISCORD_TOKEN: "fixture-token" },
				createAdapter: () => adapter,
				pollIntervalMs: 60_000,
			},
			{ acknowledgeFullControl: true },
		);
		bridges.push(bridge);
		const running = bridge.run(controller.signal).then(
			() => "stopped",
			() => "failed",
		);
		const local = bridge.withLocalTurn("local", () => release.promise);
		try {
			if (cause === "transport failure") transportFailure.resolve();
			else controller.abort();
			expect(await running).toBe(cause === "transport failure" ? "failed" : "stopped");
			expect(fixture.aborts).toBe(0);
			release.resolve(true);
			expect(await local).toBe(true);
		} finally {
			release.resolve(true);
			controller.abort();
			await bridge.close();
		}
	});

	test("rejects stale-session traffic, avoids cross-session leakage, and stops after close", async () => {
		const fixture = sessionFixture();
		const { bridge, delivered } = bridgeFixture(fixture);
		await bridge.gateway.handle(message({ messageId: "before-switch" }));
		fixture.manager.sessionId = "session-2";

		await bridge.gateway.handle(message({ messageId: "after-switch", text: "must not leak" }));
		expect(fixture.prompts).toEqual([
			"[Discord:before-switch sender:authorized-user channel:authorized-channel] hello from Discord",
		]);
		expect(delivered.map(item => item.text)).toEqual([
			"answer for [Discord:before-switch sender:authorized-user channel:authorized-channel] hello from Discord",
		]);

		const replacement = bridgeFixture(fixture);
		await replacement.bridge.gateway.handle(message({ messageId: "new-session", text: "fresh prompt" }));
		expect(fixture.prompts).toEqual([
			"[Discord:before-switch sender:authorized-user channel:authorized-channel] hello from Discord",
			"[Discord:new-session sender:authorized-user channel:authorized-channel] fresh prompt",
		]);
		expect(replacement.delivered.map(item => item.text)).toEqual([
			"answer for [Discord:new-session sender:authorized-user channel:authorized-channel] fresh prompt",
		]);

		await bridge.close();
		expect(bridge.active).toBe(false);
		await bridge.gateway.handle(message({ messageId: "after-close" }));
		expect(fixture.prompts).toEqual([
			"[Discord:before-switch sender:authorized-user channel:authorized-channel] hello from Discord",
			"[Discord:new-session sender:authorized-user channel:authorized-channel] fresh prompt",
		]);
		expect(delivered).toHaveLength(1);
	});
});

describe("live Discord bridge with the real AgentSession SDK", () => {
	test("executes one authorized prompt in the active SDK session and ignores an unauthorized message", async () => {
		const root = await mkdtemp(join(tmpdir(), "live-discord-runtime-"));
		const sourceId = "live-discord-runtime-test";
		const cwd = join(root, "workspace");
		const authStorage = await AuthStorage.create(join(root, "auth.db"));
		const model = createMockModel({
			responses: [{ content: ["deterministic Discord reply"] }, { content: ["expanded local reply"] }],
		});
		let session: AgentSession | undefined;
		let bridge: LiveDiscordBridge | undefined;

		try {
			registerMockApi(sourceId);
			authStorage.setRuntimeApiKey("mock", "fixture-only-key");
			const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
			const modelRegistry = new ModelRegistry(authStorage, join(root, "models.yml"));
			const settings = Settings.isolated({
				"autolearn.enabled": false,
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"memory.backend": "off",
				"advisor.enabled": false,
				"goal.enabled": false,
				"magicKeywords.enabled": false,
				"todo.enabled": false,
				"tools.discoveryMode": "off",
				"mcp.discoveryMode": false,
				"tools.approvalMode": "always-ask",
				"compaction.enabled": false,
				includeWorkspaceTree: false,
			});
			({ session } = await createAgentSession({
				cwd,
				agentDir: join(root, "agent"),
				authStorage,
				modelRegistry,
				model,
				sessionManager,
				settings,
				disableExtensionDiscovery: true,
				preloadedCustomToolPaths: [],
				customTools: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [
					{ name: "relay-template", description: "fixture", content: "expanded real template", source: "test" },
				],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				toolNames: [],
				hasUI: false,
				autoApprove: false,
			}));

			const sent: Array<{ message: MessengerMessage; text: string }> = [];
			const localSent = Promise.withResolvers<void>();
			let receive: ((incoming: MessengerMessage) => Promise<void>) | undefined;
			const started = Promise.withResolvers<void>();
			const adapter: MessengerAdapter = {
				platform: "discord",
				async start(onMessage, signal) {
					receive = onMessage;
					started.resolve();
					await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				},
				async send(incoming, text) {
					sent.push({ message: incoming, text });
					if (text === "expanded local reply") localSent.resolve();
				},
			};
			const ctx = {
				session,
				sessionManager,
				shutdownRequested: false,
				isShuttingDown: false,
				liveDiscordBridge: undefined,
				showStatus() {},
				showWarning() {},
			} as unknown as InteractiveModeContext;
			bridge = createLiveDiscordBridge(
				ctx,
				{
					cwd,
					sessionDir: join(root, "sessions"),
					toolNames: [],
					platforms: {
						discord: {
							tokenEnv: "TEST_DISCORD_TOKEN",
							allowedUserIds: ["authorized-user"],
							allowedChannelIds: ["authorized-channel"],
						},
					},
				},
				{
					env: { TEST_DISCORD_TOKEN: "fixture-token" },
					createAdapter: () => adapter,
					pollIntervalMs: 60_000,
				},
				{ acknowledgeFullControl: true },
			);
			ctx.liveDiscordBridge = bridge;
			const running = bridge.run();
			await started.promise;
			if (!receive) throw new Error("Fake Discord transport did not start");

			const authorized = message({ messageId: "runtime-authorized" });
			await receive(authorized);
			const expectedPrompt =
				"[Discord:runtime-authorized sender:authorized-user channel:authorized-channel] hello from Discord";
			expect(sent.map(item => item.text)).toEqual(["deterministic Discord reply"]);
			expect(model.calls).toHaveLength(1);
			const modelUserTexts = model.calls[0]!.context.messages.filter(item => item.role === "user").map(item =>
				typeof item.content === "string"
					? item.content
					: item.content
							.filter(block => block.type === "text")
							.map(block => block.text)
							.join(""),
			);
			expect(modelUserTexts.at(-1)).toBe(expectedPrompt);
			const assistant = session.messages.findLast(item => item.role === "assistant");
			expect(assistant?.stopReason).toBe("stop");
			expect(
				assistant?.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join("\n"),
			).toBe("deterministic Discord reply");

			await receive({ ...authorized, senderId: "intruder", messageId: "runtime-unauthorized" });
			expect(model.calls).toHaveLength(1);
			expect(sent).toHaveLength(1);

			bridge.setRelayDestination("authorized-channel");
			let preparedMessage: UserMessage | undefined;
			let observedMessage: UserMessage | undefined;
			const unsubscribe = session.subscribe(event => {
				if (event.type === "message_end" && event.message.role === "user") observedMessage = event.message;
			});
			await bridge.withLocalTurn("/relay-template", prepared =>
				session!.prompt("/relay-template", {
					onPreparedUserMessage: user => {
						preparedMessage = user;
						prepared(user);
					},
				}),
			);
			await localSent.promise;
			unsubscribe();
			expect(preparedMessage).toBe(observedMessage);
			expect(preparedMessage?.content).toEqual([{ type: "text", text: "expanded real template" }]);
			expect(sent.map(item => item.text)).toEqual(["deterministic Discord reply", "expanded local reply"]);

			await bridge.close();
			await running;
		} finally {
			await bridge?.close();
			await session?.dispose();
			authStorage.close();
			unregisterCustomApis(sourceId);
			await rm(root, { recursive: true, force: true });
		}
	});
});
