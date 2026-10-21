import { expect, test } from 'bun:test';
import type { Turn } from './chatParts.ts';
import { continuable, findMatches, foldsPrompt, keepMatch, MAX_MATCHES, promptStep, quoteBlock, sideChatMessage, stepMatch, withQuote } from './chatTranscript.ts';

const plain = { caseSensitive: false, wholeWord: false, regex: false };

test('find: plain text, case folded unless Match Case', () => {
	expect(findMatches('Foo foo FOO', 'foo', plain).matches).toEqual([
		{ start: 0, end: 3 },
		{ start: 4, end: 7 },
		{ start: 8, end: 11 }
	]);
	expect(findMatches('Foo foo FOO', 'foo', { ...plain, caseSensitive: true }).matches).toEqual([{ start: 4, end: 7 }]);
	// Regex characters are literal without Use Regular Expression.
	expect(findMatches('a.b axb', 'a.b', plain).matches).toEqual([{ start: 0, end: 3 }]);
	expect(findMatches('anything', '', plain)).toEqual({ matches: [], invalid: false });
});

test('find: regex, empty matches skipped, an invalid one reported', () => {
	expect(findMatches('a1 b22 c', '\\d+', { ...plain, regex: true }).matches).toEqual([
		{ start: 1, end: 2 },
		{ start: 4, end: 6 }
	]);
	expect(findMatches('abc', 'x*', { ...plain, regex: true }).matches).toEqual([]);
	expect(findMatches('abc', '(', { ...plain, regex: true })).toEqual({ matches: [], invalid: true });
});

test('find: whole word, Thai and other letters count as word characters', () => {
	expect(findMatches('cat concat cat_ cat.', 'cat', { ...plain, wholeWord: true }).matches).toEqual([
		{ start: 0, end: 3 },
		{ start: 16, end: 19 }
	]);
	expect(findMatches('แมว แมวป่า', 'แมว', { ...plain, wholeWord: true }).matches).toEqual([{ start: 0, end: 3 }]);
	expect(findMatches('แมว แมวป่า', 'แมว', plain).matches.length).toBe(2);
});

test('find: capped at MAX_MATCHES', () => {
	expect(findMatches('a'.repeat(MAX_MATCHES + 10), 'a', plain).matches.length).toBe(MAX_MATCHES);
});

test('stepping through matches wraps; none starts at either end', () => {
	expect(stepMatch(-1, 3, 1)).toBe(0);
	expect(stepMatch(-1, 3, -1)).toBe(2);
	expect(stepMatch(2, 3, 1)).toBe(0);
	expect(stepMatch(0, 3, -1)).toBe(2);
	expect(stepMatch(1, 3, 1)).toBe(2);
	expect(stepMatch(0, 0, 1)).toBe(-1);
});

test('after the transcript changed the current match stays put by offset', () => {
	const ms = [
		{ start: 2, end: 4 },
		{ start: 10, end: 12 },
		{ start: 20, end: 22 }
	];
	expect(keepMatch(ms, null)).toBe(0);
	expect(keepMatch(ms, 10)).toBe(1);
	expect(keepMatch(ms, 11)).toBe(2);
	expect(keepMatch(ms, 50)).toBe(2);
	expect(keepMatch([], 3)).toBe(-1);
});

test('prompt navigation: next / previous request row, clamped at the ends', () => {
	const rows = [0, 300, 900];
	expect(promptStep(rows, 0, 1)).toBe(1);
	expect(promptStep(rows, 300, 1)).toBe(2);
	expect(promptStep(rows, 900, 1)).toBeNull();
	expect(promptStep(rows, 900, -1)).toBe(1);
	expect(promptStep(rows, 500, -1)).toBe(1);
	expect(promptStep(rows, 0, -1)).toBeNull();
	// Within the slack of a row counts as on it.
	expect(promptStep(rows, 301, -1)).toBe(0);
	expect(promptStep([], 0, 1)).toBeNull();
});

test('long requests fold past 8 lines or 600 characters', () => {
	expect(foldsPrompt('short')).toBe(false);
	expect(foldsPrompt(Array(8).fill('x').join('\n'))).toBe(false);
	expect(foldsPrompt(Array(9).fill('x').join('\n'))).toBe(true);
	expect(foldsPrompt('x'.repeat(600))).toBe(false);
	expect(foldsPrompt('x'.repeat(601))).toBe(true);
	expect(foldsPrompt('a\nb\nc', 2)).toBe(true);
});

test('quote: each line behind >, a blank line after; after what is typed', () => {
	expect(quoteBlock('  one\n\ntwo\r\nthree ')).toBe('> one\n>\n> two\n> three\n\n');
	expect(withQuote('', 'hi')).toBe('> hi\n\n');
	expect(withQuote('see this  \n', 'hi')).toBe('see this\n\n> hi\n\n');
	expect(sideChatMessage('the line', ' why? ')).toBe('> the line\n\nwhy?');
	expect(sideChatMessage('', 'why?')).toBe('why?');
});

const turn = (parts: Turn['parts'], done = true, request = true): Turn => ({ request: request ? { text: 'go', files: [], images: [], sent: 'go' } : null, parts, result: null, done });

test('Continue only under a stopped last turn while nothing runs', () => {
	expect(continuable([turn([{ kind: 'markdown', text: 'half' }, { kind: 'canceled' }])], false)).toBe(true);
	expect(continuable([turn([{ kind: 'canceled' }])], true)).toBe(false);
	expect(continuable([turn([{ kind: 'error', message: 'boom' }])], false)).toBe(false);
	expect(continuable([turn([{ kind: 'canceled' }]), turn([{ kind: 'markdown', text: 'ok' }])], false)).toBe(false);
	expect(continuable([turn([{ kind: 'canceled' }], true, false)], false)).toBe(false);
	expect(continuable([], false)).toBe(false);
});
