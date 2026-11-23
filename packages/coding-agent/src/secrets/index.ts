import * as path from "node:path";
import { YAML } from "bun";
import { CONFIG_DIR_NAME, isEnoent, logger } from "jeopi-utils";
import type { SecretEntry } from "./obfuscator";
import { compileSecretRegex } from "./regex";

export {
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretEntry,
	SecretObfuscator,
} from "./obfuscator";

/**
 * Load secrets from project-local and global secrets.yml files.
 * Project-local entries override global entries with matching content.
 */
export async function loadSecrets(cwd: string, agentDir: string): Promise<SecretEntry[]> {
	const projectPath = path.join(cwd, CONFIG_DIR_NAME, "secrets.yml");
	const globalPath = path.join(agentDir, "secrets.yml");

	const globalEntries = await loadSecretsFile(globalPath);
	const projectEntries = await loadSecretsFile(projectPath);

	if (globalEntries.length === 0) return projectEntries;
	if (projectEntries.length === 0) return globalEntries;

	// Merge: project overrides global by content match
	const projectContents = new Set(projectEntries.map(e => e.content));
	const merged = [...globalEntries.filter(e => !projectContents.has(e.content)), ...projectEntries];
	return merged;
}

/** Minimum env var value length to consider as a secret. */
const MIN_ENV_VALUE_LENGTH = 8;

/** Env var name patterns that indicate secret values. */
const SECRET_ENV_PATTERNS = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

/** Collect environment variable values that look like secrets. */
export function collectEnvSecrets(): SecretEntry[] {
	const entries: SecretEntry[] = [];
	const seen = new Set<string>();
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue;
		if (!SECRET_ENV_PATTERNS.test(name)) continue;
		if (seen.has(value)) continue;
		seen.add(value);
		entries.push({ type: "plain", content: value, mode: "obfuscate" });
	}
	return entries;
}

/**
 * Built-in linear-time regex patterns for deterministic PII and credential redaction.
 * Used when `secrets.redactPii` is enabled so providers, advisor transcripts, and
 * `/share` snapshots receive reversible `#HASH#` placeholders instead of raw PII/tokens.
 */
const BUILTIN_PII_PATTERNS: readonly SecretEntry[] = [
	// Private key PEM blocks
	{
		type: "regex",
		content:
			"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
		mode: "obfuscate",
	},
	// High-confidence API / cloud / VCS tokens and JWTs
	{ type: "regex", content: "\\bsk-ant-[A-Za-z0-9_-]{20,}\\b", mode: "obfuscate" },
	{ type: "regex", content: "\\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\\b", mode: "obfuscate" },
	{ type: "regex", content: "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b", mode: "obfuscate" },
	{ type: "regex", content: "\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\\b", mode: "obfuscate" },
	{ type: "regex", content: "\\bgithub_pat_[A-Za-z0-9_]{20,}\\b", mode: "obfuscate" },
	{
		type: "regex",
		content: "\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b",
		mode: "obfuscate",
	},
	// Email addresses
	{ type: "regex", content: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b", mode: "obfuscate" },
	// US SSN & Korean RRN
	{ type: "regex", content: "\\b\\d{3}-\\d{2}-\\d{4}\\b", mode: "obfuscate" },
	{ type: "regex", content: "\\b\\d{6}-[1-4]\\d{6}\\b", mode: "obfuscate" },
	// Korean mobile phone numbers
	{ type: "regex", content: "\\b01[016789]-\\d{3,4}-\\d{4}\\b", mode: "obfuscate" },
	// 16-digit payment card numbers (hyphen or space separated)
	{ type: "regex", content: "\\b(?:\\d{4}[- ]){3}\\d{4}\\b", mode: "obfuscate" },
];

/** Return built-in deterministic PII and credential redaction entries. */
export function collectBuiltinPiiPatterns(): SecretEntry[] {
	return BUILTIN_PII_PATTERNS.map(entry => ({ ...entry }));
}

async function loadSecretsFile(filePath: string): Promise<SecretEntry[]> {
	try {
		const text = await Bun.file(filePath).text();
		const raw = YAML.parse(text);
		if (!Array.isArray(raw)) {
			logger.warn("secrets.yml must be a YAML array", { path: filePath });
			return [];
		}
		const entries: SecretEntry[] = [];
		for (let i = 0; i < raw.length; i++) {
			const entry = raw[i];
			if (!validateEntry(entry, filePath, i)) continue;
			entries.push({
				type: entry.type,
				content: entry.content,
				mode: entry.mode ?? "obfuscate",
				replacement: entry.replacement,
				flags: entry.flags,
			});
		}
		return entries;
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Failed to load secrets.yml", { path: filePath, error: String(err) });
		return [];
	}
}

function validateEntry(entry: unknown, filePath: string, index: number): entry is SecretEntry {
	if (entry === null || typeof entry !== "object") {
		logger.warn(`secrets.yml[${index}]: entry must be an object`, { path: filePath });
		return false;
	}
	const e = entry as Record<string, unknown>;
	if (e.type !== "plain" && e.type !== "regex") {
		logger.warn(`secrets.yml[${index}]: type must be "plain" or "regex"`, { path: filePath });
		return false;
	}
	if (typeof e.content !== "string" || e.content.length === 0) {
		logger.warn(`secrets.yml[${index}]: content must be a non-empty string`, { path: filePath });
		return false;
	}
	if (e.mode !== undefined && e.mode !== "obfuscate" && e.mode !== "replace") {
		logger.warn(`secrets.yml[${index}]: mode must be "obfuscate" or "replace"`, { path: filePath });
		return false;
	}
	if (e.replacement !== undefined && typeof e.replacement !== "string") {
		logger.warn(`secrets.yml[${index}]: replacement must be a string`, { path: filePath });
		return false;
	}
	if (e.flags !== undefined && typeof e.flags !== "string") {
		logger.warn(`secrets.yml[${index}]: flags must be a string`, { path: filePath });
		return false;
	}
	if (e.type === "regex") {
		try {
			compileSecretRegex(e.content as string, e.flags as string | undefined);
		} catch (error) {
			logger.warn(`secrets.yml[${index}]: invalid regex pattern`, {
				path: filePath,
				pattern: e.content,
				error: String(error),
			});
			return false;
		}
	}
	return true;
}
