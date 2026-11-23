import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "jeopi-ai";
import { getBundledModel } from "jeopi-catalog/models";
import { ModelRegistry } from "jeopi-cli/config/model-registry";
import { Settings } from "jeopi-cli/config/settings";
import { createAgentSession } from "jeopi-cli/sdk";
import { collectBuiltinPiiPatterns, SecretObfuscator } from "jeopi-cli/secrets";
import { SessionManager } from "jeopi-cli/session/session-manager";
import { getAgentDir, removeSyncWithRetries, Snowflake, setAgentDir } from "jeopi-utils";

const PLACEHOLDER_RE = /#[A-Z0-9]{4}#/;

const SENSITIVE_SAMPLES: ReadonlyArray<{ label: string; secret: string; wrapper: (value: string) => string }> = [
	{
		label: "email address",
		secret: "alice.dev+tag@example.com",
		wrapper: value => `Contact ${value} for billing updates.`,
	},
	{
		label: "US SSN",
		secret: "123-45-6789",
		wrapper: value => `Taxpayer SSN: ${value} (verified)`,
	},
	{
		label: "Korean RRN (1900s)",
		secret: "900101-1234567",
		wrapper: value => `Resident ID ${value} submitted`,
	},
	{
		label: "Korean RRN (2000s)",
		secret: "020505-4123456",
		wrapper: value => `Resident ID ${value} submitted`,
	},
	{
		label: "Korean mobile phone (010, 4-digit middle)",
		secret: "010-1234-5678",
		wrapper: value => `Call ${value} immediately`,
	},
	{
		label: "Korean mobile phone (011, 3-digit middle)",
		secret: "011-234-5678",
		wrapper: value => `Legacy mobile ${value}`,
	},
	{
		label: "16-digit card number (hyphenated)",
		secret: "4111-2222-3333-4444",
		wrapper: value => `Card ending in ${value} charged`,
	},
	{
		label: "16-digit card number (space-separated)",
		secret: "5500 0000 0000 0004",
		wrapper: value => `Payment card: ${value}`,
	},
	{
		label: "PEM PKCS#8 private key",
		secret: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj\n-----END PRIVATE KEY-----",
		wrapper: value => `key.pem:\n${value}\n# end`,
	},
	{
		label: "PEM RSA private key",
		secret: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtestkeybody1234567890\n-----END RSA PRIVATE KEY-----",
		wrapper: value => `rsa:\n${value}\ndone`,
	},
	{
		label: "Anthropic API token (sk-ant)",
		secret: "sk-ant-testplaceholder0123456789",
		wrapper: value => `ANTHROPIC_API_KEY=${value}`,
	},
	{
		label: "OpenAI project token (sk-proj)",
		secret: "sk-proj-testplaceholder0123456789",
		wrapper: value => `OPENAI_API_KEY=${value}`,
	},
	{
		label: "AWS access key (AKIA)",
		secret: "AKIA0123456789ABCDEF",
		wrapper: value => `aws_access_key_id = ${value}`,
	},
	{
		label: "GitHub personal access token (ghp_)",
		secret: "ghp_TestPlaceholder0123456789",
		wrapper: value => `Authorization: Bearer ${value}`,
	},
	{
		label: "GitHub fine-grained token (github_pat_)",
		secret: "github_pat_TestPlaceholder0123456789",
		wrapper: value => `token=${value}`,
	},
	{
		label: "JWT",
		secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.testSignaturePayload0123456789",
		wrapper: value => `jwt: ${value}`,
	},
];

