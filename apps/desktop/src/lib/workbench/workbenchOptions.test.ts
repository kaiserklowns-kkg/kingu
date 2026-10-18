import { describe, expect, test } from 'bun:test';
import { eventKey } from './keys';
import { renderWindowTitle, DEFAULT_TITLE_MAC, DEFAULT_TITLE_OTHER } from './title';
import {
	activityBarMetrics,
	activityClickHides,
	editorTabHeight,
	fontSmoothing,
	menuBarShown,
	nativeWindowTheme,
	notificationsCorner,
	panelOpensMaximized,
	quickValueKind,
	recordCommand,
	reducedMotion,
	restoredInput,
	themeSettingFor,
	withRecentFirst
} from './workbenchOptions';

describe('window.menuBarVisibility', () => {
	test('classic hides in full screen, visible never does, toggle follows Alt, compact is a button', () => {
		const at = (fullscreen: boolean, toggledOn = false) => ({ fullscreen, toggledOn });
		expect(menuBarShown('classic', at(false))).toBe('bar');
		expect(menuBarShown('classic', at(true))).toBe('none');
		expect(menuBarShown('visible', at(true))).toBe('bar');
		expect(menuBarShown('toggle', at(false))).toBe('none');
		expect(menuBarShown('toggle', at(false, true))).toBe('bar');
		expect(menuBarShown('hidden', at(false, true))).toBe('none');
		expect(menuBarShown('compact', at(true))).toBe('button');
	});
});

describe('panel and activity bar', () => {
	test('workbench.panel.opensMaximized', () => {
		expect(panelOpensMaximized('always', false)).toBe(true);
		expect(panelOpensMaximized('never', true)).toBe(false);
		expect(panelOpensMaximized('preserve', true)).toBe(true);
		expect(panelOpensMaximized('preserve', false)).toBe(false);
	});

	test('workbench.activityBar.iconClickBehavior: only toggle hides the open view', () => {
		expect(activityClickHides('toggle', true, true)).toBe(true);
		expect(activityClickHides('focus', true, true)).toBe(false);
		expect(activityClickHides('toggle', false, true)).toBe(false);
		expect(activityClickHides('toggle', true, false)).toBe(false);
	});

	test('workbench.activityBar.compact and window.density.editorTabHeight use VS Code sizes', () => {
		expect(activityBarMetrics(true)).toEqual({ width: 36, item: 28, icon: 16 });
		expect(activityBarMetrics(false)).toEqual({ width: 48, item: 48, icon: 24 });
		expect(editorTabHeight('default')).toBe(35);
		expect(editorTabHeight('compact')).toBe(22);
	});
});

describe('command palette and quick open', () => {
	test('workbench.commandPalette.history keeps the most recent first, capped, 0 keeps none', () => {
		expect(recordCommand(['a', 'b', 'c'], 'b', 50)).toEqual(['b', 'a', 'c']);
		expect(recordCommand(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
		expect(recordCommand(['a'], 'b', 0)).toEqual([]);
	});

	test('recently used commands come first, the rest keep their order', () => {
		const out = withRecentFirst(['x', 'a', 'y', 'b'], (s) => s, ['b', 'a']);
		expect(out).toEqual([
			{ item: 'b', recent: true },
			{ item: 'a', recent: true },
			{ item: 'x', recent: false },
			{ item: 'y', recent: false }
		]);
	});

	test('preserveInput restores the last text of the same quick access only', () => {
		expect(restoredInput('>', '>git push', true)).toBe('>git push');
		expect(restoredInput('>', '>git push', false)).toBe('>');
		expect(restoredInput('', 'main.ts', true)).toBe('main.ts');
		expect(restoredInput('', '>git push', true)).toBe('');
		expect(restoredInput('>', undefined, true)).toBe('>');
		expect(quickValueKind('>x')).toBe('commands');
		expect(quickValueKind('main')).toBe('files');
		expect(quickValueKind(':42')).toBeNull();
		expect(quickValueKind('edt foo')).toBeNull();
	});
});

describe('appearance', () => {
	test('workbench.notifications.position', () => {
		expect(notificationsCorner('bottom-right')).toEqual({ top: false, left: false });
		expect(notificationsCorner('bottom-left')).toEqual({ top: false, left: true });
		expect(notificationsCorner('top-right')).toEqual({ top: true, left: false });
	});

	test('workbench.reduceMotion follows the OS only with auto', () => {
		expect(reducedMotion('on', false)).toBe(true);
		expect(reducedMotion('off', true)).toBe(false);
		expect(reducedMotion('auto', true)).toBe(true);
		expect(reducedMotion('auto', false)).toBe(false);
	});

	test('workbench.fontAliasing', () => {
		expect(fontSmoothing('default', 2)).toBe('auto');
		expect(fontSmoothing('antialiased', 1)).toBe('antialiased');
		expect(fontSmoothing('none', 2)).toBe('none');
		expect(fontSmoothing('auto', 2)).toBe('antialiased');
		expect(fontSmoothing('auto', 1)).toBe('auto');
	});

	test('window.systemColorTheme, ignored while the color scheme is auto-detected', () => {
		expect(nativeWindowTheme('default', true, false)).toBeNull();
		expect(nativeWindowTheme('auto', true, false)).toBe('dark');
		expect(nativeWindowTheme('auto', false, false)).toBe('light');
		expect(nativeWindowTheme('light', true, false)).toBe('light');
		expect(nativeWindowTheme('dark', false, true)).toBeNull();
	});

	test('high contrast wins over the color scheme when detected', () => {
		const base = { autoDetectHighContrast: true, autoDetectColorScheme: false, highContrast: false, prefersDark: true };
		expect(themeSettingFor(base)).toBe('workbench.colorTheme');
		expect(themeSettingFor({ ...base, highContrast: true })).toBe('workbench.preferredHighContrastColorTheme');
		expect(themeSettingFor({ ...base, highContrast: true, prefersDark: false })).toBe('workbench.preferredHighContrastLightColorTheme');
		expect(themeSettingFor({ ...base, autoDetectHighContrast: false, highContrast: true, autoDetectColorScheme: true })).toBe('workbench.preferredDarkColorTheme');
	});
});

describe('keyboard.dispatch', () => {
	const ev = (code: string, key: string) => ({ code, key });
	test('code matches the physical key, keyCode the typed letter', () => {
		// The key at QWERTY's Z types "y" on a German layout.
		expect(eventKey(ev('KeyZ', 'y'), 'code')).toBe('z');
		expect(eventKey(ev('KeyZ', 'y'), 'keyCode')).toBe('y');
		// ⌥ changes e.key on macOS: keyCode falls back to the physical key.
		expect(eventKey(ev('KeyB', '∫'), 'keyCode')).toBe('b');
		expect(eventKey(ev('Enter', 'Enter'), 'keyCode')).toBe('enter');
	});
});

describe('window.title variables', () => {
	test('profile and remote are empty, so VS Code defaults render without them', () => {
		const ctx = { editor: { short: 'main.ts' }, rootName: 'kingu', dirty: true, languageId: 'typescript' };
		expect(renderWindowTitle(DEFAULT_TITLE_MAC, ctx)).toBe('main.ts — kingu');
		expect(renderWindowTitle(DEFAULT_TITLE_OTHER, ctx)).toBe('● main.ts — kingu — Kingu');
		expect(renderWindowTitle('${activeEditorLanguageId}${separator}${activeEditorState}', ctx)).toBe('typescript — Modified');
	});
});
