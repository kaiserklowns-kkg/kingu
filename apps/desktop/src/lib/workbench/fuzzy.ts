// Quick open matcher in the spirit of VS Code's fuzzyScorer: characters must appear in order;
// consecutive runs, word starts and matches in the file name score higher.

export type Match = { score: number; positions: number[] };

const SEPARATORS = '/\\-_. ';

export function fuzzyMatch(query: string, target: string): Match | null {
	const q = query.replace(/\s+/g, '').toLowerCase();
	if (!q) return { score: 0, positions: [] };
	const t = target.toLowerCase();
	const nameStart = target.lastIndexOf('/') + 1;
	const positions: number[] = [];
	let score = 0;
	let ti = 0;
	let prev = -2;
	for (const ch of q) {
		const found = t.indexOf(ch, ti);
		if (found < 0) return null;
		let s = 1;
		if (found === prev + 1) s += 5;
		if (found === 0 || SEPARATORS.includes(target[found - 1])) s += 4;
		if (found >= nameStart) s += 2;
		if (target[found] !== t[found] && target[found] === query[positions.length]) s += 1;
		score += s;
		positions.push(found);
		prev = found;
		ti = found + 1;
	}
	// Prefer shorter paths when scores tie.
	return { score: score * 100 - target.length, positions };
}

export function rank<T>(query: string, items: T[], text: (t: T) => string, limit = 50): { item: T; match: Match }[] {
	const out: { item: T; match: Match }[] = [];
	for (const item of items) {
		const match = fuzzyMatch(query, text(item));
		if (match) out.push({ item, match });
	}
	out.sort((a, b) => b.match.score - a.match.score);
	return out.slice(0, limit);
}
