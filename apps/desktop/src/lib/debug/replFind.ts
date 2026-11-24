// Debug Console find (VS Code: repl.ts `repl.action.find`, the tree's find widget in highlight
// mode): every case-insensitive occurrence of the query in the shown lines, and a line split into
// plain and matched pieces for rendering. Pure.

export type ReplMatch = { line: number; start: number; end: number };

export function findInLines(lines: readonly string[], query: string): ReplMatch[] {
	if (!query) return [];
	const q = query.toLowerCase();
	const out: ReplMatch[] = [];
	lines.forEach((text, line) => {
		const lower = text.toLowerCase();
		for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) out.push({ line, start: at, end: at + q.length });
	});
	return out;
}

export type Piece = { text: string; match: number | null };

/** `text` cut at its matches; `match` is the index into the full match list (for the current one). */
export function pieces(text: string, matches: readonly ReplMatch[], line: number, firstIndex: number): Piece[] {
	const out: Piece[] = [];
	let at = 0;
	for (let i = firstIndex; i < matches.length && matches[i].line === line; i++) {
		const m = matches[i];
		if (m.start > at) out.push({ text: text.slice(at, m.start), match: null });
		out.push({ text: text.slice(m.start, m.end), match: i });
		at = m.end;
	}
	if (at < text.length || !out.length) out.push({ text: text.slice(at), match: null });
	return out;
}

/** The next (or previous) match index from `current`, wrapping; -1 without matches. */
export function stepMatch(current: number, count: number, forward: boolean): number {
	if (!count) return -1;
	if (current < 0) return forward ? 0 : count - 1;
	return (current + (forward ? 1 : count - 1)) % count;
}
