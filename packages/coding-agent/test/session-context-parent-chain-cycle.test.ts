/**
 * Contract: `buildSessionContext`'s leaf→root parent-chain walk must terminate
 * even when `entries`/`byId` contain a cyclic `parentId` chain (corrupt data,
 * or a bug elsewhere that lets two entries point at each other). Without a
 * `seen` guard, the walk loops forever and `path` grows unbounded — an OOM,
 * not just a hang. The sibling walks in `session-manager.ts` (`pathTo`) and
 * `session-loader.ts` (`collectActiveBranchIds`) already guard against this;
 * this test pins the same guarantee for `buildSessionContext`.
 */
import { describe, expect, it } from "bun:test";
import { buildSessionContext } from "jeopi-cli/session/session-context";
import type { SessionMessageEntry } from "jeopi-cli/session/session-entries";

function userEntry(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: text, timestamp: 0 },
	};
}

describe("buildSessionContext parent-chain cycle safety", () => {
	it("terminates instead of looping forever on a two-node parentId cycle", () => {
		// a.parentId -> b, b.parentId -> a: neither is a root, and both stay in `byId`,
		// so an unguarded `while (current)` walk never hits `undefined`.
		const a = userEntry("a", "b", "message a");
		const b = userEntry("b", "a", "message b");
		const entries = [a, b];

		const start = Date.now();
		const context = buildSessionContext(entries, "a");
		const elapsedMs = Date.now() - start;

		expect(elapsedMs).toBeLessThan(2000);
		// Both cycle members are still visited exactly once each before the guard
		// stops the walk, so the resulting context carries a bounded message list.
		expect(context.messages.length).toBeLessThanOrEqual(entries.length);
	});

	it("terminates on a longer three-node cycle reached from any entry point", () => {
		const a = userEntry("a", "c", "message a");
		const b = userEntry("b", "a", "message b");
		const c = userEntry("c", "b", "message c");
		const entries = [a, b, c];

		for (const leafId of ["a", "b", "c"]) {
			const start = Date.now();
			const context = buildSessionContext(entries, leafId);
			expect(Date.now() - start).toBeLessThan(2000);
			expect(context.messages.length).toBeLessThanOrEqual(entries.length);
		}
	});

	it("still walks a normal acyclic chain to completion", () => {
		const root = userEntry("root", null, "root message");
		const child = userEntry("child", "root", "child message");
		const leaf = userEntry("leaf", "child", "leaf message");
		const entries = [root, child, leaf];

		const context = buildSessionContext(entries, "leaf");

		expect(context.messages).toHaveLength(3);
	});
});
