import { describe, expect, test } from 'bun:test';
import { isWithinOnePaletteEdit, matchPaletteField, normalizePaletteText, matchPaletteTokens, paletteQueryTokens, PALETTE_QUERY_MAX_BYTES, PALETTE_QUERY_MAX_TOKENS } from './paletteMatch';

const token = (text: string) => paletteQueryTokens(text)![0];
const quality = (field: string, query: string) => matchPaletteField(normalizePaletteText(field), token(query))?.quality ?? null;

describe('palette query tokens (Orca palette-query.ts)', () => {
	test('split on whitespace, folded, without duplicates or punctuation-only tokens', () => {
		expect(paletteQueryTokens('  Fix  LOGIN fix -- ')!.map((t) => t.text)).toEqual(['fix', 'login']);
		expect(paletteQueryTokens('')).toBeNull();
		expect(paletteQueryTokens(' - / ')).toBeNull();
	});

	test('a query that is too large or has too many tokens matches nothing', () => {
		expect(paletteQueryTokens('x'.repeat(PALETTE_QUERY_MAX_BYTES + 1))).toBeNull();
		expect(paletteQueryTokens('x'.repeat(PALETTE_QUERY_MAX_BYTES))).not.toBeNull();
		expect(paletteQueryTokens(Array.from({ length: PALETTE_QUERY_MAX_TOKENS + 1 }, (_, i) => `t${i}`).join(' '))).toBeNull();
	});

	test('identifier-like and single-character tokens are marked', () => {
		expect(token('v1.2').isIdentifierLike).toBe(true);
		expect(token('fix-login').isIdentifierLike).toBe(true);
		expect(token('login')).toMatchObject({ isIdentifierLike: false, isLetterOnly: true, isSingleLatinCharacter: false });
		expect(token('a').isSingleLatinCharacter).toBe(true);
	});
});

describe('palette field match (Orca match-field.ts)', () => {
	test('qualities from exact to typo', () => {
		expect(quality('login', 'login')).toBe('field-exact');
		expect(quality('fix login page', 'login')).toBe('word-exact');
		expect(quality('login page', 'log')).toBe('field-prefix');
		expect(quality('fix login', 'log')).toBe('word-prefix');
		expect(quality('fix relogin', 'login')).toBe('literal-substring');
		expect(quality('fix login', 'logon')).toBe('typo');
		expect(quality('fix login', 'cache')).toBeNull();
	});

	test('a lone letter only equals or starts a word', () => {
		expect(quality('fix login', 'l')).toBe('word-prefix');
		expect(quality('fix login', 'g')).toBeNull();
	});

	test('typos need letter-only words of four or more characters, one edit apart', () => {
		expect(isWithinOnePaletteEdit('login', 'logn')).toBe(true);
		expect(isWithinOnePaletteEdit('login', 'lgoin')).toBe(false);
		expect(isWithinOnePaletteEdit('login', 'logins!')).toBe(false);
		expect(quality('fix bug', 'bag')).toBeNull();
		expect(quality('release v124', 'v123')).toBeNull();
		expect(quality('fix login', 'lugon')).toBeNull();
	});

	test('case and Unicode form do not matter', () => {
		expect(quality('Café menu', 'CAFÉ')).toBe('word-exact');
	});
});

describe('palette token match', () => {
	const tokens = (q: string) => paletteQueryTokens(q)!;

	test('tokens match in any order and across fields', () => {
		expect(matchPaletteTokens(tokens('login fix'), ['Fix login', 'kingu/fix-login'])?.worst).toBe('word-exact');
		expect(matchPaletteTokens(tokens('cache kingu'), ['Warm the cache', 'kingu/warm'])?.worst).toBe('word-exact');
		expect(matchPaletteTokens(tokens('cache zzz'), ['Warm the cache', 'kingu/warm'])).toBeNull();
	});

	test('the weakest token decides, and a better match scores higher', () => {
		const exact = matchPaletteTokens(tokens('fix login'), ['Fix login'])!;
		const typo = matchPaletteTokens(tokens('fix logon'), ['Fix login'])!;
		expect([exact.worst, typo.worst]).toEqual(['word-exact', 'typo']);
		expect(exact.score).toBeGreaterThan(typo.score);
		expect(matchPaletteTokens(tokens('log'), ['Fix login'])!.score).toBeGreaterThan(typo.score);
	});

	test('positions cover what matched in the first field only', () => {
		expect(matchPaletteTokens(tokens('login fix'), ['Fix login', 'main'])!.positions).toEqual([0, 1, 2, 4, 5, 6, 7, 8]);
		expect(matchPaletteTokens(tokens('main'), ['Fix login', 'main'])!.positions).toEqual([]);
	});
});
