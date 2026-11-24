// Token matching for the jump palette (⌘J), ported from Orca's `src/shared/palette-match/*`
// (`palette-query.ts`, `match-field.ts`, `match-quality.ts`, `typo-distance.ts`,
// `worktree-palette-query-bounds.ts`). The palette's first pass is Kingu's in-order fuzzy match
// (workbench/fuzzy.ts); this is what that pass cannot find: words typed in another order or spread
// over the title and the branch, and a word that is one typo away. Pure.

/** Per-token match strength, best to worst (Orca `PALETTE_MATCH_QUALITIES`, without `compact`). */
export const PALETTE_MATCH_QUALITIES = ['field-exact', 'word-exact', 'field-prefix', 'word-prefix', 'boundary-substring', 'literal-substring', 'typo'] as const;
export type PaletteMatchQuality = (typeof PALETTE_MATCH_QUALITIES)[number];

export const PALETTE_QUERY_MAX_TOKENS = 16;
export const PALETTE_QUERY_MAX_BYTES = 2 * 1024;
export const PALETTE_TYPO_MIN_LENGTH = 4;

const LETTERS_ONLY = /^\p{L}+$/u;
const LATIN_OR_DIGIT = /^[\p{Script=Latin}\p{Nd}]$/u;
const HAS_DIGIT = /\p{N}/u;
const IDENTIFIER_PUNCTUATION = /[./#!_-]/;
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/** Case and Unicode form folded, so `É` typed either way finds `é`. */
export const normalizePaletteText = (text: string): string => text.normalize('NFC').toLowerCase();

/** One insertion, deletion or substitution apart (Orca `isWithinOnePaletteEdit`). */
export function isWithinOnePaletteEdit(a: string, b: string): boolean {
	const delta = a.length - b.length;
	if (delta > 1 || delta < -1) return false;
	if (a === b) return true;
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	let si = 0;
	let li = 0;
	let edits = 0;
	while (si < shorter.length && li < longer.length) {
		if (shorter[si] === longer[li]) {
			si++;
			li++;
			continue;
		}
		if (++edits > 1) return false;
		if (shorter.length === longer.length) si++;
		li++;
	}
	return edits + (longer.length - li) + (shorter.length - si) <= 1;
}

export type PaletteQueryToken = {
	text: string;
	/** Digit-bearing or identifier-punctuated tokens (`#12`, `v1.2`, `fix-login`) never match by typo. */
	isIdentifierLike: boolean;
	isLetterOnly: boolean;
	/** A lone Latin letter or digit may only equal or start a word. */
	isSingleLatinCharacter: boolean;
};

/**
 * The query as tokens: split on whitespace, folded, duplicates and punctuation-only tokens dropped.
 * null when it is empty, over 2 KB or has more than 16 tokens (Orca answers those with no match).
 */
export function paletteQueryTokens(query: string): PaletteQueryToken[] | null {
	if (new TextEncoder().encode(query).length > PALETTE_QUERY_MAX_BYTES) return null;
	const texts = [...new Set(normalizePaletteText(query).split(/\s+/u).filter((x) => /[\p{L}\p{N}\p{S}]/u.test(x)))];
	if (!texts.length || texts.length > PALETTE_QUERY_MAX_TOKENS) return null;
	return texts.map((text) => ({
		text,
		isIdentifierLike: HAS_DIGIT.test(text) || IDENTIFIER_PUNCTUATION.test(text),
		isLetterOnly: LETTERS_ONLY.test(text),
		isSingleLatinCharacter: LATIN_OR_DIGIT.test(text)
	}));
}

export type PaletteFieldMatch = { quality: PaletteMatchQuality; start: number; end: number };

/** How `token` matches `field` (already folded), best quality first; null when it does not. */
export function matchPaletteField(field: string, token: PaletteQueryToken): PaletteFieldMatch | null {
	const text = token.text;
	if (field === text) return { quality: 'field-exact', start: 0, end: field.length };
	const words = [...field.matchAll(WORD)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
	const exact = words.find((w) => w.text === text);
	if (exact) return { quality: 'word-exact', start: exact.start, end: exact.end };
	if (field.startsWith(text)) return { quality: 'field-prefix', start: 0, end: text.length };
	const prefix = words.find((w) => w.text.startsWith(text));
	if (prefix) return { quality: 'word-prefix', start: prefix.start, end: prefix.start + text.length };
	if (token.isSingleLatinCharacter) return null;
	const at = field.indexOf(text);
	if (at >= 0) return { quality: at === 0 || words.some((w) => w.start === at) ? 'boundary-substring' : 'literal-substring', start: at, end: at + text.length };
	if (token.isIdentifierLike || !token.isLetterOnly || text.length < PALETTE_TYPO_MIN_LENGTH) return null;
	const typo = words.find((w) => w.text.length >= PALETTE_TYPO_MIN_LENGTH && LETTERS_ONLY.test(w.text) && isWithinOnePaletteEdit(text, w.text));
	return typo ? { quality: 'typo', start: typo.start, end: typo.end } : null;
}

export type PaletteTokenMatch = {
	/** The weakest token's quality: one typo makes the whole result a fuzzy one (Orca's result class). */
	worst: PaletteMatchQuality;
	/** Higher is better; comparable only between token matches. */
	score: number;
	/** UTF-16 indexes matched in the first field, for highlighting (empty when folding changed its length). */
	positions: number[];
};

/**
 * Every token must match some field (in any order, each in whichever field matches it best; an
 * earlier field wins a tie). null when a token matches nothing.
 */
export function matchPaletteTokens(tokens: readonly PaletteQueryToken[], fields: readonly string[]): PaletteTokenMatch | null {
	const folded = fields.map(normalizePaletteText);
	const rank = (q: PaletteMatchQuality) => PALETTE_MATCH_QUALITIES.indexOf(q);
	let worst = 0;
	let total = 0;
	const positions = new Set<number>();
	for (const token of tokens) {
		let best: { match: PaletteFieldMatch; field: number } | null = null;
		folded.forEach((field, i) => {
			const match = matchPaletteField(field, token);
			if (match && (!best || rank(match.quality) < rank(best.match.quality))) best = { match, field: i };
		});
		if (!best) return null;
		const { match, field } = best as { match: PaletteFieldMatch; field: number };
		worst = Math.max(worst, rank(match.quality));
		total += rank(match.quality);
		if (field === 0 && folded[0].length === fields[0].length) for (let i = match.start; i < match.end; i++) positions.add(i);
	}
	const span = PALETTE_MATCH_QUALITIES.length;
	return { worst: PALETTE_MATCH_QUALITIES[worst], score: (span - worst) * span * PALETTE_QUERY_MAX_TOKENS - total, positions: [...positions].sort((a, b) => a - b) };
}
