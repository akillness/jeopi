/**
 * Plugin trust gate — trust-on-first-use consent for third-party plugin code.
 *
 * `custom-tools`/`hooks`/`commands`/`extensions` loaders all execute arbitrary
 * TypeScript via native `import()` with full `exec`/`pi` API access. User-authored
 * tools under `.jeopi/tools/` etc. are trusted by construction (the user wrote or
 * explicitly configured them). Plugin-installed code is different: it arrives via
 * `bun install <name>` from a marketplace/npm registry, i.e. third-party code the
 * user did not author. This module gates that path specifically.
 *
 * Mirrors the `report-tool-issue.ts` auto-QA consent design: a process-global cache,
 * a disk-backed decision store, a single host-registered handler for the interactive
 * popup, and default-deny when no handler is registered (headless/CI/non-interactive
 * runs never silently execute unreviewed third-party code).
 *
 * Trust is keyed by `"<name>@<version>"` — any version bump (including a
 * marketplace auto-update) invalidates the previous grant and re-prompts, the same
 * supply-chain assumption package managers use for pinned versions.
 */
import { $flag, getPluginTrustStorePath, isEnoent, logger } from "jeopi-utils";

export type PluginTrustDecision = "granted" | "denied";

/**
 * Resolver for "do you trust this plugin?" consent.
 *
 * Return values mirror {@link import("../../tools/report-tool-issue").AutoQaConsentHandler}:
 *   - `true`  — trusted; load for this run and persist.
 *   - `false` — untrusted; skip for this run and persist.
 *   - `null`  — dismissed without a decision; skip this run only, re-prompt next time.
 */
export type PluginTrustHandler = (plugin: { name: string; version: string }) => Promise<boolean | null>;

interface TrustStoreShape {
	[trustKey: string]: PluginTrustDecision;
}

let trustHandler: PluginTrustHandler | null = null;
/** Process-global cache so a grant/denial in the parent applies to subagents immediately. */
const cachedDecisions = new Map<string, PluginTrustDecision>();
/** Single-flight in-flight prompts, keyed by trust key, so concurrent loaders don't stack popups. */
const inFlightPrompts = new Map<string, Promise<boolean>>();
let diskStoreCache: TrustStoreShape | null = null;

export function pluginTrustKey(plugin: { name: string; version: string }): string {
	return `${plugin.name}@${plugin.version}`;
}

/** Register the interactive trust-prompt handler. Passing `null` clears it (teardown). */
export function setPluginTrustHandler(handler: PluginTrustHandler | null): void {
	trustHandler = handler;
}

/** Test-only: reset all in-memory trust state. Never call from production code. */
export function __resetPluginTrustForTests(): void {
	trustHandler = null;
	cachedDecisions.clear();
	inFlightPrompts.clear();
	diskStoreCache = null;
}

async function readTrustStore(): Promise<TrustStoreShape> {
	if (diskStoreCache) return diskStoreCache;
	try {
		diskStoreCache = (await Bun.file(getPluginTrustStorePath()).json()) as TrustStoreShape;
	} catch (err) {
		if (!isEnoent(err)) {
			logger.debug("plugin trust store read failed", { error: String(err) });
		}
		diskStoreCache = {};
	}
	return diskStoreCache;
}

async function persistTrustDecision(trustKey: string, decision: PluginTrustDecision): Promise<void> {
	const store = await readTrustStore();
	store[trustKey] = decision;
	diskStoreCache = store;
	try {
		await Bun.write(getPluginTrustStorePath(), JSON.stringify(store, null, "\t"));
	} catch (err) {
		logger.warn("plugin trust store write failed", { error: String(err) });
	}
}

/**
 * Resolve whether `plugin` is trusted to load. Never throws — handler errors
 * degrade to "denied for this call" without caching, so a later invocation
 * (e.g. after the user fixes their terminal) can re-prompt.
 */
export async function resolvePluginTrust(plugin: { name: string; version: string }): Promise<boolean> {
	// Escape hatch for headless/CI/scripted runs where no consent handler is ever
	// registered (the default-deny branch below would otherwise silently disable
	// every installed plugin). Explicit opt-in only — mirrors PI_AUTO_QA_PUSH.
	if ($flag("PI_TRUST_ALL_PLUGINS", false)) return true;

	const trustKey = pluginTrustKey(plugin);
	const cached = cachedDecisions.get(trustKey);
	if (cached !== undefined) return cached === "granted";

	const store = await readTrustStore();
	const persisted = store[trustKey];
	if (persisted !== undefined) {
		cachedDecisions.set(trustKey, persisted);
		return persisted === "granted";
	}

	if (!trustHandler) return false;
	const inFlight = inFlightPrompts.get(trustKey);
	if (inFlight) return inFlight;

	const handler = trustHandler;
	const prompt = (async () => {
		try {
			const granted = await handler(plugin);
			if (granted === null) {
				// Dismissed (ESC/click-away): skip this call only, don't cache or persist.
				return false;
			}
			const decision: PluginTrustDecision = granted ? "granted" : "denied";
			cachedDecisions.set(trustKey, decision);
			await persistTrustDecision(trustKey, decision);
			return granted;
		} catch (err) {
			logger.warn("plugin trust handler threw", { error: String(err) });
			return false;
		} finally {
			inFlightPrompts.delete(trustKey);
		}
	})();
	inFlightPrompts.set(trustKey, prompt);
	return prompt;
}
