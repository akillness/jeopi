export interface Chunk {
	heading: string;
	startLine: number;
	endLine: number;
	text: string;
}
export const MAX_CHUNK = 3600;

export function chunkText(text: string): Chunk[] {
	const lines = text.split("\n");
	const out: Chunk[] = [];
	const outline: string[] = [];
	let cur: { heading: string; start: number; buf: string[] } | undefined;
	let fence = false;
	const flush = (end: number) => {
		if (!cur) return;
		const body = cur.buf.join("\n").trim();
		if (body) pushSplit(out, cur.heading, cur.start, end, cur.buf);
		cur = undefined;
	};
	lines.forEach((l, i) => {
		if (/^\s*(```|~~~)/.test(l)) fence = !fence;
		const m = !fence && /^(#{1,6})\s+(.*)$/.exec(l);
		if (m) {
			flush(i);
			const lvl = m[1]!.length;
			outline.length = lvl - 1;
			outline[lvl - 1] = m[2]!.trim();
			cur = { heading: outline.filter(Boolean).join(" > "), start: i + 1, buf: [l] };
		} else {
			cur ??= { heading: outline.filter(Boolean).join(" > ") || "(preamble)", start: i + 1, buf: [] };
			cur.buf.push(l);
		}
	});
	flush(lines.length);
	return out;
}

export const chunkMarkdown = chunkText;

function pushSplit(out: Chunk[], heading: string, start: number, end: number, buf: string[]) {
	const whole = buf.join("\n");
	if (whole.length <= MAX_CHUNK) return void out.push({ heading, startLine: start, endLine: end, text: whole });
	let part = 1,
		acc: string[] = [],
		accLen = 0,
		accStart = start;
	buf.forEach((l, i) => {
		if (accLen + l.length + 1 > MAX_CHUNK && acc.length) {
			out.push({
				heading: `${heading} (part ${part++})`,
				startLine: accStart,
				endLine: start + i - 1,
				text: acc.join("\n"),
			});
			acc = [];
			accLen = 0;
			accStart = start + i;
		}
		acc.push(l.slice(0, MAX_CHUNK));
		accLen += l.length + 1;
	});
	if (acc.length)
		out.push({ heading: `${heading} (part ${part})`, startLine: accStart, endLine: end, text: acc.join("\n") });
}
