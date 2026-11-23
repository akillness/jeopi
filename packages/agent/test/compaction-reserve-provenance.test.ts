import { describe, expect, it } from "bun:test";
import type { CompactionSettings } from "jeopi-agent-core/compaction/compaction";
import {
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_MAX_AUTO_COMPACT_THRESHOLD_TOKENS,
	DEFAULT_RESERVE_TOKENS,
	effectiveReserveTokens,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	shouldCompact,
} from "jeopi-agent-core/compaction/compaction";

describe("compaction reserve provenance", () => {
	it("honors an explicit reserve equal to the default on a small window", () => {
		// cw=19000: proportional would be floor(19000*0.15)=2850, but the reserve
		// was explicitly configured — even though it equals DEFAULT_RESERVE_TOKENS,
		// provenance says "user chose this", so it must win.
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		};
		const cw = 19000;
		expect(effectiveReserveTokens(cw, settings)).toBe(16384);
		expect(resolveBudgetReserveTokens(cw, settings)).toBe(16384);
		expect(resolveThresholdTokens(cw, settings)).toBe(2616); // 19000 - 16384
		expect(shouldCompact(2616, cw, settings)).toBe(false);
		expect(shouldCompact(2617, cw, settings)).toBe(true);
	});

	it("replaces a defaulted reserve with the proportional fallback on the same window", () => {
		// Identical window, but reserveTokens is unset: 16384 >= 19000 - 2850, so
		// the defaulted reserve is effectively impossible and the 15% proportional
		// reserve (2850) takes over.
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			keepRecentTokens: 20000,
		};
		const cw = 19000;
		expect(effectiveReserveTokens(cw, settings)).toBe(16384);
		expect(resolveBudgetReserveTokens(cw, settings)).toBe(2850); // floor(19000 * 0.15)
		expect(resolveThresholdTokens(cw, settings)).toBe(16150); // 19000 - 2850
		expect(shouldCompact(16150, cw, settings)).toBe(false);
		expect(shouldCompact(16151, cw, settings)).toBe(true);
	});

	it("keeps defaulted provenance when spreading DEFAULT_COMPACTION_SETTINGS", () => {
		// Spreading the defaults must not materialize reserveTokens; the spread
		// settings behave exactly like the omitted-field literal above.
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, thresholdPercent: -1 };
		const cw = 19000;
		expect(settings.reserveTokens).toBeUndefined();
		expect(resolveBudgetReserveTokens(cw, settings)).toBe(2850);
		expect(resolveThresholdTokens(cw, settings)).toBe(16150);
		expect(shouldCompact(16150, cw, settings)).toBe(false);
		expect(shouldCompact(16151, cw, settings)).toBe(true);
	});

	it("clamps the proportional fallback to >= 1 and the threshold below the window on tiny windows", () => {
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			keepRecentTokens: 20000,
		};
		for (let cw = 1; cw <= 10; cw++) {
			expect(resolveBudgetReserveTokens(cw, settings)).toBeGreaterThanOrEqual(1);
			expect(resolveThresholdTokens(cw, settings)).toBeLessThan(cw);
		}
		// Spot checks: floor(6 * 0.15) = 0 clamps to 1; threshold stays at cw - 1.
		expect(resolveBudgetReserveTokens(6, settings)).toBe(1);
		expect(resolveThresholdTokens(6, settings)).toBe(5);
		// Degenerate single-token window: reserve 1, threshold 0 (still < cw).
		expect(resolveBudgetReserveTokens(1, settings)).toBe(1);
		expect(resolveThresholdTokens(1, settings)).toBe(0);
	});

	it("recovers an explicit reserve that exceeds the window to the proportional reserve", () => {
		// reserveExceedsWindow applies regardless of provenance: an explicit 90000
		// on cw=16385 is impossible, so the budget falls back to floor(16385*0.15).
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			reserveTokens: 90000,
			keepRecentTokens: 20000,
		};
		const cw = 16385;
		expect(effectiveReserveTokens(cw, settings)).toBe(90000);
		expect(resolveBudgetReserveTokens(cw, settings)).toBe(2457); // floor(16385 * 0.15)
	});

	it("exposes defaulted provenance through the public constants", () => {
		// The fix rides on reserveTokens being ABSENT from the defaults: presence
		// of the field is the provenance signal, not its value.
		expect(DEFAULT_COMPACTION_SETTINGS.reserveTokens).toBeUndefined();
		expect(DEFAULT_RESERVE_TOKENS).toBe(16384);
	});
});

describe("default auto-compaction ceiling", () => {
	it("caps fully defaulted 1M-window auto-compaction threshold at 180K while leaving 200K windows at 170K", () => {
		const defaulted: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			thresholdTokens: -1,
			keepRecentTokens: 20000,
		};

		expect(resolveThresholdTokens(1_000_000, defaulted)).toBe(DEFAULT_MAX_AUTO_COMPACT_THRESHOLD_TOKENS);
		expect(resolveThresholdTokens(1_000_000, defaulted)).toBe(180_000);
		expect(shouldCompact(180_000, 1_000_000, defaulted)).toBe(false);
		expect(shouldCompact(180_001, 1_000_000, defaulted)).toBe(true);

		// Spread of DEFAULT_COMPACTION_SETTINGS preserves the same defaulted provenance.
		expect(resolveThresholdTokens(1_000_000, { ...DEFAULT_COMPACTION_SETTINGS })).toBe(180_000);

		// 200K window: 200_000 - floor(200_000 * 0.15) = 170_000, below the 180K ceiling so unaffected.
		expect(resolveThresholdTokens(200_000, defaulted)).toBe(170_000);
		expect(shouldCompact(170_000, 200_000, defaulted)).toBe(false);
		expect(shouldCompact(170_001, 200_000, defaulted)).toBe(true);
	});

	it("bypasses the 180K default ceiling when thresholdPercent, thresholdTokens, or reserveTokens is explicitly configured", () => {
		const cw = 1_000_000;
		const base: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			thresholdTokens: -1,
			keepRecentTokens: 20000,
		};

		// Explicit thresholdPercent bypasses the ceiling.
		expect(resolveThresholdTokens(cw, { ...base, thresholdPercent: 80 })).toBe(800_000);
		expect(shouldCompact(500_000, cw, { ...base, thresholdPercent: 80 })).toBe(false);
		expect(shouldCompact(800_001, cw, { ...base, thresholdPercent: 80 })).toBe(true);

		// Explicit thresholdTokens bypasses the ceiling.
		expect(resolveThresholdTokens(cw, { ...base, thresholdTokens: 500_000 })).toBe(500_000);
		expect(shouldCompact(500_000, cw, { ...base, thresholdTokens: 500_000 })).toBe(false);
		expect(shouldCompact(500_001, cw, { ...base, thresholdTokens: 500_000 })).toBe(true);

		// Explicit reserveTokens — even equal to DEFAULT_RESERVE_TOKENS — signals user ownership and bypasses the ceiling.
		expect(resolveThresholdTokens(cw, { ...base, reserveTokens: DEFAULT_RESERVE_TOKENS })).toBe(850_000);
		expect(resolveThresholdTokens(cw, { ...base, reserveTokens: 200_000 })).toBe(800_000);
		expect(shouldCompact(799_999, cw, { ...base, reserveTokens: 200_000 })).toBe(false);
		expect(shouldCompact(800_001, cw, { ...base, reserveTokens: 200_000 })).toBe(true);
	});
});
