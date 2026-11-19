import { describe, expect, test } from 'bun:test';
import { activeShortcode, applySuggestion, completeShortcode, emojiToShortcodes, insertEmoji, pickerEmojis, searchShortcodes } from './emojiShortcodes.ts';
import { uniqueSlug } from './model.ts';
import { attemptSlugs } from './attempts.ts';

describe('searchShortcodes', () => {
	test('ranks exact, then prefix, then word start, one row per emoji', () => {
		const rows = searchShortcodes('rocket');
		expect(rows[0]).toEqual({ emoji: '🚀', shortcode: 'rocket' });
		expect(new Set(rows.map((r) => r.emoji)).size).toBe(rows.length);
		const korea = searchShortcodes('korea');
		expect(korea[0].shortcode).toMatch(/korea/);
	});

	test('leaves out skin-tone aliases and caps the list', () => {
		expect(searchShortcodes('wave', 50).some((r) => /_tone\d/.test(r.shortcode))).toBe(false);
		expect(searchShortcodes('a', 8)).toHaveLength(8);
		expect(searchShortcodes('  ')).toEqual([]);
	});
});

describe('activeShortcode', () => {
	test('is the :query right before the cursor, at the start or after a space', () => {
		expect(activeShortcode(':roc', 4)).toEqual({ start: 0, end: 4, query: 'roc' });
		expect(activeShortcode('fix :Bug', 8)).toEqual({ start: 4, end: 8, query: 'bug' });
	});

	test('is null inside a word, a URL or with the cursor elsewhere', () => {
		expect(activeShortcode('a:roc', 5)).toBeNull();
		expect(activeShortcode('https://x', 9)).toBeNull();
		expect(activeShortcode(':roc more', 9)).toBeNull();
		expect(activeShortcode(':roc', null)).toBeNull();
	});
});

describe('completeShortcode', () => {
	test('turns a closed known shortcode into its emoji', () => {
		expect(completeShortcode('ship :rocket:', 13)).toEqual({ value: 'ship 🚀', cursor: 7 });
		expect(completeShortcode(':rocket: later', 8)).toEqual({ value: '🚀 later', cursor: 2 });
	});

	test('leaves unknown shortcodes and times like 10:30: alone', () => {
		expect(completeShortcode(':notanemoji:', 12)).toBeNull();
		expect(completeShortcode('at 10:30:', 9)).toBeNull();
	});
});

test('applySuggestion replaces the query and adds one space', () => {
	expect(applySuggestion('go :roc', { start: 3, end: 7, query: 'roc' }, { emoji: '🚀', shortcode: 'rocket' })).toEqual({ value: 'go 🚀 ', cursor: 6 });
	expect(applySuggestion(':roc now', { start: 0, end: 4, query: 'roc' }, { emoji: '🚀', shortcode: 'rocket' })).toEqual({ value: '🚀 now', cursor: 3 });
});

describe('slugs spell emoji out', () => {
	test('known emoji become their primary shortcode, skin tones and VS16 included', () => {
		expect(emojiToShortcodes('🚀 launch').trim()).toBe('rocket  launch');
		expect(emojiToShortcodes('👍🏽')).toBe(emojiToShortcodes('👍'));
		expect(emojiToShortcodes('plain ascii')).toBe('plain ascii');
		expect(emojiToShortcodes('แก้บั๊ก')).toBe('แก้บั๊ก');
	});

	test('in task and attempt slugs', () => {
		expect(uniqueSlug('🚀 launch page', new Set())).toBe('rocket-launch-page');
		expect(uniqueSlug('🐛', new Set())).toBe('bug');
		expect(attemptSlugs('🚀 go', 2, new Set()).slugs).toEqual(['rocket-go-a', 'rocket-go-b']);
	});
});

describe('the emoji picker button', () => {
	test('lists the defaults until a search', () => {
		expect(pickerEmojis('')[0]).toEqual({ emoji: '🚀', shortcode: 'rocket' });
		expect(pickerEmojis('').length).toBe(48);
		expect(pickerEmojis('tada')[0].emoji).toBe('🎉');
	});
	test('inserts at the selection with spaces around it', () => {
		expect(insertEmoji('', 0, 0, '🚀')).toEqual({ value: '🚀 ', cursor: 3 });
		expect(insertEmoji('fix', 3, 3, '🐛')).toEqual({ value: 'fix 🐛 ', cursor: 7 });
		expect(insertEmoji('fix login', 3, 3, '🐛')).toEqual({ value: 'fix 🐛 login', cursor: 6 });
		expect(insertEmoji('fix old login', 4, 7, '🐛')).toEqual({ value: 'fix 🐛 login', cursor: 6 });
	});
});
