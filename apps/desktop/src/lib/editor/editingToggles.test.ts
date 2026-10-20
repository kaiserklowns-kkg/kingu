import { expect, test } from 'bun:test';
import { nextWordWrapOverride } from './editingToggles.ts';

test('Toggle Word Wrap flips the file away from what it shows, then back', () => {
	// editor.wordWrap off: the first toggle wraps this file.
	expect(nextWordWrapOverride('inherit', 'off', false)).toBe('on');
	expect(nextWordWrapOverride('on', 'off', false)).toBe('off');
	expect(nextWordWrapOverride('off', 'off', false)).toBe('on');
	// Wrapping by the setting (on, wordWrapColumn, bounded): the first toggle unwraps it.
	expect(nextWordWrapOverride('inherit', 'on', true)).toBe('off');
	expect(nextWordWrapOverride('inherit', 'bounded', true)).toBe('off');
});
