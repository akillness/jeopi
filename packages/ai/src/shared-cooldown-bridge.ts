import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SharedCooldownRecord {
	blockedUntil: number;
	reason?: string;
	source: "jeo-code" | "jeopi";
}

interface SharedCooldownFile {
	version: 1;
	updatedAt: number;
	cooldowns: Record<string, SharedCooldownRecord>;
}

const CANONICAL_PROVIDER_MAP: Record<string, string> = {
	anthropic: "anthropic",
	openai: "openai",
	"openai-codex": "openai",
	antigravity: "antigravity",
	"google-antigravity": "antigravity",
	gemini: "gemini",
	"google-gemini-cli": "gemini",
};

export function canonicalSharedProvider(provider: string): string {
	return CANONICAL_PROVIDER_MAP[provider.toLowerCase()] ?? provider.toLowerCase();
}

export function resolveSharedCooldownPath(): string {
	return (
		process.env.JEO_SHARED_AUTH_POOL_PATH?.trim() ||
		path.join(os.homedir(), ".agents", "auth-pool", "cooldowns.json")
	);
}

export function shouldEnableSharedCooldown(dbPath?: string): boolean {
	if (process.env.JEO_SHARED_AUTH_POOL_PATH?.trim()) return true;
	if (!dbPath || dbPath === ":memory:") return false;
	const resolved = path.resolve(dbPath);
	const jeopiRoot = path.resolve(path.join(os.homedir(), ".jeopi"));
	return resolved === jeopiRoot || resolved.startsWith(`${jeopiRoot}${path.sep}`);
}

function hashToken(value: string): string {
	return createHash("sha256").update(value.trim()).digest("hex").slice(0, 16);
}

export function sharedCredentialIdentityKey(cred: {
	type?: string;
	email?: unknown;
	accountId?: unknown;
	refresh?: unknown;
	access?: unknown;
}): string | null {
	if (cred.type !== "oauth") return null;
	if (typeof cred.email === "string" && cred.email.trim()) {
		return `email:${cred.email.trim().toLowerCase()}`;
	}
	if (typeof cred.accountId === "string" && cred.accountId.trim()) {
		return `account:${cred.accountId.trim().toLowerCase()}`;
	}
	if (typeof cred.refresh === "string" && cred.refresh.trim()) {
		return `tok:${hashToken(cred.refresh)}`;
	}
	if (typeof cred.access === "string" && cred.access.trim()) {
		return `tok:${hashToken(cred.access)}`;
	}
	return null;
}

function readSharedFile(): SharedCooldownFile {
	const filePath = resolveSharedCooldownPath();
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as Partial<SharedCooldownFile>;
		if (parsed && parsed.version === 1 && parsed.cooldowns && typeof parsed.cooldowns === "object") {
			const now = Date.now();
			const active: Record<string, SharedCooldownRecord> = {};
			for (const [k, rec] of Object.entries(parsed.cooldowns)) {
				if (
					rec &&
					typeof rec.blockedUntil === "number" &&
					Number.isFinite(rec.blockedUntil) &&
					rec.blockedUntil > now
				) {
					active[k] = {
						blockedUntil: rec.blockedUntil,
						...(typeof rec.reason === "string" ? { reason: rec.reason } : {}),
						source: rec.source === "jeo-code" ? "jeo-code" : "jeopi",
					};
				}
			}
			return { version: 1, updatedAt: parsed.updatedAt ?? now, cooldowns: active };
		}
	} catch {
		// Missing or malformed file starts clean.
	}
	return { version: 1, updatedAt: Date.now(), cooldowns: {} };
}

function writeSharedFile(data: SharedCooldownFile): void {
	const filePath = resolveSharedCooldownPath();
	const dir = path.dirname(filePath);
	const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
		try {
			fs.chmodSync(tmpPath, 0o600);
		} catch {}
		fs.renameSync(tmpPath, filePath);
	} catch {
		try {
			fs.unlinkSync(tmpPath);
		} catch {}
	}
}

export function lookupSharedCredentialCooldown(
	provider: string,
	cred: { type?: string; email?: unknown; accountId?: unknown; refresh?: unknown; access?: unknown } | undefined,
): number | undefined {
	if (!cred) return undefined;
	const ident = sharedCredentialIdentityKey(cred);
	if (!ident) return undefined;
	const key = `${canonicalSharedProvider(provider)}:${ident}`;
	const rec = readSharedFile().cooldowns[key];
	if (!rec || rec.blockedUntil <= Date.now()) return undefined;
	return rec.blockedUntil;
}

export function recordSharedCredentialCooldown(
	provider: string,
	cred: { type?: string; email?: unknown; accountId?: unknown; refresh?: unknown; access?: unknown } | undefined,
	blockedUntil: number,
	reason?: string,
): void {
	if (!cred || !Number.isFinite(blockedUntil) || blockedUntil <= Date.now()) return;
	const ident = sharedCredentialIdentityKey(cred);
	if (!ident) return;
	const key = `${canonicalSharedProvider(provider)}:${ident}`;
	const data = readSharedFile();
	const existing = data.cooldowns[key];
	const mergedUntil = existing ? Math.max(existing.blockedUntil, blockedUntil) : blockedUntil;
	data.cooldowns[key] = {
		blockedUntil: mergedUntil,
		...(reason ? { reason } : existing?.reason ? { reason: existing.reason } : {}),
		source: "jeopi",
	};
	data.updatedAt = Date.now();
	writeSharedFile(data);
}
