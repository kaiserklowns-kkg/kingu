import { describe, expect, test } from 'bun:test';
import { resolveSettings } from '#lib/settings/registry.ts';
import {
	adeTerminalSettings,
	composeTheme,
	dividerColor,
	jisYenInput,
	paneOpacity,
	parseOsc52,
	quickCommandInput,
	quickCommands,
	stripSelectionGutter,
	tuiWheelReports,
	MAX_OSC52_BASE64
} from './adeTerminalOptions.ts';

const defaults = () => {
	const m = resolveSettings({}, {});
	return adeTerminalSettings((id) => m.get(id)?.value as never);
};

describe('ADE terminal settings (Orca Terminal page)', () => {
	test("Orca's defaults", () => {
		const s = defaults();
		expect(s).toMatchObject({
			activePaneOpacity: 1,
			inactivePaneOpacity: 0.9,
			paneOpacityTransitionMs: 140,
			dividerColorDark: '#3f3f46',
			dividerColorLight: '#d4d4d8',
			dividerThicknessPx: 3,
			backgroundOpacity: 1,
			cursorOpacity: 1,
			allowOsc52Clipboard: true,
			copyTrimsGutter: true,
			middleClickPaste: true,
			focusFollowsMouse: false,
			mouseHideWhileTyping: false,
			jisYenToBackslash: false,
			tuiScrollSensitivity: 1
		});
		expect(resolveSettings({}, {}).get('kingu.terminal.scopeHistoryByWorktree')?.value).toBe(true);
	});

	test('out-of-range values fall back to the default', () => {
		const m = resolveSettings({ 'kingu.terminal.inactivePaneOpacity': 5, 'kingu.terminal.dividerThicknessPx': 2.5, 'kingu.terminal.paddingX': 12 }, {});
		expect(m.get('kingu.terminal.inactivePaneOpacity')?.source).toBe('default');
		expect(m.get('kingu.terminal.dividerThicknessPx')?.source).toBe('default');
		expect(m.get('kingu.terminal.paddingX')).toEqual({ value: 12, source: 'user' });
	});

	test('quick commands are user-only (text typed into a shell)', () => {
		const m = resolveSettings({}, { 'kingu.terminal.quickCommands': { x: 'rm -rf ~' } });
		expect(m.get('kingu.terminal.quickCommands')?.source).toBe('default');
	});

	test('pane opacity dims only unfocused panes of a split', () => {
		const s = { activePaneOpacity: 1, inactivePaneOpacity: 0.6 };
		expect([paneOpacity(s, true, true), paneOpacity(s, false, true), paneOpacity(s, false, false)]).toEqual([1, 0.6, 1]);
		expect(dividerColor({ dividerColorDark: 'nope', dividerColorLight: '#fff' }, true)).toBe('#3f3f46');
		expect(dividerColor({ dividerColorDark: 'nope', dividerColorLight: '#fff' }, false)).toBe('#fff');
	});

	test('color overrides and opacities compose over the theme', () => {
		const t = composeTheme({ background: '#000000', cursor: '#ffffff', red: '#aa0000' }, { colorOverrides: { red: '#ff5555', blue: 'url(x)', nope: '#123' } as Record<string, string>, backgroundOpacity: 0.5, cursorOpacity: 1 });
		expect(t.red).toBe('#ff5555');
		expect(t.blue).toBeUndefined();
		expect(t.background).toBe('rgba(0, 0, 0, 0.5)');
		expect(t.cursor).toBe('#ffffff');
	});

	test('copy trims the shared gutter only', () => {
		expect(stripSelectionGutter('  a\n    b\n\n  c')).toBe('a\n  b\n\nc');
		expect(stripSelectionGutter('a\n  b')).toBe('a\n  b');
		expect(stripSelectionGutter('  a\r\n  b')).toBe('a\r\nb');
	});

	test('OSC 52 writes only, bounded', () => {
		expect(parseOsc52(`c;${btoa('hi')}`)).toEqual({ kind: 'write', text: 'hi' });
		expect(parseOsc52('c;?')).toEqual({ kind: 'query' });
		expect(parseOsc52('c;').kind).toBe('invalid');
		expect(parseOsc52('x;aGk=').kind).toBe('invalid');
		expect(parseOsc52(`c;${'A'.repeat(MAX_OSC52_BASE64 + 4)}`)).toEqual({ kind: 'invalid', reason: 'too large' });
		expect(parseOsc52('c;***').kind).toBe('invalid');
	});

	test('JIS Yen key and TUI wheel', () => {
		const key = { type: 'keydown', key: '¥', code: 'IntlYen', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
		expect(jisYenInput(key, true, true)).toEqual({ type: 'input', data: '\\' });
		expect(jisYenInput({ ...key, type: 'keyup' }, true, true)).toEqual({ type: 'suppress' });
		expect(jisYenInput(key, false, true)).toBeNull();
		expect(jisYenInput(key, true, false)).toBeNull();
		const carry = { value: 0 };
		expect([1, 2, 3, 4].map(() => tuiWheelReports(1.5, carry))).toEqual([1, 2, 1, 2]);
		expect(tuiWheelReports(99, { value: 0 })).toBe(10);
	});

	test('quick commands', () => {
		expect(quickCommands({ ' Tests ': 'bun test', Empty: '  ', Bad: 3, Two: 'a\nb' })).toEqual([
			{ label: 'Tests', command: 'bun test' },
			{ label: 'Two', command: 'a\nb' }
		]);
		expect(quickCommandInput('a\nb')).toBe('a\rb\r');
	});
});
