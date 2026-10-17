/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { windowTitle } from './title';

test('window title follows VS Code: dirty mark, editor, folder, app', () => {
	expect(windowTitle({ editor: 'main.ts', folder: 'kingu' })).toBe('main.ts — kingu — Kingu');
	expect(windowTitle({ editor: 'main.ts', folder: 'kingu', dirty: true })).toBe('● main.ts — kingu — Kingu');
	expect(windowTitle({ editor: null, folder: 'kingu', dirty: true })).toBe('kingu — Kingu');
	expect(windowTitle({ editor: 'Settings', folder: '' })).toBe('Settings — Kingu');
	expect(windowTitle({})).toBe('Kingu');
});
