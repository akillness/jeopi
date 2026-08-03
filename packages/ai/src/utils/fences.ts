/**
 * Fenced-code-block range computation shared by text scanners that must not
 * trip on markup quoted inside ``` / ~~~ blocks (harmony-leak detection,
 * leaked tool-call salvage).
 */

const FENCE_RE = /^\s*(?:```+|~~~+)/;

/** A `[start, end)` byte span covered by a fenced code block. */
export type FenceRange = readonly [number, number];

/**
 * Precompute fenced-code-block ranges once per text. Each range is a
 * [start, end) span of bytes inside any ```/~~~ fence. O(n) once instead of
 * O(n) per detected match.
 */
export function computeFenceRanges(text: string): FenceRange[] {
	const ranges: FenceRange[] = [];
	let inFence = false;
	let fenceStart = 0;
	let lineStart = 0;
	while (lineStart <= text.length) {
		const newline = text.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? text.length : newline;
		const line = text.slice(lineStart, lineEnd);
		if (FENCE_RE.test(line)) {
			if (inFence) {
				ranges.push([fenceStart, lineEnd]);
				inFence = false;
			} else {
				fenceStart = lineStart;
				inFence = true;
			}
		}
		if (newline === -1) break;
		lineStart = newline + 1;
	}
	if (inFence) ranges.push([fenceStart, text.length]);
	return ranges;
}

export function isInsideFence(ranges: readonly FenceRange[], position: number): boolean {
	for (const [start, end] of ranges) {
		if (position >= start && position < end) return true;
		if (start > position) break;
	}
	return false;
}
