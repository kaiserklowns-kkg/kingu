/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { eventLabel, isModifierKey, keyLabel, keyParts, matches, parseChord, splitKeybinding } from './keys';

describe('two-part chords', () => {
	test('split and label like VS Code', () => {
		expect(splitKeybinding('cmd+k cmd+t')).toEqual(['cmd+k', 'cmd+t']);
		expect(splitKeybinding('cmd+,')).toEqual(['cmd+,']);
		expect(keyLabel('cmd+k cmd+t', true)).toBe('⌘K ⌘T');
		expect(keyLabel('cmd+k cmd+t', false)).toBe('Ctrl+K Ctrl+T');
	});

	test('keycaps per key, modifiers in VS Code order', () => {
		expect(keyParts('ctrl+cmd+i', true)).toEqual([['⌃', '⌘', 'I']]);
		expect(keyParts('cmd+shift+p', true)).toEqual([['⇧', '⌘', 'P']]);
		expect(keyParts('cmd+shift+p', false)).toEqual([['Ctrl', 'Shift', 'P']]);
		expect(keyParts('cmd+k z', true)).toEqual([['⌘', 'K'], ['Z']]);
	});

	test('labels a pressed key and ignores lone modifiers', () => {
		const e = { key: 'k', code: 'KeyK', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
		expect(eventLabel(e, true)).toBe('⌘K');
		expect(eventLabel({ ...e, metaKey: false, ctrlKey: true }, false)).toBe('Ctrl+K');
		expect(isModifierKey({ key: 'Meta' })).toBe(true);
		expect(isModifierKey({ key: 't' })).toBe(false);
	});
});

describe('Go Back / Go Forward chords', () => {
	const ev = (code: string, key: string, mods: Partial<KeyboardEvent> = {}) => ({ code, key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

	test('⌃⇧- matches by code although Shift turns the key into `_`', () => {
		expect(matches(parseChord('ctrl+-', true), ev('Minus', '-', { ctrlKey: true }))).toBe(true);
		expect(matches(parseChord('ctrl+shift+-', true), ev('Minus', '_', { ctrlKey: true, shiftKey: true }))).toBe(true);
		expect(matches(parseChord('ctrl+-', true), ev('Minus', '_', { ctrlKey: true, shiftKey: true }))).toBe(false);
	});

	test('arrow keys are `left`/`right` in keybindings', () => {
		expect(matches(parseChord('alt+left', false), ev('ArrowLeft', 'ArrowLeft', { altKey: true }))).toBe(true);
		expect(keyLabel('ctrl+shift+cmd+right', true)).toBe('⌃⇧⌘→');
		expect(keyLabel('alt+left', false)).toBe('Alt+LeftArrow');
		expect(keyLabel('f12', true)).toBe('F12');
	});
});
