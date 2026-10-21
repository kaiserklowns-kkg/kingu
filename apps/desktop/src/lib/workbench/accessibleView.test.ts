import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setLocale } from '#lib/i18n/index.ts';
import { accessibleViewContentOf, chatItems, helpContextOf, helpText, listTarget, notificationText, stepIndex, terminalText, tidyText } from './accessibleView';

setLocale('en');

describe('Accessible View content', () => {
	test('next / previous stop at the ends', () => {
		const c = { items: ['a', 'b', 'c'], index: 0 };
		expect(stepIndex(c, -1)).toBe(0);
		expect(stepIndex(c, 1)).toBe(1);
		expect(stepIndex({ ...c, index: 2 }, 1)).toBe(2);
	});

	test('text is tidied', () => {
		expect(tidyText('a  \r\n\n\n\nb\n')).toBe('a\n\nb');
		expect(terminalText(['$ ls', 'a.txt   ', '', '  '])).toBe('$ ls\na.txt');
	});

	test('notifications', () => {
		expect(notificationText({ severity: 'error', message: 'Failed', source: 'Git', actions: [{ label: 'Retry' }, { label: 'Open Log' }] })).toBe('Error: Failed\nSource: Git\nActions: Retry, Open Log');
		expect(notificationText({ severity: 'info', message: 'Saved' })).toBe('Info: Saved');
	});

	test('chat turns: request then response; a running one says so', () => {
		expect(chatItems([{ request: 'hi', response: 'hello', done: true }, { response: '', done: false }, { request: 'more', response: 'par', done: false }, { request: 'next', response: '', done: false }])).toEqual([
			'Request: hi\n\nResponse: hello',
			'Request: more\n\nResponse: par\n\nThe response is still being written.',
			'Request: next\n\nThe response is still being written.'
		]);
	});

	test('the first owning provider with content wins', () => {
		const providers = [
			{ owns: (el: string) => el === 'chat', content: () => ({ kind: 'chat' as const, items: [], index: 0 }) },
			{ owns: (el: string) => el.startsWith('ch'), content: () => ({ kind: 'chat' as const, items: ['x'], index: 0 }) }
		];
		expect(accessibleViewContentOf(providers, 'chat')?.items).toEqual(['x']);
		expect(accessibleViewContentOf(providers, 'editor')).toBeNull();
	});
});

describe('Accessibility Help', () => {
	const none = { notebook: false, terminal: false, chat: false, notification: false, editor: false, list: false };
	test('context from focus', () => {
		expect(helpContextOf(none)).toBe('workbench');
		expect(helpContextOf({ ...none, editor: true, notebook: true })).toBe('notebook');
		expect(helpContextOf({ ...none, list: true })).toBe('list');
		expect(helpContextOf({ ...none, terminal: true })).toBe('terminal');
	});

	test('keys come from the keymap; missing ones point to the palette', () => {
		const keys: Record<string, string> = { 'editor.action.accessibleView': '⌥F2', 'workbench.action.showCommands': '⇧⌘P' };
		const text = helpText('editor', (id, fallback) => keys[id] ?? fallback ?? '', true);
		expect(text).toContain('You are in a code editor.');
		expect(text).toContain('Accessible View: ⌥F2');
		expect(text).toContain('Toggle Tab Key Moves Focus: ctrl+shift+m');
		expect(text).toContain('Screen reader optimized mode is on');
		expect(text).toContain('workbench.action.gotoLine (no key binding');
		for (const ctx of ['terminal', 'chat', 'notifications', 'notebook', 'list', 'workbench'] as const) expect(helpText(ctx, () => 'K', false).length).toBeGreaterThan(40);
	});
});

describe('list keyboard navigation', () => {
	test('arrow, home, end, page keys', () => {
		expect(listTarget('ArrowDown', -1, 5)).toBe(0);
		expect(listTarget('ArrowUp', -1, 5)).toBe(4);
		expect(listTarget('ArrowDown', 4, 5)).toBe(4);
		expect(listTarget('ArrowUp', 0, 5)).toBe(0);
		expect(listTarget('Home', 3, 5)).toBe(0);
		expect(listTarget('End', 0, 5)).toBe(4);
		expect(listTarget('PageDown', 0, 50, 10)).toBe(10);
		expect(listTarget('PageUp', 5, 50, 10)).toBe(0);
		expect(listTarget('Enter', 1, 5)).toBeNull();
		expect(listTarget('ArrowDown', 0, 0)).toBeNull();
	});

	/** Lists whose keys are handled somewhere this scan can't see, with where. */
	const HANDLED_ELSEWHERE: Record<string, string> = {
		'agent/SlashSuggest.svelte': 'the composer input moves the suggestion (Composer.svelte)',
		'ade/RecentTabSwitcher.svelte': 'the ⌃Tab switcher is driven by the held modifier and Tab (adeTabs)',
		'testing/TestingView.svelte': 'rows are buttons in Tab order; arrow keys belong to the testing view (another area)'
	};

	test('every list and tree in the app can be walked with the keyboard', () => {
		const src = join(import.meta.dir, '..');
		const missing: string[] = [];
		for (const file of new Glob('**/*.svelte').scanSync(src)) {
			const text = readFileSync(join(src, file), 'utf8');
			if (!/role="(tree|list|listbox|grid|treegrid)"/.test(text)) continue;
			if (/use:listKeys|onkeydown|listKeydown|ArrowDown/.test(text) || file in HANDLED_ELSEWHERE) continue;
			missing.push(file);
		}
		expect(missing).toEqual([]);
	});
});
