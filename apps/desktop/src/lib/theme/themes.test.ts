/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allThemes, findTheme, setSnapThemes, themeType, THEMES, type ThemeInfo } from './themes';
import { flattenTheme } from '../editor/textmate/theme';
import { SETTINGS, validate } from '../settings/registry';

const ocean: ThemeInfo = {
	id: 'Ocean Dark',
	label: 'Ocean Dark',
	file: 'ocean/themes/ocean.json',
	type: 'dark',
	snap: 'Ocean',
	files: {
		'ocean/themes/ocean.json': '{ "include": "./base.json", "colors": { "editor.background": "#001122" } }',
		'ocean/themes/base.json': '{ "colors": { "editor.foreground": "#ccddee", "editor.background": "#000000" } }'
	}
};

afterEach(() => setSnapThemes([]));

describe('Snap themes', () => {
	test('join the built-in themes, never shadowing one', () => {
		setSnapThemes([ocean, { ...ocean, id: 'Dark Modern', label: 'Fake' }]);
		expect(allThemes().length).toBe(THEMES.length + 1);
		expect(findTheme('Ocean Dark')).toBe(ocean);
		expect(findTheme('Dark Modern').label).toBe('Dark Modern');
		setSnapThemes([]);
		expect(findTheme('Ocean Dark').id).toBe('Dark Modern');
	});

	test('the theme settings accept a Snap theme only while it is there', () => {
		// workbench.colorTheme keeps any value (like VS Code); the preferred-theme settings check theirs.
		const preferred = SETTINGS.find((s) => s.id === 'workbench.preferredDarkColorTheme')!;
		expect(validate(preferred, 'Ocean Dark')).toBeUndefined();
		setSnapThemes([ocean]);
		expect(validate(preferred, 'Ocean Dark')).toBe('Ocean Dark');
		expect((preferred as { enum: readonly string[] }).enum).toContain('Ocean Dark');
	});

	test('a snap theme includes its own files', () => {
		const flat = flattenTheme(ocean.file, (p) => ocean.files![p]);
		expect(flat.colors['editor.background']).toBe('#001122');
		expect(flat.colors['editor.foreground']).toBe('#ccddee');
	});

	test('the shipped Oceans themes resolve onto the built-in themes they include', () => {
		const snapDir = join(import.meta.dir, '../../../../../snaps/oceans-theme/themes');
		const vendored = join(import.meta.dir, '../editor/textmate/themes');
		// Like theme.svelte.ts readChain: the snap's own file when it has it, else the built-in theme of that name.
		const read = (p: string) => {
			const name = p.split('/').pop()!;
			return readFileSync(existsSync(join(snapDir, name)) ? join(snapDir, name) : join(vendored, name), 'utf8');
		};
		const dark = flattenTheme('oceans-theme/themes/oceans-dark.json', read);
		expect(dark.colors['editor.background']).toBe('#0E2032');
		// Colors it does not set come from Dark Modern.
		expect(Object.keys(dark.colors).length).toBeGreaterThan(100);
		expect(dark.tokenColors.length).toBeGreaterThan(5);
		const light = flattenTheme('oceans-theme/themes/oceans-light.json', read);
		expect(light.colors['editor.background']).toBe('#F7FBFD');
	});

	test('uiTheme maps to the theme type', () => {
		expect(['vs-dark', 'vs', 'hc-black', 'hc-light', 'other'].map(themeType)).toEqual(['dark', 'light', 'hcDark', 'hcLight', 'dark']);
	});
});
