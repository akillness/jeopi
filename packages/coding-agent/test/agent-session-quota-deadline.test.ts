import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "jeopi-agent-core";
import type { Model } from "jeopi-ai";
import { createMockModel, type MockResponse } from "jeopi-ai/providers/mock";
import * as aiStream from "jeopi-ai/stream";
import { type GeneratedProvider, getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { AgentSession, type AgentSessionEvent } from "jeopi-cli/session/agent-session";
import { AuthStorage } from "jeopi-cli/session/auth-storage";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { TempDir } from "jeopi-utils";

const hardQuota =
	"Cloud Code Assist API error (429): Cloud Code Assist quota exhausted on quota-user@example.test. Resource has been exhausted (e.g. check quota). Add another Google account with /login, switch models/providers, or wait for the reset.";
const throttle = "429 rate limit exceeded retry-after-ms=59000";

function bundled(provider: GeneratedProvider, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Missing test model: ${provider}/${id}`);
	return model;
}

// Drain the current event turn, not a wall-clock sleep. AgentSession dispatches
// agent_end asynchronously; its retry promises must have settled by this boundary.
async function drainEvents(): Promise<void> {
	const drained = Promise.withResolvers<void>();
	setImmediate(drained.resolve);
	await drained.promise;
}

const wait = scheduler.wait.bind(scheduler);

function skipRetryDelays(): number[] {
	const waits: number[] = [];
	vi.spyOn(scheduler, "wait").mockImplementation((delay = 0, options) => {
		if (delay < 1_000) return wait(delay, options);
		waits.push(delay);
		return Promise.resolve();
	});
	return waits;
}

describe("AgentSession quota and absolute deadline recovery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-quota-deadline-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		authStorage.setRuntimeApiKey("google-antigravity", "test-google-key");
		authStorage.setRuntimeApiKey("anthropic", "test-anthropic-key");
		registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		vi.useRealTimers();
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function createSession(options: {
		model?: Model;
		deadline?: number;
		fallback?: string;
		revertAfterCooldown?: boolean;
		respond: (model: Model, attempt: number) => MockResponse;
		resolveCredentials?: boolean;
	}) {
		const model = options.model ?? bundled("google-antigravity", "gemini-3-flash");
		const requests: string[] = [];
		const events: AgentSessionEvent[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			deadline: options.deadline,
			getApiKey: requestedModel =>
				options.resolveCredentials ? registry.resolver(requestedModel, agent.sessionId) : "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, streamOptions) => {
				requests.push(`${requestedModel.provider}/${requestedModel.id}`);
				mock.push(options.respond(requestedModel, requests.length));
				return mock.stream(requestedModel, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 300_000,
			"retry.maxRetries": 2,
			"retry.modelFallback": true,
			"retry.fallbackRevertPolicy": options.revertAfterCooldown ? "cooldown-expiry" : "never",
			"retry.fallbackChains": options.fallback ? { default: [options.fallback] } : {},
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
		});
		session.subscribe(event => events.push(event));
		return { session, requests, events };
	}

	for (const fallback of [undefined, "openai/gpt-4o-mini"]) {
		it(`ends hard quota without resending when ${fallback ? "the configured fallback lacks credentials" : "no fallback is configured"}`, async () => {
			const run = createSession({ fallback, respond: () => ({ throw: hardQuota }) });
			const waits = skipRetryDelays();

			await run.session.prompt("An exhausted account must terminate");
			await run.session.waitForIdle();

			expect(run.requests).toEqual(["google-antigravity/gemini-3-flash"]);
			expect(waits).toEqual([]);
			expect(run.events.filter(event => event.type === "auto_retry_start")).toEqual([]);
			expect(run.events.filter(event => event.type === "auto_retry_end")).toEqual([
				expect.objectContaining({ success: false, finalError: expect.stringContaining("quota exhausted") }),
			]);
			expect(run.events.filter(event => event.type === "agent_end")).toHaveLength(1);
			expect(run.session.getLastAssistantMessage()).toMatchObject({ stopReason: "error", errorMessage: hardQuota });
			expect(run.session.isRetrying).toBe(false);
		});
	}

	it("does not resend an explicitly exhausted account even when it reports a retry hint", async () => {
		const run = createSession({ respond: () => ({ throw: `${hardQuota} retry-after-ms=59000` }) });
		const waits = skipRetryDelays();
		await run.session.prompt("Do not resend an exhausted account");
		await run.session.waitForIdle();
		expect(run.requests).toEqual(["google-antigravity/gemini-3-flash"]);
		expect(waits).toEqual([]);
		expect(run.events.filter(event => event.type === "auto_retry_start")).toEqual([]);
		expect(run.session.getLastAssistantMessage()?.stopReason).toBe("error");
	});

	it("recovers hard quota on a configured viable model instead of resending the exhausted model", async () => {
		authStorage.setRuntimeApiKey("openai", "test-openai-key");
		const run = createSession({
			fallback: "openai/gpt-4o-mini",
			respond: model =>
				model.provider === "openai" ? { content: ["Recovered on fallback"] } : { throw: hardQuota },
		});
		skipRetryDelays();

		await run.session.prompt("Recover on the configured provider");
		await run.session.waitForIdle();

		expect(run.requests).toEqual(["google-antigravity/gemini-3-flash", "openai/gpt-4o-mini"]);
		expect(run.session.getLastAssistantMessage()).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "Recovered on fallback" }],
		});
		expect(run.events.filter(event => event.type === "auto_retry_end")).toEqual([
			expect.objectContaining({ success: true }),
		]);
	});

	it("rotates a usable sibling credential before treating hard quota as terminal", async () => {
		authStorage.removeRuntimeApiKey("anthropic");
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "first-key" },
			{ type: "api_key", key: "second-key" },
		]);
		const run = createSession({
			model: bundled("anthropic", "claude-sonnet-4-5"),
			resolveCredentials: true,
			respond: (_model, attempt) =>
				attempt === 1 ? { throw: "429 quota exhausted" } : { content: ["Recovered with sibling"] },
		});
		skipRetryDelays();

		await run.session.prompt("Use the healthy account");
		await run.session.waitForIdle();

		expect(run.requests).toEqual(["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"]);
		expect(run.session.getLastAssistantMessage()).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "Recovered with sibling" }],
		});
	});

	it("still backs off and recovers transient throttling on the same model", async () => {
		const run = createSession({
			respond: (_model, attempt) => (attempt === 1 ? { throw: throttle } : { content: ["Recovered from throttle"] }),
		});
		const waits = skipRetryDelays();

		await run.session.prompt("A temporary throttle can recover");
		await run.session.waitForIdle();

		expect(run.requests).toEqual(["google-antigravity/gemini-3-flash", "google-antigravity/gemini-3-flash"]);
		expect(waits).toEqual([59_000]);
		expect(run.session.getLastAssistantMessage()).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "Recovered from throttle" }],
		});
	});

	for (const cancellation of ["abortRetry", "session abort", "deadline"] as const) {
		it(`settles while credential preparation is pending after ${cancellation}`, async () => {
			const run = createSession({
				deadline: cancellation === "deadline" ? Date.now() + 200 : undefined,
				respond: () => ({ throw: hardQuota }),
			});
			const preparing = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const markUsageLimitReached = authStorage.markUsageLimitReached.bind(authStorage);
			vi.spyOn(authStorage, "markUsageLimitReached").mockImplementation(async (...args) => {
				preparing.resolve();
				await release.promise;
				return markUsageLimitReached(...args);
			});
			const prompt = run.session.prompt("Cancel while credential recovery is pending");
			await preparing.promise;
			let abort: Promise<void> | undefined;
			if (cancellation === "abortRetry") run.session.abortRetry();
			else if (cancellation === "session abort") abort = run.session.abort();
			try {
				// Settle before releasing preparation: credential implementations may ignore abort.
				await prompt;
				await abort;
				await run.session.waitForIdle();
				expect(run.requests).toEqual(["google-antigravity/gemini-3-flash"]);
				expect(run.events.filter(event => event.type === "auto_retry_start")).toEqual([]);
				expect(run.session.isRetrying).toBe(false);
			} finally {
				release.resolve();
				await drainEvents();
			}
		});
	}

	it("does not apply a model fallback after its credential check outlives cancellation", async () => {
		const run = createSession({ fallback: "openai/gpt-4o-mini", respond: () => ({ throw: hardQuota }) });
		const preparing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const getApiKey = registry.getApiKey.bind(registry);
		let checks = 0;
		vi.spyOn(registry, "getApiKey").mockImplementation(async (...args) => {
			if (args[0].provider !== "openai") return getApiKey(...args);
			if (++checks === 2) {
				preparing.resolve();
				await release.promise;
			}
			return "test-openai-key";
		});
		const prompt = run.session.prompt("Cancel a pending fallback credential check");
		await preparing.promise;
		run.session.abortRetry();
		try {
			await prompt;
			await run.session.waitForIdle();
		} finally {
			release.resolve();
			await drainEvents();
		}
		expect(run.session.model?.provider).toBe("google-antigravity");
		expect(run.requests).toEqual(["google-antigravity/gemini-3-flash"]);
		expect(run.events.filter(event => event.type === "retry_fallback_applied")).toEqual([]);
	});

	for (const cancellation of ["abortRetry", "deadline"] as const) {
		it(`settles a pending scheduled primary restore after ${cancellation} without late model changes`, async () => {
			authStorage.setRuntimeApiKey("openai", "test-openai-key");
			const now = Date.now.bind(Date);
			const cooldownElapsed = 60 * 60 * 1_000;
			let clockOffset = 0;
			vi.spyOn(Date, "now").mockImplementation(() => now() + clockOffset);
			const run = createSession({
				deadline: cancellation === "deadline" ? now() + cooldownElapsed + 500 : undefined,
				fallback: "openai/gpt-4o-mini",
				revertAfterCooldown: true,
				respond: (_model, attempt) => {
					if (attempt === 2) clockOffset = cooldownElapsed;
					return { throw: "503 overloaded retry-after-ms=0" };
				},
			});
			const preparing = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const getApiKey = registry.getApiKey.bind(registry);
			vi.spyOn(registry, "getApiKey").mockImplementation(async (...args) => {
				if (args[0].provider !== "google-antigravity" || clockOffset === 0) return getApiKey(...args);
				preparing.resolve();
				await release.promise;
				return "test-google-key";
			});
			const prompt = run.session.prompt("Cancel primary restore after the fallback cooldown expires");

			await preparing.promise;
			const modelChanges = run.session.sessionManager.getEntries().filter(entry => entry.type === "model_change");

			if (cancellation === "abortRetry") run.session.abortRetry();
			try {
				await prompt;

				await run.session.waitForIdle();
				expect(run.session.isRetrying).toBe(false);
				expect(run.session.model?.provider).toBe("openai");
				expect(run.requests).toEqual(["google-antigravity/gemini-3-flash", "openai/gpt-4o-mini"]);
			} finally {
				release.resolve();
				await drainEvents();
			}
			expect(run.session.model?.provider).toBe("openai");
			expect(run.session.sessionManager.getEntries().filter(entry => entry.type === "model_change")).toEqual(
				modelChanges,
			);
			expect(run.requests).toEqual(["google-antigravity/gemini-3-flash", "openai/gpt-4o-mini"]);
		});
	}

	it("settles the prompt at its absolute deadline while a longer retry backoff is pending", async () => {
		const run = createSession({
			deadline: Date.now() + 200,
			respond: () => ({ throw: "503 overloaded retry-after-ms=180000" }),
		});
		await run.session.prompt("The retry wait must share the streaming deadline");
		await run.session.waitForIdle();
		expect(run.session.isRetrying).toBe(false);
		expect(run.requests).toEqual(["google-antigravity/gemini-3-flash"]);
		expect(run.events.filter(event => event.type === "auto_retry_start")).toEqual([
			expect.objectContaining({ delayMs: 180_000 }),
		]);
		expect(run.events.filter(event => event.type === "auto_retry_end")).toEqual([
			expect.objectContaining({ success: false, finalError: "Deadline exceeded" }),
		]);
		expect(run.events.filter(event => event.type === "agent_end")).toHaveLength(1);
	});
});
