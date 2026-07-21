import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "jeopi-cli/internal-urls";
import { getMemoryRoot } from "jeopi-cli/memories";
import { AgentRegistry } from "jeopi-cli/registry/agent-registry";
import type { AgentSession } from "jeopi-cli/session/agent-session";
import { getAgentDir, removeWithRetries, setAgentDir } from "jeopi-utils";

interface MemoryFixture {
	cwd: string;
	memoryRoot: string;
	agentDir: string;
	cleanupRoot: string;
}

async function withMemoryFixture(fn: (fixture: MemoryFixture) => Promise<void>): Promise<void> {
	const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-protocol-"));
	const previousAgentDir = getAgentDir();
	try {
		const agentDir = path.join(cleanupRoot, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		const cwd = path.join(cleanupRoot, "project");
		await fs.mkdir(cwd, { recursive: true });
		setAgentDir(agentDir);
		const memoryRoot = getMemoryRoot(agentDir, cwd);
		await fs.mkdir(memoryRoot, { recursive: true });
		AgentRegistry.global().register({
			id: "test-main",
			displayName: "test",
			kind: "main",
			session: {
				sessionManager: {
					getCwd: () => cwd,
					getArtifactsDir: () => null,
					getSessionId: () => "test",
				},
			} as unknown as AgentSession,
			sessionFile: null,
		});
		await fn({ cwd, memoryRoot, agentDir, cleanupRoot });
	} finally {
		setAgentDir(previousAgentDir);
		await removeWithRetries(cleanupRoot);
	}
}

describe("MemoryProtocolHandler", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	it("resolves memory://root to memory_summary.md", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			await Bun.write(path.join(memoryRoot, "memory_summary.md"), "summary");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root");

			expect(resource.content).toBe("summary");
			expect(resource.contentType).toBe("text/markdown");
		});
	});

	it("resolves memory://root/<path> within memory root", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			const skillPath = path.join(memoryRoot, "skills", "demo", "SKILL.md");
			await fs.mkdir(path.dirname(skillPath), { recursive: true });
			await Bun.write(skillPath, "demo skill");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root/skills/demo/SKILL.md");

			expect(resource.content).toBe("demo skill");
			expect(resource.contentType).toBe("text/markdown");
		});
	});

	it("resolves memory://root against the caller cwd when multiple sessions are live", async () => {
		const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-protocol-isolation-"));
		const previousAgentDir = getAgentDir();
		try {
			const agentDir = path.join(cleanupRoot, "agent");
			setAgentDir(agentDir);

			const firstCwd = path.join(cleanupRoot, "first-project");
			const secondCwd = path.join(cleanupRoot, "second-project");
			await fs.mkdir(firstCwd, { recursive: true });
			await fs.mkdir(secondCwd, { recursive: true });

			const firstMemoryRoot = getMemoryRoot(agentDir, firstCwd);
			const secondMemoryRoot = getMemoryRoot(agentDir, secondCwd);
			await fs.mkdir(firstMemoryRoot, { recursive: true });
			await fs.mkdir(secondMemoryRoot, { recursive: true });

			const firstSummary = "first registered session summary";
			const secondSummary = "second session cwd summary";
			await Bun.write(path.join(firstMemoryRoot, "memory_summary.md"), firstSummary);
			await Bun.write(path.join(secondMemoryRoot, "memory_summary.md"), secondSummary);

			AgentRegistry.global().register({
				id: "first-session",
				displayName: "first-session",
				kind: "main",
				session: {
					sessionManager: {
						getCwd: () => firstCwd,
						getArtifactsDir: () => null,
						getSessionId: () => "first-session",
					},
				} as unknown as AgentSession,
				sessionFile: null,
			});
			AgentRegistry.global().register({
				id: "second-session",
				displayName: "second-session",
				kind: "main",
				session: {
					sessionManager: {
						getCwd: () => secondCwd,
						getArtifactsDir: () => null,
						getSessionId: () => "second-session",
					},
				} as unknown as AgentSession,
				sessionFile: null,
			});

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root", { cwd: secondCwd });

			expect(resource.content).toBe(secondSummary);
			expect(resource.content).not.toBe(firstSummary);
		} finally {
			setAgentDir(previousAgentDir);
			await removeWithRetries(cleanupRoot);
		}
	});

	it("prefers the caller cwd memory root over earlier registered sessions", async () => {
		const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-protocol-"));
		const previousAgentDir = getAgentDir();
		try {
			const agentDir = path.join(cleanupRoot, "agent");
			await fs.mkdir(agentDir, { recursive: true });
			setAgentDir(agentDir);

			const firstCwd = path.join(cleanupRoot, "project-a");
			const secondCwd = path.join(cleanupRoot, "project-b");
			await fs.mkdir(firstCwd, { recursive: true });
			await fs.mkdir(secondCwd, { recursive: true });

			const firstMemoryRoot = getMemoryRoot(agentDir, firstCwd);
			const secondMemoryRoot = getMemoryRoot(agentDir, secondCwd);
			await fs.mkdir(firstMemoryRoot, { recursive: true });
			await fs.mkdir(secondMemoryRoot, { recursive: true });

			await Bun.write(path.join(firstMemoryRoot, "memory_summary.md"), "first session summary");
			const secondSummaryPath = path.join(secondMemoryRoot, "memory_summary.md");
			await Bun.write(secondSummaryPath, "second session summary");

			AgentRegistry.global().register({
				id: "test-first",
				displayName: "test first",
				kind: "main",
				session: {
					sessionManager: {
						getCwd: () => firstCwd,
						getArtifactsDir: () => null,
						getSessionId: () => "test-first",
					},
				} as unknown as AgentSession,
				sessionFile: null,
			});
			AgentRegistry.global().register({
				id: "test-second",
				displayName: "test second",
				kind: "main",
				session: {
					sessionManager: {
						getCwd: () => secondCwd,
						getArtifactsDir: () => null,
						getSessionId: () => "test-second",
					},
				} as unknown as AgentSession,
				sessionFile: null,
			});

			const resource = await InternalUrlRouter.instance().resolve("memory://root/memory_summary.md", {
				cwd: secondCwd,
			});

			expect(resource.content).toBe("second session summary");
			expect(resource.sourcePath).toBe(await fs.realpath(secondSummaryPath));
		} finally {
			setAgentDir(previousAgentDir);
			await removeWithRetries(cleanupRoot);
		}
	});

	it("throws for unknown memory namespace", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://other/memory_summary.md")).rejects.toThrow(
				"Unknown memory namespace: other. Supported: root",
			);
		});
	});

	it("blocks path traversal attempts", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root/../secret.md")).rejects.toThrow(
				"Path traversal (..) is not allowed in memory:// URLs",
			);
			await expect(router.resolve("memory://root/%2E%2E/secret.md")).rejects.toThrow(
				"Path traversal (..) is not allowed in memory:// URLs",
			);
		});
	});

	it("throws clear error for missing files", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root/missing.md")).rejects.toThrow(
				"Memory file not found: memory://root/missing.md",
			);
		});
	});

	it("blocks symlink escapes outside memory root", async () => {
		if (process.platform === "win32") return;

		await withMemoryFixture(async ({ memoryRoot, cleanupRoot }) => {
			const outsideDir = path.join(cleanupRoot, "outside");
			await fs.mkdir(outsideDir, { recursive: true });
			await Bun.write(path.join(outsideDir, "secret.md"), "secret");
			await fs.symlink(outsideDir, path.join(memoryRoot, "linked"));

			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root/linked/secret.md")).rejects.toThrow(
				"memory:// URL escapes memory root",
			);
		});
	});
});
