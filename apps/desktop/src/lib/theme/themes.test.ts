/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allThemes, builtinThemeFile, findTheme, setContributedThemes, themesOfSnaps, themeTypeOf, THEMES, type ThemeInfo } from './themes';
import { flattenTheme } from '../editor/textmate/theme';

const ocean: ThemeInfo = { id: 'Ocean Dark', label: 'Ocean Dark', file: 'themes/ocean.json', type: 'dark', snap: { source: 'user', id: 'ocean' } };

afterEach(() => setContributedThemes([]));

describe('snap themes', () => {
	test('join the built-in themes, never shadowing one', () => {
		setContributedThemes([ocean, { ...ocean, id: 'Dark Modern', label: 'Fake' }]);
		expect(allThemes().length).toBe(THEMES.length + 1);
		expect(findTheme('Ocean Dark')).toBe(ocean);
		expect(findTheme('Dark Modern').label).toBe('Dark Modern');
		setContributedThemes([]);
		expect(findTheme('Ocean Dark').id).toBe('Dark Modern');
	});

	test('a snap listing becomes theme infos with the hash of the theme file', () => {
		const snap = { source: 'user' as const, id: 'oceans-theme', contributes: { themes: [{ id: 'Oceans Dark', label: 'Oceans Dark', uiTheme: 'vs-dark', path: 'themes/oceans-dark.json' }], files: [{ path: 'themes/oceans-dark.json', sha256: 'abc' }] } };
		expect(themesOfSnaps([snap])).toEqual([{ id: 'Oceans Dark', label: 'Oceans Dark', file: 'themes/oceans-dark.json', type: 'dark', snap: { source: 'user', id: 'oceans-theme' }, sha256: 'abc' }]);
	});

	test('an include a snap does not ship is the built-in theme of that name', () => {
		expect(builtinThemeFile({ source: 'user', id: 'oceans-theme' }, 'themes/dark_modern.json')).toEqual({ snap: { source: 'builtin', id: 'kingu-themes' }, path: 'themes/dark_modern.json' });
		expect(builtinThemeFile({ source: 'builtin', id: 'kingu-themes' }, 'themes/x.json')).toBeUndefined();
		expect(builtinThemeFile({ source: 'repo', id: 'r' }, 'themes/a b.toml')).toBeUndefined();
	});

	test('the shipped Oceans themes resolve onto the built-in themes they include', () => {
		const snapDir = join(import.meta.dir, '../../../../../snaps/oceans-theme');
		const builtinDir = join(import.meta.dir, '../../../snaps/kingu-themes');
		// Like theme.svelte.ts readChain: the snap's own file when it has it, else the built-in one.
		const read = (p: string) => {
			if (existsSync(join(snapDir, p))) return readFileSync(join(snapDir, p), 'utf8');
			const builtin = builtinThemeFile({ source: 'user', id: 'oceans-theme' }, p);
			return readFileSync(join(builtinDir, builtin!.path), 'utf8');
		};
		const dark = flattenTheme('themes/oceans-dark.json', read);
		expect(dark.colors['editor.background']).toBe('#0E2032');
		// Colors it does not set come from Dark Modern.
		expect(Object.keys(dark.colors).length).toBeGreaterThan(100);
		expect(dark.tokenColors.length).toBeGreaterThan(5);
		const light = flattenTheme('themes/oceans-light.json', read);
		expect(light.colors['editor.background']).toBe('#F7FBFD');
	});

	test('uiTheme maps to the theme type', () => {
		expect(['vs-dark', 'vs', 'hc-black', 'hc-light', 'other'].map(themeTypeOf)).toEqual(['dark', 'light', 'hcDark', 'hcLight', 'dark']);
	});
});
