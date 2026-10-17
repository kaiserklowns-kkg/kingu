/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { NavigationHistory } from './navigation';

const at = (path: string, line: number, column = 1) => ({ path, line, column });

describe('NavigationHistory', () => {
	test('starts empty with nothing to go back or forward to', () => {
		const h = new NavigationHistory();
		expect(h.canGoBack).toBe(false);
		expect(h.canGoForward).toBe(false);
		expect(h.back()).toBeNull();
		expect(h.forward()).toBeNull();
	});

	test('a file switch or a large jump adds an entry; back and forward walk them', () => {
		const h = new NavigationHistory();
		expect(h.record(at('a.ts', 1))).toBe(true);
		expect(h.record(at('b.ts', 5))).toBe(true);
		expect(h.record(at('b.ts', 200))).toBe(true);
		expect(h.entries.length).toBe(3);
		expect(h.back()).toEqual(at('b.ts', 5));
		expect(h.back()).toEqual(at('a.ts', 1));
		expect(h.canGoBack).toBe(false);
		expect(h.back()).toBeNull();
		expect(h.forward()).toEqual(at('b.ts', 5));
		expect(h.forward()).toEqual(at('b.ts', 200));
		expect(h.canGoForward).toBe(false);
	});

	test('nearby positions in the same file replace the current entry (dedupe)', () => {
		const h = new NavigationHistory();
		h.record(at('a.ts', 10));
		expect(h.record(at('a.ts', 12, 4))).toBe(false);
		expect(h.record(at('a.ts', 20))).toBe(false);
		// Each step is near the updated entry, so walking line by line never adds entries.
		for (let line = 21; line < 100; line++) h.record(at('a.ts', line));
		expect(h.entries).toEqual([at('a.ts', 99)]);
		// Same line in another file is not "near".
		expect(h.record(at('b.ts', 99))).toBe(true);
	});

	test('the position reached by going back only updates that entry', () => {
		const h = new NavigationHistory();
		h.record(at('a.ts', 1));
		h.record(at('b.ts', 50));
		const target = h.back()!;
		// The editor reports the revealed cursor; forward history stays.
		expect(h.record(target)).toBe(false);
		expect(h.canGoForward).toBe(true);
		expect(h.forward()).toEqual(at('b.ts', 50));
	});

	test('a new location after going back truncates the forward entries', () => {
		const h = new NavigationHistory();
		h.record(at('a.ts', 1));
		h.record(at('b.ts', 1));
		h.record(at('c.ts', 1));
		h.back();
		h.back();
		h.record(at('d.ts', 1));
		expect(h.entries.map((e) => e.path)).toEqual(['a.ts', 'd.ts']);
		expect(h.canGoForward).toBe(false);
		expect(h.back()).toEqual(at('a.ts', 1));
	});

	test('keeps at most `max` entries, dropping the oldest', () => {
		const h = new NavigationHistory(10, 3);
		for (const p of ['a', 'b', 'c', 'd', 'e']) h.record(at(p, 1));
		expect(h.entries.map((e) => e.path)).toEqual(['c', 'd', 'e']);
		expect(h.index).toBe(2);
	});

	test('remove drops entries of a file and merges neighbours that meet', () => {
		const h = new NavigationHistory();
		h.record(at('a.ts', 1));
		h.record(at('gone.ts', 1));
		h.record(at('a.ts', 3));
		h.record(at('b.ts', 1));
		h.remove((p) => p === 'gone.ts');
		expect(h.entries.map((e) => `${e.path}:${e.line}`)).toEqual(['a.ts:1', 'b.ts:1']);
		expect(h.current).toEqual(at('b.ts', 1));
		h.remove(() => true);
		expect(h.current).toBeNull();
		expect(h.canGoBack).toBe(false);
	});
});
