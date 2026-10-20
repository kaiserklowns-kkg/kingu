/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { count, glyphs, moveTo, parseStored, remove, setCondition, setEnabled, sourceBreakpoints, toggle } from './breakpoints.ts';

test('toggle adds and removes, keeping line order; empty files disappear', () => {
	let m = toggle({}, 'src/main.rs', 10);
	m = toggle(m, 'src/main.rs', 3);
	expect(m['src/main.rs'].map((b) => b.line)).toEqual([3, 10]);
	m = toggle(m, 'src/main.rs', 10);
	expect(m['src/main.rs']).toEqual([{ line: 3, enabled: true }]);
	m = remove(m, 'src/main.rs', 3);
	expect(m).toEqual({});
});

test('conditions, enablement and what setBreakpoints sends', () => {
	let m = toggle(toggle({}, 'a.py', 5), 'a.py', 2);
	m = setCondition(m, 'a.py', 5, ' i > 3 ');
	m = setCondition(m, 'a.py', 9, 'x');
	m = setEnabled(m, 'a.py', 2, false);
	expect(sourceBreakpoints(m['a.py'])).toEqual([{ line: 5, condition: 'i > 3' }, { line: 9, condition: 'x' }]);
	m = setCondition(m, 'a.py', 9, '');
	expect(sourceBreakpoints(m['a.py'])).toEqual([{ line: 5, condition: 'i > 3' }, { line: 9 }]);
	expect(sourceBreakpoints(undefined)).toEqual([]);
	expect(count(m)).toBe(3);
});

test('glyphs: plain without a session, verified/unverified with the adapter answer in request order', () => {
	const list = [
		{ line: 9, enabled: true },
		{ line: 2, enabled: false },
		{ line: 4, enabled: true, condition: 'n == 0' }
	];
	expect(glyphs(list, undefined).map((g) => [g.line, g.kind])).toEqual([
		[2, 'disabled'],
		[4, 'conditional'],
		[9, 'breakpoint']
	]);
	// The adapter answered for lines 4 and 9 (the enabled ones), in that order.
	const answered = glyphs(list, [{ verified: true, line: 4 }, { verified: false, message: 'No code at line 9' }]);
	expect(answered.map((g) => [g.line, g.kind, g.hover])).toEqual([
		[2, 'disabled', 'Breakpoint (disabled)'],
		[4, 'conditional', 'Condition: n == 0'],
		[9, 'unverified', 'No code at line 9']
	]);
	expect(glyphs(list, [])[2].kind).toBe('unverified');
});

test('edits move breakpoints; collisions merge', () => {
	const m = toggle(toggle(toggle({}, 'f', 1), 'f', 5), 'f', 8);
	expect(moveTo(m, 'f', [1, 5, 8])).toBe(m);
	expect(moveTo(m, 'f', [2, 6, 9])['f'].map((b) => b.line)).toEqual([2, 6, 9]);
	expect(moveTo(m, 'f', [1, 1, 3])['f'].map((b) => b.line)).toEqual([1, 3]);
	expect(moveTo(m, 'f', [1])).toBe(m);
});

test('stored breakpoints are validated', () => {
	const text = JSON.stringify({ 'a.go': [{ line: 3 }, { line: 0 }, { line: 7, enabled: false, condition: 'x' }, 'junk'], 'b.go': 'bad', 'c.go': [] });
	expect(parseStored(text)).toEqual({ 'a.go': [{ line: 3, enabled: true }, { line: 7, enabled: false, condition: 'x' }] });
	expect(parseStored('not json')).toEqual({});
	expect(parseStored(null)).toEqual({});
	expect(parseStored('[1]')).toEqual({});
});
