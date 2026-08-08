import { describe, expect, it } from "bun:test";
import { parseJsonWithRepair, parseStreamingJson, repairJson, stripLoneSurrogates } from "jeopi-utils/json-parse";

const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde00);
const isWellFormed = (s: string): boolean => {
	try {
		encodeURIComponent(s);
		return true;
	} catch {
		return false;
	}
};

describe("JSON repair", () => {
	it("leaves valid string escapes unchanged", () => {
		const json = String.raw`{"text":"quote: \" unicode: \u2028 slash: \/ newline: \n"}`;

		expect(repairJson(json)).toBe(json);
		const expectedText = ['quote: " unicode: ', String.fromCharCode(0x2028), " slash: / newline: \n"].join("");
		expect(parseJsonWithRepair<{ text: string }>(json)).toEqual({ text: expectedText });
	});

	it("escapes raw control characters inside string literals", () => {
		const json = '{"text":"a\nb\u0001c"}';

		expect(repairJson(json)).toBe(String.raw`{"text":"a\nb\u0001c"}`);
		expect(parseJsonWithRepair<{ text: string }>(json)).toEqual({ text: "a\nb\u0001c" });
	});

	it("preserves invalid simple escapes as literal backslashes", () => {
		const json = String.raw`{"value":"a\qb"}`;

		expect(repairJson(json)).toBe(String.raw`{"value":"a\\qb"}`);
		expect(parseJsonWithRepair<{ value: string }>(json)).toEqual({ value: String.raw`a\qb` });
	});
	it("returns an empty object for whitespace-only streaming JSON", () => {
		expect(parseStreamingJson<Record<string, unknown>>(" \t\n\r")).toEqual({});
	});
});

describe("parseJsonWithRepair relaxed (final) parsing", () => {
	it("accepts single-quoted strings and keys", () => {
		expect(parseJsonWithRepair<{ path: string }>("{'path': 'a.ts'}")).toEqual({ path: "a.ts" });
	});

	it("accepts unquoted object keys", () => {
		expect(parseJsonWithRepair<{ path: string; count: number }>('{path: "a.ts", count: 2}')).toEqual({
			path: "a.ts",
			count: 2,
		});
	});

	it("strips trailing and stray commas", () => {
		expect(parseJsonWithRepair<{ a: number }>('{"a":1,}')).toEqual({ a: 1 });
		expect(parseJsonWithRepair<number[]>("[1, 2, ]")).toEqual([1, 2]);
	});

	it("coerces Python literals to JSON literals", () => {
		expect(
			parseJsonWithRepair<{ ok: boolean; no: boolean; nil: null }>('{"ok": True, "no": False, "nil": None}'),
		).toEqual({
			ok: true,
			no: false,
			nil: null,
		});
	});

	it("recovers an unescaped apostrophe inside a single-quoted string", () => {
		expect(parseJsonWithRepair<{ msg: string }>("{'msg': 'it's fine'}")).toEqual({ msg: "it's fine" });
	});

	it("ignores // and /* */ comments", () => {
		expect(parseJsonWithRepair<{ a: number; b: number }>('{"a":1 /* c */, "b":2 // trailing\n}')).toEqual({
			a: 1,
			b: 2,
		});
	});

	it("does NOT swallow structure through unescaped double quotes (throws)", () => {
		expect(() => parseJsonWithRepair('{"a":"x" "b":1}')).toThrow();
	});

	it("rejects JS-only NaN / Infinity rather than executing a non-finite arg", () => {
		expect(() => parseJsonWithRepair('{"a": NaN}')).toThrow();
		expect(() => parseJsonWithRepair('{"a": Infinity}')).toThrow();
	});

	it("throws on trailing garbage after a complete value", () => {
		expect(() => parseJsonWithRepair('{"a":1} then prose')).toThrow();
	});
});

describe("parseStreamingJson partial parsing", () => {
	it("auto-closes a truncated object and string", () => {
		expect(parseStreamingJson<{ a: number }>('{"a":1')).toEqual({ a: 1 });
		expect(parseStreamingJson<{ q: string }>('{"q":"hel')).toEqual({ q: "hel" });
	});

	it("rolls back an incomplete trailing keyword to the last valid prefix", () => {
		expect(parseStreamingJson<{ a: number }>('{"a":1,"b":tru')).toEqual({ a: 1 });
		expect(parseStreamingJson<Record<string, unknown>>('{"a":tru')).toEqual({});
	});

	it("never surfaces NaN from an incomplete or non-finite number", () => {
		expect(parseStreamingJson<Record<string, unknown>>('{"a":1.5e')).toEqual({});
		expect(parseStreamingJson<Record<string, unknown>>('{"a":NaN}')).toEqual({});
		expect(parseStreamingJson<Record<string, unknown>>('{"a":Truex}')).toEqual({});
	});
});
describe("lone surrogate sanitization", () => {
	it("replaces a lone high surrogate code unit with U+FFFD", () => {
		expect(stripLoneSurrogates(`a${HIGH}b`)).toBe("a\uFFFDb");
	});

	it("replaces a lone low surrogate code unit with U+FFFD", () => {
		expect(stripLoneSurrogates(`a${LOW}b`)).toBe("a\uFFFDb");
	});

	it("preserves valid surrogate pairs (astral characters)", () => {
		const emoji = `${HIGH}${LOW}`;
		expect(stripLoneSurrogates(`x${emoji}y`)).toBe(`x${emoji}y`);
		expect(emoji).toBe("😀");
	});

	it("returns clean input unchanged (identity, no allocation path)", () => {
		const clean = "hello world 😀 done";
		expect(stripLoneSurrogates(clean)).toBe(clean);
	});

	it("sanitizes a lone surrogate carried by a raw JSON string value", () => {
		const parsed = parseJsonWithRepair<{ t: string }>(`{"t":"a${HIGH}b"}`);
		expect(parsed).toEqual({ t: "a\uFFFDb" });
		expect(isWellFormed(parsed.t)).toBe(true);
	});

	it("sanitizes a lone surrogate delivered via a \\u escape", () => {
		const parsed = parseJsonWithRepair<{ t: string }>('{"t":"a\\uD83Db"}');
		expect(parsed).toEqual({ t: "a\uFFFDb" });
		expect(isWellFormed(parsed.t)).toBe(true);
	});

	it("keeps an escaped valid surrogate pair intact", () => {
		const parsed = parseJsonWithRepair<{ t: string }>('{"t":"\\uD83D\\uDE00"}');
		expect(parsed).toEqual({ t: "😀" });
	});

	it("sanitizes lone surrogates in object keys", () => {
		const parsed = parseJsonWithRepair<Record<string, number>>(`{"k${HIGH}":1}`);
		expect(parsed).toEqual({ "k\uFFFD": 1 });
	});

	it("sanitizes a lone surrogate in a truncated streaming buffer", () => {
		const parsed = parseStreamingJson<{ t: string }>(`{"t":"a${HIGH}`);
		expect(parsed).toEqual({ t: "a\uFFFD" });
		expect(isWellFormed(parsed.t)).toBe(true);
	});
});