describe("collectBuiltinPiiPatterns + SecretObfuscator", () => {
	it("reversibly obfuscates and deobfuscates all built-in PII and high-confidence token categories", () => {
		const obfuscator = new SecretObfuscator(collectBuiltinPiiPatterns());
		expect(obfuscator.hasSecrets()).toBe(true);

		for (const { label, secret, wrapper } of SENSITIVE_SAMPLES) {
			const original = wrapper(secret);
			const obfuscated = obfuscator.obfuscate(original);
			expect(obfuscated, `${label} should be redacted`).not.toContain(secret);
			expect(obfuscated, `${label} should emit a #HASH# placeholder`).toMatch(PLACEHOLDER_RE);
			expect(obfuscator.deobfuscate(obfuscated), `${label} should round-trip losslessly`).toBe(original);
		}
	});

	it("leaves ordinary code, identifiers, dates, versions, UUIDs, and non-matching numbers untouched", () => {
		const obfuscator = new SecretObfuscator(collectBuiltinPiiPatterns());
		const benignSamples = [
			"const release = 'v1.23.4'; const date = '2026-11-23';",
			"uuid=550e8400-e29b-41d4-a716-446655440000",
			"function fetchUser(id: number): Promise<string> { return fetch(`/api/users/${id}`).then(r => r.text()); }",
			"short token prefix sk-short and git sha 9f86d081884c7d659a2feaa0c55ad015",
			"non-RRN digits 900101-9234567 and landline 02-1234-5678 and 12-digit 1234-5678-9012",
			"https://docs.example.com/v2/guide#section-3",
		];

		for (const sample of benignSamples) {
			expect(obfuscator.obfuscate(sample)).toBe(sample);
		}
	});

	it("returns fresh entry copies on every collectBuiltinPiiPatterns() call", () => {
		const first = collectBuiltinPiiPatterns();
		expect(first.length).toBeGreaterThan(0);
		first[0]!.content = "mutated";

		const second = collectBuiltinPiiPatterns();
		expect(second[0]!.content).not.toBe("mutated");
	});
});

describe("createAgentSession secrets.redactPii wiring", () => {
	let registryDir: string;
	let tempDir: string;
	let isolatedHome: string;
	let originalAgentDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-pii-registry-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		isolatedHome = path.join(os.tmpdir(), `pi-sdk-pii-home-${Snowflake.next()}`);
		fs.mkdirSync(isolatedHome, { recursive: true });
		originalAgentDir = getAgentDir();
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		for (const dir of [registryDir, isolatedHome]) {
			if (dir && fs.existsSync(dir)) {
				removeSyncWithRetries(dir);
			}
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-pii-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		setAgentDir(tempDir);
		spyOn(os, "homedir").mockReturnValue(isolatedHome);
	});

	afterEach(() => {
		setAgentDir(originalAgentDir);
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		mock.restore();
	});

	const baseSessionOptions = (settings: Settings) => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		skipPythonPreflight: true,
		enableMCP: false,
		hasUI: false,
		toolNames: ["read"],
	});

	it("populates session.obfuscator when secrets.redactPii is true even with secrets.enabled false", async () => {
		const { session } = await createAgentSession(
			baseSessionOptions(Settings.isolated({ "secrets.enabled": false, "secrets.redactPii": true })),
		);
		try {
			expect(session.obfuscator).toBeDefined();
			expect(session.obfuscator!.hasSecrets()).toBe(true);

			const raw = "Email alice@example.com with key sk-ant-testplaceholder0123456789";
			const obfuscated = session.obfuscator!.obfuscate(raw);
			expect(obfuscated).not.toContain("alice@example.com");
			expect(obfuscated).not.toContain("sk-ant-testplaceholder0123456789");
			expect(session.obfuscator!.deobfuscate(obfuscated)).toBe(raw);
		} finally {
			await session.dispose();
		}
	});

	it("leaves session.obfuscator undefined when secrets.enabled is false and secrets.redactPii is off", async () => {
		const { session: defaultSession } = await createAgentSession(
			baseSessionOptions(Settings.isolated({ "secrets.enabled": false })),
		);
		try {
			expect(defaultSession.obfuscator).toBeUndefined();
		} finally {
			await defaultSession.dispose();
		}

		const { session: explicitOffSession } = await createAgentSession(
			baseSessionOptions(Settings.isolated({ "secrets.enabled": false, "secrets.redactPii": false })),
		);
		try {
			expect(explicitOffSession.obfuscator).toBeUndefined();
		} finally {
			await explicitOffSession.dispose();
		}
	});
});
