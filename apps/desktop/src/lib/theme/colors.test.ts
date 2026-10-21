/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromeVariables, resolveColor, terminalTheme } from './colors';
import { findTheme, loadTheme, THEMES } from './themes';
import { normalizeColor } from '../editor/textmate/theme';

// The built-in snap `kingu-themes`: theme files are paths in it (`themes/dark_modern.json`).
const dir = join(import.meta.dir, '../../../snaps/kingu-themes');
const read = (file: string) => readFileSync(join(dir, file), 'utf8');
const load = (id: string) => {
	const info = findTheme(id);
	return { info, flat: loadTheme(info, read) };
};

describe('themes', () => {
	test('every built-in theme loads through its include chain', () => {
		for (const t of THEMES) {
			const flat = loadTheme(t, read);
			expect(flat.name).toBe(t.label);
			expect(resolveColor('editor.background', flat.colors, t.type)).toMatch(/^#[0-9A-F]{6}/);
		}
	});

	test('ids, VS Code aliases and unknown values', () => {
		expect(findTheme('Light+').file).toBe('themes/light_plus.json');
		expect(findTheme('Default Dark Modern').id).toBe('Dark Modern');
		expect(findTheme('Light High Contrast').id).toBe('Default High Contrast Light');
		expect(findTheme('Solarized').id).toBe('Dark Modern');
		expect(findTheme(undefined).id).toBe('Dark Modern');
	});

	test('Light Modern overrides Light+ which includes Light (Visual Studio)', () => {
		const { flat } = load('Light Modern');
		expect(flat.colors['editor.background']).toBe('#FFFFFF');
		expect(flat.colors['statusBar.background']).toBe('#F8F8F8');
		// Token colors from the whole chain, base first.
		expect(flat.tokenColors.length).toBeGreaterThan(load('Light+').flat.tokenColors.length - 1);
	});
});

describe('chromeVariables', () => {
	test('Dark Modern reproduces the static theme.css values', () => {
		const { info, flat } = load('Dark Modern');
		const vars = chromeVariables(flat.colors, info.type);
		const css = readFileSync(join(import.meta.dir, '../workbench/theme.css'), 'utf8');
		let checked = 0;
		for (const [, name, value] of css.matchAll(/(--vscode-[\w-]+):\s*(#[0-9A-Fa-f]+);/g)) {
			expect(`${name}: ${vars[name]}`).toBe(`${name}: ${normalizeColor(value)}`);
			checked++;
		}
		expect(checked).toBeGreaterThan(50);
	});

	test('a light theme gets light registry defaults for colors it leaves out', () => {
		const { info, flat } = load('Light+');
		const vars = chromeVariables(flat.colors, info.type);
		// Not in light_plus/light_vs: registry light defaults.
		expect(vars['--vscode-titleBar-activeBackground']).toBe('#DDDDDD');
		expect(vars['--vscode-sideBar-background']).toBe('#F3F3F3');
		expect(vars['--vscode-list-inactiveSelectionBackground']).toBe('#E4E6F1');
		// References resolve through the theme: tab.activeBackground → editor.background.
		expect(vars['--vscode-tab-activeBackground']).toBe('#FFFFFF');
		// No color in a light theme → transparent; a missing foreground inherits `foreground`.
		expect(vars['--vscode-titleBar-border']).toBe('transparent');
		expect(vars['--vscode-sideBar-foreground']).toBe(vars['--vscode-foreground']);
	});

	test('high contrast borders come from contrastBorder', () => {
		const { info, flat } = load('Default High Contrast');
		expect(info.type).toBe('hcDark');
		const vars = chromeVariables(flat.colors, info.type);
		const border = resolveColor('contrastBorder', flat.colors, info.type);
		expect(border).toBeTruthy();
		expect(vars['--vscode-sideBar-border']).toBe(border!);
		expect(vars['--vscode-editor-background']).toBe('#000000');
	});

	test('transparent() multiplies alpha, including over a referenced color', () => {
		// descriptionForeground (dark) = transparent(foreground, 0.7)
		expect(resolveColor('descriptionForeground', { foreground: '#FFFFFF' }, 'dark')).toBe('#FFFFFFB3');
		expect(resolveColor('descriptionForeground', { foreground: '#FFFFFF80' }, 'dark')).toBe('#FFFFFF5A');
		expect(resolveColor('descriptionForeground', {}, 'light')).toBe('#717171');
	});

	test('reference cycles resolve to nothing instead of looping', () => {
		expect(resolveColor('sideBar.foreground', {}, 'dark')).toBeNull();
	});
});

describe('terminalTheme', () => {
	test('uses the panel background and per-type ANSI defaults', () => {
		const dark = load('Dark Modern');
		const t = terminalTheme(dark.flat.colors, dark.info.type);
		expect(t.background).toBe('#181818');
		expect(t.green).toBe('#0DBC79');
		const light = load('Light Modern');
		const l = terminalTheme(light.flat.colors, light.info.type);
		expect(l.green).toBe('#107C10');
		expect(l.foreground).toBeDefined();
	});
});

describe('toolbar hover', () => {
	test('uses the registry defaults per theme type (transparent in high contrast)', () => {
		const v = (type: 'dark' | 'light' | 'hcDark' | 'hcLight') => chromeVariables({}, type)['--vscode-toolbar-hoverBackground'];
		expect(v('dark')).toBe(normalizeColor('#5A5D5E50')!);
		expect(v('light')).toBe(normalizeColor('#B8B8B850')!);
		expect(v('hcDark')).toBe('transparent');
		expect(v('hcLight')).toBe('transparent');
	});
});
