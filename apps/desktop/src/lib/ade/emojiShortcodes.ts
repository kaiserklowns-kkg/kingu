// Emoji task names (Orca's "Emoji workspace names", docs/site/content/docs/model/worktrees.mdx):
// Slack-style `:rocket:` in the task name field becomes 🚀, with a suggestion list while typing
// `:roc`; a branch or worktree slug made from the name spells known emoji as their shortcode
// (🚀 → `rocket`). Ported from Orca's src/shared/emoji-shortcode-catalog.ts and
// src/renderer/src/lib/workspace/display/workspace-emoji-shortcodes.ts, on the same dataset
// (`emojibase-data` 17.0.0, en/shortcodes/emojibase.json). Pure apart from the lazy catalog.
import dataset from 'emojibase-data/en/shortcodes/emojibase.json';

export type EmojiEntry = { emoji: string; shortcode: string };
/** The `:query` being typed before the cursor: `start` is the colon, `end` the cursor. */
export type ActiveShortcode = { start: number; end: number; query: string };
export type EmojiReplacement = { value: string; cursor: number };

// Skin-tone aliases (`wave_tone3`) are ~40% of the dataset and would drown the suggestion list.
const SKIN_TONE = /_tone\d(?:-\d)?$/;

type Catalog = { entries: readonly EmojiEntry[]; primary: ReadonlyMap<string, string>; exact: ReadonlyMap<string, EmojiEntry>; segmenter: Intl.Segmenter };
let catalog: Catalog | null = null;

/** Built on first use (~3,900 shortcodes), not at launch. */
function load(): Catalog {
	if (catalog) return catalog;
	const grouped = Object.entries(dataset as Record<string, string | string[]>).flatMap(([hex, value]) => {
		const shortcodes = (typeof value === 'string' ? [value] : value).filter((s) => !SKIN_TONE.test(s));
		return shortcodes.length ? [{ emoji: hexToEmoji(hex), shortcodes }] : [];
	});
	const entries = grouped.flatMap(({ emoji, shortcodes }) => shortcodes.map((shortcode) => ({ emoji, shortcode })));
	catalog = {
		entries,
		primary: new Map(grouped.map(({ emoji, shortcodes }) => [normalize(emoji), primaryShortcode(shortcodes)])),
		exact: new Map(entries.map((e) => [e.shortcode, e])),
		segmenter: new Intl.Segmenter('en', { granularity: 'grapheme' })
	};
	return catalog;
}

/** Spelled-out names over symbolic `+1`, cryptic `no` / `v` and `flag_xx` for branch names. */
function primaryShortcode(shortcodes: readonly string[]): string {
	const named = shortcodes.filter((s) => /^[a-z]/i.test(s));
	return named.find((s) => s.length >= 3 && !s.startsWith('flag_')) ?? named.find((s) => s.length >= 3) ?? named[0] ?? shortcodes[0];
}

/** Known emoji spelled as ` shortcode ` (underscores as dashes), for slugs and branch names. */
export function emojiToShortcodes(input: string): string {
	if (!/[^\x00-\x7f]/.test(input)) return input;
	const { primary, segmenter } = load();
	return Array.from(segmenter.segment(input), ({ segment }) => {
		const code = primary.get(normalize(segment));
		return code ? ` ${code.replaceAll('_', '-')} ` : segment;
	}).join('');
}

/** Drops the emoji presentation selector and skin-tone modifiers so 👍🏽 finds 👍. */
function normalize(emoji: string): string {
	return Array.from(emoji)
		.filter((c) => {
			const cp = c.codePointAt(0);
			return c !== '️' && (cp === undefined || cp < 0x1f3fb || cp > 0x1f3ff);
		})
		.join('');
}

function hexToEmoji(hex: string): string {
	return hex
		.split('-')
		.map((cp) => String.fromCodePoint(Number.parseInt(cp, 16)))
		.join('');
}

// Lower tiers rank first, so `korea` surfaces `south_korea` above incidental substring hits.
const TIER = { exact: 0, prefix: 1, wordStart: 2, substring: 3 } as const;

function tier(shortcode: string, query: string): number | null {
	const i = shortcode.indexOf(query);
	if (i === -1) return null;
	if (i === 0) return shortcode.length === query.length ? TIER.exact : TIER.prefix;
	return /[_-]/.test(shortcode[i - 1]) ? TIER.wordStart : TIER.substring;
}

/** Up to `limit` emoji for a shortcode query, one row per emoji. */
export function searchShortcodes(query: string, limit = 8): EmojiEntry[] {
	const q = query.trim().toLowerCase();
	if (!q || limit <= 0) return [];
	const matches = load()
		.entries.flatMap((e) => {
			const t = tier(e.shortcode, q);
			return t === null ? [] : [{ ...e, t }];
		})
		.sort((a, b) => a.t - b.t || a.shortcode.length - b.shortcode.length || a.shortcode.localeCompare(b.shortcode));
	const seen = new Set<string>();
	const out: EmojiEntry[] = [];
	for (const { emoji, shortcode } of matches) {
		if (seen.has(emoji)) continue;
		seen.add(emoji);
		out.push({ emoji, shortcode });
		if (out.length === limit) break;
	}
	return out;
}

/** The `:query` right before the cursor, at the start or after whitespace (not `a:b`, not URLs). */
export function activeShortcode(value: string, cursor: number | null): ActiveShortcode | null {
	if (cursor === null || cursor < 0 || cursor > value.length) return null;
	const m = value.slice(0, cursor).match(/(^|\s):([a-z0-9_+-]{1,40})$/i);
	if (!m) return null;
	return { start: cursor - m[2].length - 1, end: cursor, query: m[2].toLowerCase() };
}

