/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { KEYBINDINGS_TEMPLATE, keysFor, normalizeKey, parseKeybindings, userKeybindings } from './keybindingsModel';

describe('keybindings.json', () => {
	test('parses JSONC arrays and skips malformed entries', () => {
		const text = `// mine
		[
			{ "key": "cmd+i", "command": "workbench.action.quickOpen" }, // add
			{ "key": "cmd+p", "command": "-workbench.action.quickOpen" },
			{ "command": 3 },
			"nope",
		]`;
		expect(parseKeybindings(text)).toEqual([
			{ key: 'cmd+i', command: 'workbench.action.quickOpen' },
			{ key: 'cmd+p', command: '-workbench.action.quickOpen' }
		]);
		expect(parseKeybindings('')).toEqual([]);
		expect(parseKeybindings(KEYBINDINGS_TEMPLATE)).toEqual([]);
		expect(() => parseKeybindings('{ "key": "x" }')).toThrow();
	});

	test('user keys come first; removals drop the default', () => {
		const user = userKeybindings([
			{ key: 'Cmd+I', command: 'quickOpen' },
			{ key: 'cmd+p', command: '-quickOpen' },
			{ command: '-toggleSidebar' },
			{ key: 'cmd+k  cmd+x', command: 'newCommand' }
		]);
		expect(keysFor('quickOpen', 'cmd+p', user)).toEqual(['cmd+i']);
		expect(keysFor('toggleSidebar', 'cmd+b', user)).toEqual([]);
		expect(keysFor('newCommand', undefined, user)).toEqual(['cmd+k cmd+x']);
		expect(keysFor('untouched', 'cmd+j', user)).toEqual(['cmd+j']);
		// Removing only another key keeps the default.
		expect(keysFor('quickOpen', 'cmd+o', userKeybindings([{ key: 'cmd+p', command: '-quickOpen' }]))).toEqual(['cmd+o']);
	});

	test('later entries win', () => {
		const user = userKeybindings([
			{ key: 'cmd+1', command: 'a' },
			{ key: 'cmd+2', command: 'a' },
			{ key: 'cmd+1', command: '-a' }
		]);
		expect(keysFor('a', undefined, user)).toEqual(['cmd+2']);
		expect(normalizeKey('  Ctrl+Shift+P   Ctrl+K ')).toBe('ctrl+shift+p ctrl+k');
	});
});
