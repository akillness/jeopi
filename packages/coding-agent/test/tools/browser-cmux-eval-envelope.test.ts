import { describe, expect, it } from "bun:test";
import { serializeEvalWithEnvelope, unwrapEvalEnvelope } from "jeopi-cli/tools/browser/cmux/rpc";
import { ToolError } from "jeopi-cli/tools/tool-errors";

// biome-ignore lint/security/noGlobalEval: exercising the daemon-side eval envelope in-process
const indirectEval = globalThis.eval;

function runEnvelope<T>(fn: string | ((...args: unknown[]) => unknown), args: unknown[] = []): T {
	const script = serializeEvalWithEnvelope(fn, args);
	const value: unknown = indirectEval(script);
	return unwrapEvalEnvelope<T>(value, "test");
}

function throwBoom(): never {
	throw new Error("boom");
}

describe("cmux eval envelope", () => {
	it("returns the plain value on success", () => {
		expect(runEnvelope<number>(() => 1 + 1)).toBe(2);
	});

	it("maps undefined results to null and back", () => {
		expect(runEnvelope<undefined>(() => undefined)).toBeNull();
	});

	it("rethrows a page-side exception with its message in a ToolError", () => {
		expect(() => runEnvelope(throwBoom)).toThrow(ToolError);
		try {
			runEnvelope(throwBoom);
			throw new Error("expected runEnvelope to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ToolError);
			expect((error as ToolError).message).toContain("boom");
			expect((error as ToolError).message).toContain("threw a JavaScript exception");
		}
	});

	it("rejects a Promise return with an actionable error instead of an unsupported-type failure", () => {
		const returnPromise = () => Promise.resolve(1);
		expect(() => runEnvelope(returnPromise)).toThrow(ToolError);
		try {
			runEnvelope(returnPromise);
			throw new Error("expected runEnvelope to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ToolError);
			expect((error as ToolError).message).toContain("returned a Promise");
			expect((error as ToolError).message).toContain("evaluates synchronously");
		}
	});

	it("unwrapEvalEnvelope passes through values from daemons that skipped the wrapper", () => {
		expect(unwrapEvalEnvelope<number>(42, "test")).toBe(42);
		expect(unwrapEvalEnvelope<string>("plain", "test")).toBe("plain");
	});
});
