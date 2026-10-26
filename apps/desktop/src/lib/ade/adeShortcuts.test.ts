import { describe, expect, test } from 'bun:test';
import { keyOf, matches, parseChord } from '#lib/workbench/keys.ts';
import { ADE_SHORTCUTS, ALL_ADE_SHORTCUTS, selectTabShortcut, type Shortcut } from './adeShortcuts.ts';

const keysOn = (mac: boolean) => ALL_ADE_SHORTCUTS.map((s) => keyOf(s, mac)).filter((k): k is string => !!k);

describe("Orca's default keys", () => {
	test('macOS', () => {
		const mac = (s: Shortcut) => keyOf(s, true);
		expect(mac(ADE_SHORTCUTS.newTerminal)).toBe('cmd+t');
		expect(mac(ADE_SHORTCUTS.newBrowser)).toBe('cmd+shift+b');
		expect(mac(ADE_SHORTCUTS.reopenClosed)).toBe('cmd+shift+t');
		expect(mac(ADE_SHORTCUTS.rename)).toBe('cmd+r');
		expect(mac(ADE_SHORTCUTS.recentNext)).toBe('ctrl+tab');
		expect(mac(ADE_SHORTCUTS.next)).toBe('cmd+shift+]');
		expect(mac(ADE_SHORTCUTS.nextTerminal)).toBe('ctrl+pagedown');
		expect(mac(ADE_SHORTCUTS.splitRight)).toBe('cmd+d');
		expect(mac(ADE_SHORTCUTS.splitDown)).toBe('cmd+shift+d');
		expect(mac(ADE_SHORTCUTS.focusNextPane)).toBe('cmd+]');
		expect(mac(ADE_SHORTCUTS.expandPane)).toBe('cmd+shift+enter');
		expect(mac(ADE_SHORTCUTS.clear)).toBe('cmd+k');
		expect(mac(selectTabShortcut(3))).toBe('ctrl+3');
		expect(mac(ADE_SHORTCUTS.equalizePanes)).toBeUndefined();
	});

	test('Windows and Linux', () => {
		const other = (s: Shortcut) => keyOf(s, false);
		// Ctrl+R stays the shell's reverse search.
		expect(other(ADE_SHORTCUTS.rename)).toBeUndefined();
		expect(other(ADE_SHORTCUTS.splitRight)).toBe('cmd+shift+d');
		expect(other(ADE_SHORTCUTS.splitDown)).toBe('alt+shift+d');
		expect(other(selectTabShortcut(9))).toBe('alt+9');
	});

	test('no two shortcuts share a key on either platform', () => {
		for (const mac of [true, false]) {
			const keys = keysOn(mac);
			expect(new Set(keys).size).toBe(keys.length);
		}
	});

	test('the IDE keys that stay live in the Agents layout are left alone', () => {
		const ide = ['cmd+b', 'cmd+alt+b', 'cmd+j', 'cmd+l', 'cmd+shift+j', 'cmd+p', 'cmd+shift+p', 'ctrl+`', 'cmd+o', 'cmd+s', 'cmd+w', 'cmd+f'];
		for (const mac of [true, false]) for (const k of keysOn(mac)) expect(ide).not.toContain(k);
	});

	test('⌘⇧] matches although Shift turns the key into }', () => {
		const e = { key: '}', code: 'BracketRight', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false };
		expect(matches(parseChord('cmd+shift+]', true), e)).toBe(true);
		expect(matches(parseChord('ctrl+tab', true), { key: 'Tab', code: 'Tab', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })).toBe(true);
		expect(matches(parseChord('ctrl+pagedown', true), { key: 'PageDown', code: 'PageDown', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })).toBe(true);
	});
});
