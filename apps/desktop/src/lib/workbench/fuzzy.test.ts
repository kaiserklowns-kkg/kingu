import { describe, expect, test } from 'bun:test';
import { fuzzyMatch, rank, highlightRuns } from './fuzzy';
import { eventKey, keyLabel, matches, parseChord } from './keys';

describe('fuzzyMatch', () => {
	test('requires characters in order', () => {
		expect(fuzzyMatch('lrs', 'src/lib.rs')).not.toBeNull();
		expect(fuzzyMatch('srl', 'lib.rs')).toBeNull();
	});

	test('ranks file-name and consecutive matches first', () => {
		const files = ['apps/desktop/src-tauri/src/lib.rs', 'docs/library-notes.md', 'apps/desktop/src/lib/index.ts'];
		expect(rank('lib.rs', files, (f) => f)[0].item).toBe('apps/desktop/src-tauri/src/lib.rs');
	});

	test('empty query matches everything', () => {
		expect(fuzzyMatch('', 'a')).toEqual({ score: 0, positions: [] });
	});
});

describe('keybindings', () => {
	const ev = (code: string, key: string, mods: Partial<KeyboardEvent> = {}) =>
		({ code, key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent;

	test('cmd maps to meta on macOS and ctrl elsewhere', () => {
		expect(matches(parseChord('cmd+shift+p', true), ev('KeyP', 'P', { metaKey: true, shiftKey: true }))).toBe(true);
		expect(matches(parseChord('cmd+shift+p', false), ev('KeyP', 'P', { ctrlKey: true, shiftKey: true }))).toBe(true);
	});

	test('option combinations match by physical key', () => {
		// ⌥⌘B produces e.key "∫" on a US layout.
		expect(eventKey(ev('KeyB', '∫'))).toBe('b');
		expect(matches(parseChord('cmd+alt+b', true), ev('KeyB', '∫', { metaKey: true, altKey: true }))).toBe(true);
	});

	test('labels', () => {
		expect(keyLabel('cmd+shift+p', true)).toBe('⇧⌘P');
		expect(keyLabel('ctrl+`', true)).toBe('⌃`');
		expect(keyLabel('cmd+b', false)).toBe('Ctrl+B');
	});
});

describe('highlightRuns', () => {
	test('keeps Thai vowels and tone marks with their letter', () => {
		const text = 'ลองหาอีกครั้ง';
		const m = fuzzyMatch('อีก', text)!;
		const runs = highlightRuns(text, m.positions);
		expect(runs.map((r) => r.text).join('')).toBe(text);
		// No run starts with a combining mark (U+0E31, U+0E34–U+0E3A, U+0E47–U+0E4E).
		expect(runs.every((r) => !/^[ัิ-ฺ็-๎]/.test(r.text))).toBe(true);
	});
	test('merges neighbours with the same state', () => {
		expect(highlightRuns('abcd', [1, 2])).toEqual([
			{ text: 'a', hit: false },
			{ text: 'bc', hit: true },
			{ text: 'd', hit: false }
		]);
		expect(highlightRuns('abc')).toEqual([{ text: 'abc', hit: false }]);
	});
});
