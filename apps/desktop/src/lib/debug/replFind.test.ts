import { expect, test } from 'bun:test';
import { findInLines, pieces, stepMatch } from './replFind.ts';

test('finds every occurrence, case-insensitively, without overlaps', () => {
	expect(findInLines(['Error: x', 'no', 'error error'], 'error')).toEqual([
		{ line: 0, start: 0, end: 5 },
		{ line: 2, start: 0, end: 5 },
		{ line: 2, start: 6, end: 11 }
	]);
	expect(findInLines(['aaaa'], 'aa')).toHaveLength(2);
	expect(findInLines(['x'], '')).toEqual([]);
});

test('cuts a line at its matches', () => {
	const m = findInLines(['a', 'say hi, hi!'], 'hi');
	expect(pieces('say hi, hi!', m, 1, 0)).toEqual([
		{ text: 'say ', match: null },
		{ text: 'hi', match: 0 },
		{ text: ', ', match: null },
		{ text: 'hi', match: 1 },
		{ text: '!', match: null }
	]);
	expect(pieces('plain', [], 0, 0)).toEqual([{ text: 'plain', match: null }]);
	expect(pieces('', [], 0, 0)).toEqual([{ text: '', match: null }]);
});

test('steps through matches with wrap-around', () => {
	expect(stepMatch(-1, 3, true)).toBe(0);
	expect(stepMatch(-1, 3, false)).toBe(2);
	expect(stepMatch(2, 3, true)).toBe(0);
	expect(stepMatch(0, 3, false)).toBe(2);
	expect(stepMatch(0, 0, true)).toBe(-1);
});
