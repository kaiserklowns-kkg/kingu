/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { editorColors, flattenTheme, normalizeColor, parseJsonc, textMateRules } from './theme';

describe('parseJsonc', () => {
	test('strips line and block comments and trailing commas', () => {
		const text = `{
			// leading
			"a": [1, 2, /* inline */ 3,],
			"b": { "c": "x", },
		}`;
		expect(parseJsonc<object>(text)).toEqual({ a: [1, 2, 3], b: { c: 'x' } });
	});

	test('leaves comment and comma lookalikes inside strings alone', () => {
		const text = `{ "url": "https://example.com/*x*/", "s": "a,}", "q": "say \\"hi\\" // no" }`;
		expect(parseJsonc<object>(text)).toEqual({ url: 'https://example.com/*x*/', s: 'a,}', q: 'say "hi" // no' });
	});
});

describe('flattenTheme', () => {
	const files: Record<string, string> = {
		'themes/child.json': `{ "name": "Child", "include": "./parent.json",
			"colors": { "editor.background": "#111111", "removed": "default" },
			"tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#ff0000" } }] }`,
		'themes/parent.json': `{ "name": "Parent", "include": "../base/root.json",
			"colors": { "editor.background": "#222222", "editor.foreground": "#eeeeee" },
			"tokenColors": [{ "scope": "string", "settings": { "foreground": "#00ff00" } }] }`,
		'base/root.json': `{ "colors": { "removed": "#123456" }, // comment
			"tokenColors": [{ "scope": "comment", "settings": { "foreground": "#0000ff" } }] }`
	};
	const read = (p: string) => {
		if (!(p in files)) throw new Error(`missing ${p}`);
		return files[p];
	};

	test('child colors override included ones and tokenColors keep include order', () => {
		const theme = flattenTheme('themes/child.json', read);
		expect(theme.name).toBe('Child');
		expect(theme.colors).toEqual({ 'editor.background': '#111111', 'editor.foreground': '#eeeeee' });
		expect(theme.tokenColors.map((r) => r.scope)).toEqual(['comment', 'string', 'keyword']);
	});

	test('rejects include cycles', () => {
		const cyclic = { 'a.json': '{"include":"./b.json"}', 'b.json': '{"include":"./a.json"}' };
		expect(() => flattenTheme('a.json', (p) => cyclic[p as keyof typeof cyclic])).toThrow(/cycle/);
	});
});

test('normalizeColor matches VS Code normalization', () => {
	expect(normalizeColor('#abc')).toBe('#AABBCC');
	expect(normalizeColor('#abcd')).toBe('#AABBCCDD');
	expect(normalizeColor('#C586C0')).toBe('#C586C0');
	expect(normalizeColor('red')).toBeUndefined();
	expect(normalizeColor(undefined)).toBeUndefined();
});

describe('vendored Dark Modern theme', () => {
	const dir = join(import.meta.dir, 'themes');
	const theme = flattenTheme('dark_modern.json', (p) => readFileSync(join(dir, p), 'utf8'));

	test('resolves dark_modern -> dark_plus -> dark_vs', () => {
		expect(theme.name).toBe('Dark Modern');
		// Dark Modern overrides the Dark+ / Dark (VS) editor background.
		expect(theme.colors['editor.background']).toBe('#1F1F1F');
		const keyword = theme.tokenColors.findLast((r) => [r.scope].flat().includes('keyword.control'));
		expect(keyword?.settings.foreground?.toUpperCase()).toBe('#C586C0'); // Dark+ overrides Dark (VS) blue
	});

	test('textMateRules starts with the editor default rule', () => {
		const rules = textMateRules(theme);
		expect(rules[0]).toEqual({ settings: { foreground: '#CCCCCC', background: '#1F1F1F' } });
		expect(rules.every((r, i) => i === 0 || r.scope)).toBe(true);
		expect(rules.some((r) => r.scope === 'token.error-token')).toBe(true);
	});

	test('editorColors keeps only valid hex colors', () => {
		const colors = editorColors(theme);
		expect(colors['editor.background']).toBe('#1F1F1F');
		expect(Object.values(colors).every((c) => /^#[0-9A-F]{6}([0-9A-F]{2})?$/.test(c))).toBe(true);
	});
});
