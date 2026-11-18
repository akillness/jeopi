import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AgentLifecycleManager } from "jeopi-cli/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "jeopi-cli/registry/agent-registry";
import type { AgentSession } from "jeopi-cli/session/agent-session";

function makeSessionStub() {
	let disposeCount = 0;
	const stub = {
		dispose: async () => {
			disposeCount += 1;
		},
	};
	return { session: stub as unknown as AgentSession, disposeCount: () => disposeCount };
}

async function flushAsync(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("AgentLifecycleManager bounds", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("LRU-parks oldest live idle agents when maxLiveIdle is exceeded", async () => {
		const lifecycle = new AgentLifecycleManager(registry, { maxLiveIdle: 2, maxAdopted: 10 });
		const s1 = makeSessionStub();
		const s2 = makeSessionStub();
		const s3 = makeSessionStub();

		for (const [id, s] of [
			["a1", s1],
			["a2", s2],
			["a3", s3],
		] as const) {
			registry.register({
				id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				displayName: id,
				session: s.session,
				sessionFile: `/tmp/${id}.jsonl`,
			});
			registry.setStatus(id, "idle");
			lifecycle.adopt(id, { idleTtlMs: 60_000 });
		}

		await flushAsync();

		expect(registry.get("a1")?.status).toBe("parked");
		expect(registry.get("a1")?.session).toBeNull();
		expect(s1.disposeCount()).toBe(1);
		expect(registry.get("a2")?.status).toBe("idle");
		expect(registry.get("a3")?.status).toBe("idle");
		await lifecycle.dispose();
	});

	it("drops in-memory revive closure on park when persistedReviverFactory is installed", async () => {
		const lifecycle = new AgentLifecycleManager(registry, { maxLiveIdle: 2, maxAdopted: 10 });
		const s1 = makeSessionStub();
		const s1Revived = makeSessionStub();
		const inMemoryRevive = vi.fn(async () => s1Revived.session);
		const persistedFactory = vi.fn(async () => async () => s1Revived.session);
		lifecycle.setPersistedSubagentReviverFactory(persistedFactory, 60_000);

		registry.register({
			id: "a1",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			displayName: "a1",
			session: s1.session,
			sessionFile: "/tmp/a1.jsonl",
		});
		registry.setStatus("a1", "idle");
		lifecycle.adopt("a1", { idleTtlMs: 60_000, revive: inMemoryRevive });

		await lifecycle.park("a1");
		expect(registry.get("a1")?.status).toBe("parked");

		const revived = await lifecycle.ensureLive("a1");
		expect(revived).toBe(s1Revived.session);
		expect(inMemoryRevive).not.toHaveBeenCalled();
		expect(persistedFactory).toHaveBeenCalledTimes(1);
		await lifecycle.dispose();
	});

	it("releases oldest non-running adopted agents when maxAdopted is exceeded", async () => {
		const lifecycle = new AgentLifecycleManager(registry, { maxLiveIdle: 1, maxAdopted: 2 });
		for (const id of ["a1", "a2", "a3"]) {
			const s = makeSessionStub();
			registry.register({
				id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				displayName: id,
				session: s.session,
				sessionFile: `/tmp/${id}.jsonl`,
			});
			registry.setStatus(id, "idle");
			lifecycle.adopt(id, { idleTtlMs: 60_000 });
		}

		await flushAsync();

		expect(registry.get("a1")).toBeUndefined();
		expect(lifecycle.has("a1")).toBe(false);
		expect(registry.get("a2")).toBeDefined();
		expect(registry.get("a3")).toBeDefined();
		await lifecycle.dispose();
	});
});
