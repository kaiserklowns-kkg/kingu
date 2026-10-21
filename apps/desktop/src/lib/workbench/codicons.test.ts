/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	ALL_ICON_IDS,
	CODICON_FONT,
	DEFAULT_PRODUCT_ICON_THEME_ID,
	findProductIconTheme,
	iconClasses,
	isIconId,
	KINGU_PRODUCT_ICON_THEME_ID,
	MASK_ICONS,
	parseIconId,
	parseProductIconTheme,
	PRODUCT_ICON_THEMES,
	productIconsCss,
	resolveIcon
} from './codicons';
import { SETTINGS } from '../settings/registry';

const lucide = findProductIconTheme(KINGU_PRODUCT_ICON_THEME_ID);
const codicons = findProductIconTheme(DEFAULT_PRODUCT_ICON_THEME_ID);
const glyph = (id: string, theme = lucide) => {
	const g = resolveIcon(id, theme);
	// kingu-old's window names the codicon font `codicon`; Kingu's is CODICON_FONT.
	return g && `${g.font === CODICON_FONT ? 'codicon' : g.font} ${g.char.toString(16)}`;
};

describe('id → glyph', () => {
	// What kingu-old's window drew for the title bar, chat, home and status bar icons (ref
	// old-dom.json: each icon's ::before content and font).
	test('kingu-old title bar and chat icons resolve as its window drew them', () => {
		const old: [string, string][] = [
			['arrow-left', 'pi-kingu-lucide e004'],
			['arrow-right', 'pi-kingu-lucide e005'],
			['configure-layout-icon', 'codicon ebeb'],
			['panel-left-off', 'codicon ec02'],
			['panel-layout-icon-off', 'codicon ec01'],
			['auxiliarybar-right-layout-icon', 'codicon ebf4'],
			['accounts-view-bar-icon', 'pi-kingu-lucide e01d'],
			['settings-view-bar-icon', 'pi-kingu-lucide e071'],
			['chat-view-icon', 'codicon ec4f'],
			['plus', 'codicon ea60'],
			['chevron-down', 'pi-kingu-lucide e013'],
			['extensions', 'pi-kingu-lucide e088'],
			['toolbar-more', 'codicon ea7c'],
			['auxiliarybar-maximize', 'pi-kingu-lucide e054'],
			['chat-sparkle', 'codicon ec4f'],
			['case-sensitive', 'pi-kingu-lucide e010'],
			['find-previous-match', 'pi-kingu-lucide e006'],
			['widget-close', 'pi-kingu-lucide e087'],
			['comment-discussion', 'pi-kingu-lucide e057'],
			['folder-opened', 'pi-kingu-lucide e032'],
			['circle-filled', 'codicon ea71'],
			['remote', 'codicon eb3a'],
			['error', 'pi-kingu-lucide e01e'],
			['bell', 'pi-kingu-lucide e008'],
			['openai', 'codicon ec81']
		];
		expect(old.map(([id]) => [id, glyph(id)])).toEqual(old);
	});

	test('`add` has a lucide glyph while `plus`, the same codicon, keeps the codicon', () => {
		expect(glyph('add')).toBe('pi-kingu-lucide e063');
		expect(glyph('plus')).toBe('codicon ea60');
		expect(glyph('add', codicons)).toBe('codicon ea60');
	});

	test('a registered icon follows its default through the theme', () => {
		// settings-view-bar-icon → settings-gear, which the lucide theme draws.
		expect(glyph('settings-view-bar-icon')).toBe(glyph('settings-gear'));
		// …and the codicon of settings-gear without a product icon theme.
		expect(glyph('settings-view-bar-icon', codicons)).toBe('codicon eb51');
	});

	test('an id registered twice keeps the first registration, as VS Code does', () => {
		// debug-console is a codicon; debugIcons.ts registering it with Codicon.gear changes nothing.
		expect(glyph('debug-console')).toBe('codicon eb9b');
	});

	test('the Default theme draws every icon from codicon.ttf', () => {
		for (const id of ALL_ICON_IDS) expect([id, resolveIcon(id, codicons)?.font]).toEqual([id, CODICON_FONT]);
	});

	test('an unknown id has no glyph', () => {
		expect(resolveIcon('no-such-icon')).toBeUndefined();
		expect(isIconId('no-such-icon')).toBe(false);
		expect(isIconId('chat-view-icon')).toBe(true);
	});
});

