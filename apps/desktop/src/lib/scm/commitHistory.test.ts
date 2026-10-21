import { describe, expect, test } from 'bun:test';
import { addEntry, caretAllows, freshCursor, HISTORY_MAX, step } from './commitHistory';

describe('commit message history', () => {
	test('adds messages newest last, once, up to the limit', () => {
		expect(addEntry([], '  fix  ')).toEqual(['fix']);
		expect(addEntry(['a', 'b'], 'a')).toEqual(['b', 'a']);
		expect(addEntry(['a'], '   ')).toEqual(['a']);
		const full = Array.from({ length: HISTORY_MAX }, (_, i) => `m${i}`);
		expect(addEntry(full, 'new')).toEqual([...full.slice(1), 'new']);
	});

	test('↑ walks back from the draft, ↓ forward and back to the draft', () => {
		const entries = ['first', 'second'];
		const up1 = step(entries, freshCursor(), 'draft', -1)!;
		expect(up1.value).toBe('second');
		const up2 = step(entries, up1.cursor, up1.value, -1)!;
		expect(up2.value).toBe('first');
		expect(step(entries, up2.cursor, up2.value, -1)).toBeNull();
		const down1 = step(entries, up2.cursor, up2.value, 1)!;
		expect(down1.value).toBe('second');
		const down2 = step(entries, down1.cursor, down1.value, 1)!;
		expect(down2).toEqual({ cursor: freshCursor(), value: 'draft' });
		expect(step(entries, freshCursor(), 'x', 1)).toBeNull();
		expect(step([], freshCursor(), 'x', -1)).toBeNull();
	});

	test('only on the first line for ↑ and the last line for ↓', () => {
		expect(caretAllows('one\ntwo', 2, -1)).toBe(true);
		expect(caretAllows('one\ntwo', 5, -1)).toBe(false);
		expect(caretAllows('one\ntwo', 5, 1)).toBe(true);
		expect(caretAllows('one\ntwo', 2, 1)).toBe(false);
	});
});
