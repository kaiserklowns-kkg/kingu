/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { eventLabel, isModifierKey, keyLabel, splitKeybinding } from './keys';

describe('two-part chords', () => {
	test('split and label like VS Code', () => {
		expect(splitKeybinding('cmd+k cmd+t')).toEqual(['cmd+k', 'cmd+t']);
		expect(splitKeybinding('cmd+,')).toEqual(['cmd+,']);
		expect(keyLabel('cmd+k cmd+t', true)).toBe('⌘K ⌘T');
		expect(keyLabel('cmd+k cmd+t', false)).toBe('Ctrl+K Ctrl+T');
	});

	test('labels a pressed key and ignores lone modifiers', () => {
		const e = { key: 'k', code: 'KeyK', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
		expect(eventLabel(e, true)).toBe('⌘K');
		expect(eventLabel({ ...e, metaKey: false, ctrlKey: true }, false)).toBe('Ctrl+K');
		expect(isModifierKey({ key: 'Meta' })).toBe(true);
		expect(isModifierKey({ key: 't' })).toBe(false);
	});
});