describe('product icon themes', () => {
	test('kingu-lucide is the default and an unknown theme falls back to it', () => {
		expect(findProductIconTheme(undefined).id).toBe('kingu-lucide');
		expect(findProductIconTheme('Nope').id).toBe('kingu-lucide');
		expect(findProductIconTheme('Default').glyphs.size).toBe(0);
		expect(PRODUCT_ICON_THEMES.map((t) => t.id)).toEqual(['Default', 'kingu-lucide']);
	});

	test('the setting is VS Code’s, with kingu-old’s default and the bundled themes', () => {
		const s = SETTINGS.find((x) => x.id === 'workbench.productIconTheme');
		expect(s?.default).toBe('kingu-lucide');
		expect(s?.type === 'json' && s.schema.enum).toEqual(['Default', 'kingu-lucide']);
	});

	test('a theme file: fontCharacter escapes, fontId, the pi- font family', () => {
		const t = parseProductIconTheme('x', 'X', {
			fonts: [
				{ id: 'a', src: [] },
				{ id: 'b', src: [] }
			],
			iconDefinitions: { one: { fontCharacter: '\\e001' }, two: { fontCharacter: '\\E002', fontId: 'b' }, three: { fontCharacter: '\\e003', fontId: 'zz' } }
		});
		expect(t.glyphs.get('one')).toEqual({ font: 'pi-a', char: 0xe001 });
		expect(t.glyphs.get('two')).toEqual({ font: 'pi-b', char: 0xe002 });
		expect(t.glyphs.get('three')).toEqual({ font: 'pi-a', char: 0xe003 });
	});

	test("the stylesheet draws each icon as ::before, over Monaco's own rules", () => {
		const css = productIconsCss(lucide);
		expect(css.startsWith(':root:root {')).toBe(true);
		expect(css).toContain("--vscode-icon-add-content: '\\e063'; --vscode-icon-add-font-family: 'pi-kingu-lucide';");
		expect(css).toContain("--vscode-icon-plus-content: '\\ea60'; --vscode-icon-plus-font-family: 'kg-codicon';");
		expect(css).toContain(".codicon.codicon-chat-view-icon::before { content: '\\ec4f'; font-family: 'kg-codicon'; }");
		expect(productIconsCss(codicons)).toContain(".codicon.codicon-add::before { content: '\\ea60'; font-family: 'kg-codicon'; }");
	});
});

describe('ids, modifiers and mask icons', () => {
	test('VS Code’s `id~modifier` form', () => {
		expect(parseIconId('sync~spin')).toEqual({ id: 'sync', modifier: 'spin' });
		expect(parseIconId('gear')).toEqual({ id: 'gear' });
		expect(iconClasses('loading', 'spin')).toBe('codicon codicon-loading codicon-modifier-spin');
	});

	test('the Arkai marks are not codicon ids and their files are vendored', () => {
		for (const id of Object.keys(MASK_ICONS)) expect([id, isIconId(id)]).toEqual([id, false]);
		for (const f of ['arkai-chat.svg', 'arkai-mark.svg', 'codicon.ttf', 'kingu-marks.ttf', 'kingu-lucide.ttf']) expect([f, existsSync(join(import.meta.dir, '../assets/icons', f))]).toEqual([f, true]);
		expect(existsSync(join(import.meta.dir, '../assets/fonts/Geist-Variable.woff2'))).toBe(true);
	});
});