/** `:rocket:` just closed before the cursor → 🚀; null when it is not a known shortcode. */
export function completeShortcode(value: string, cursor: number | null): EmojiReplacement | null {
	if (cursor === null || cursor < 0 || cursor > value.length) return null;
	const m = value.slice(0, cursor).match(/(^|\s):([a-z0-9_+-]{1,40}):$/i);
	if (!m) return null;
	const hit = load().exact.get(m[2].toLowerCase());
	if (!hit) return null;
	return replaceRange(value, cursor - m[2].length - 2, cursor, hit.emoji);
}

/** A picked suggestion replaces the `:query`, followed by a space. */
export function applySuggestion(value: string, active: ActiveShortcode, entry: EmojiEntry): EmojiReplacement {
	return replaceRange(value, active.start, active.end, entry.emoji, true);
}

function replaceRange(value: string, start: number, end: number, emoji: string, trailing = false): EmojiReplacement {
	const space = trailing && !/\s/.test(value[end] ?? '') ? ' ' : '';
	return { value: `${value.slice(0, start)}${emoji}${space}${value.slice(end)}`, cursor: start + emoji.length + (trailing ? 1 : 0) };
}

/**
 * What the emoji picker button lists before a search (Orca's workspace-emoji-picker-defaults.ts):
 * emoji that read well as task markers, all emoji-presentation code points.
 */
export const PICKER_DEFAULTS: readonly EmojiEntry[] = [
	{ emoji: '🚀', shortcode: 'rocket' },
	{ emoji: '🐛', shortcode: 'bug' },
	{ emoji: '✨', shortcode: 'sparkles' },
	{ emoji: '🔥', shortcode: 'fire' },
	{ emoji: '⚡', shortcode: 'zap' },
	{ emoji: '🧪', shortcode: 'test_tube' },
	{ emoji: '📦', shortcode: 'package' },
	{ emoji: '🔧', shortcode: 'wrench' },
	{ emoji: '🔨', shortcode: 'hammer' },
	{ emoji: '🔩', shortcode: 'nut_and_bolt' },
	{ emoji: '🚧', shortcode: 'construction' },
	{ emoji: '🚨', shortcode: 'rotating_light' },
	{ emoji: '🔒', shortcode: 'lock' },
	{ emoji: '🔑', shortcode: 'key' },
	{ emoji: '🛡', shortcode: 'shield' },
	{ emoji: '🧹', shortcode: 'broom' },
	{ emoji: '📝', shortcode: 'memo' },
	{ emoji: '📚', shortcode: 'books' },
	{ emoji: '🔖', shortcode: 'bookmark' },
	{ emoji: '📌', shortcode: 'pushpin' },
	{ emoji: '📎', shortcode: 'paperclip' },
	{ emoji: '🔗', shortcode: 'link' },
	{ emoji: '📋', shortcode: 'clipboard' },
	{ emoji: '📆', shortcode: 'calendar' },
	{ emoji: '💡', shortcode: 'bulb' },
	{ emoji: '🔍', shortcode: 'mag' },
	{ emoji: '👀', shortcode: 'eyes' },
	{ emoji: '💬', shortcode: 'speech_balloon' },
	{ emoji: '🔔', shortcode: 'bell' },
	{ emoji: '🛟', shortcode: 'lifebuoy' },
	{ emoji: '🤖', shortcode: 'robot' },
	{ emoji: '🔬', shortcode: 'microscope' },
	{ emoji: '✅', shortcode: 'white_check_mark' },
	{ emoji: '⛔', shortcode: 'no_entry' },
	{ emoji: '⌛', shortcode: 'hourglass' },
	{ emoji: '🏆', shortcode: 'trophy' },
	{ emoji: '⭐', shortcode: 'star' },
	{ emoji: '🎉', shortcode: 'tada' },
	{ emoji: '🎯', shortcode: 'dart' },
	{ emoji: '🧩', shortcode: 'puzzle_piece' },
	{ emoji: '🌱', shortcode: 'seedling' },
	{ emoji: '🌸', shortcode: 'cherry_blossom' },
	{ emoji: '🌈', shortcode: 'rainbow' },
	{ emoji: '🌻', shortcode: 'sunflower' },
	{ emoji: '🌙', shortcode: 'crescent_moon' },
	{ emoji: '💜', shortcode: 'purple_heart' },
	{ emoji: '☕', shortcode: 'coffee' },
	{ emoji: '👻', shortcode: 'ghost' }
];

/** Up to `limit` emoji for the picker: the defaults, or a search. */
export const pickerEmojis = (query: string, limit = 50): readonly EmojiEntry[] => (query.trim() ? searchShortcodes(query, limit) : PICKER_DEFAULTS);

/** A picked emoji at the selection, padded with spaces so it never fuses with the text around it. */
export function insertEmoji(value: string, start: number, end: number, emoji: string): EmojiReplacement {
	const s = Math.max(0, Math.min(start, value.length));
	const e = Math.max(s, Math.min(end, value.length));
	const before = value.slice(0, s);
	const after = value.slice(e);
	const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${emoji}${after && /^\s/.test(after) ? '' : ' '}`;
	return { value: `${before}${inserted}${after}`, cursor: before.length + inserted.length };
}
