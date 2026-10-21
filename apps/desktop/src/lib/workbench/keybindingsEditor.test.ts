/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { parseKeybindings, userKeybindings } from './keybindingsModel';
import {
	addKeybinding,
	appendChord,
	canonicalKey,
	changeKeybinding,
	conflictCounts,
	filterKeybindingRows,
	keybindingRows,
	parseKeybindingQuery,
	recordedChord,
	removeKeybinding,
	resetKeybinding,
	sameKeyRows,
	type KeybindingCommand
} from './keybindingsEditor';

const CMDS: KeybindingCommand[] = [
	{ id: 'workbench.action.quickOpen', title: 'Go to File...', defaultKey: 'cmd+p' },
	{ id: 'workbench.action.showCommands', title: 'Show All Commands', defaultKey: 'cmd+shift+p' },
	{ id: 'editor.action.formatDocument', title: 'Format Document', category: 'Editor' },
	{ id: 'hidden.command', title: 'Hidden', palette: false },
	{ id: 'agents.newTab', title: 'New Tab', scope: 'agents', defaultKey: 'cmd+t' },
	{ id: 'workbench.action.showAllSymbols', title: 'Go to Symbol in Workspace', scope: 'ide', defaultKey: 'cmd+t' }
];

const rowsFor = (text: string) => keybindingRows(CMDS, userKeybindings(parseKeybindings(text)));

describe('rows', () => {
	test('default, user and unbound rows; palette-hidden unbound commands are left out', () => {
		const rows = rowsFor('[{ "key": "cmd+i", "command": "workbench.action.quickOpen", "when": "editorFocus" }, { "key": "cmd+u", "command": "not.registered" }]');
		expect(rows.filter((r) => r.command === 'workbench.action.quickOpen')).toEqual([
			{ command: 'workbench.action.quickOpen', title: 'Go to File...', key: 'cmd+i', when: 'editorFocus', source: 'user', scope: undefined },
			{ command: 'workbench.action.quickOpen', title: 'Go to File...', key: 'cmd+p', when: '', source: 'default', scope: undefined }
		]);
		expect(rows.find((r) => r.command === 'editor.action.formatDocument')).toMatchObject({ title: 'Editor: Format Document', key: '', source: '' });
		expect(rows.some((r) => r.command === 'hidden.command')).toBe(false);
		expect(rows.find((r) => r.command === 'not.registered')).toMatchObject({ title: 'not.registered', key: 'cmd+u', source: 'user' });
	});

	test('a removed default leaves an unbound row', () => {
		const rows = rowsFor('[{ "key": "cmd+p", "command": "-workbench.action.quickOpen" }]');
		expect(rows.filter((r) => r.command === 'workbench.action.quickOpen')).toEqual([{ command: 'workbench.action.quickOpen', title: 'Go to File...', key: '', when: '', source: '', scope: undefined }]);
	});
});

describe('search', () => {
	const rows = rowsFor('[{ "key": "cmd+i", "command": "workbench.action.quickOpen" }]');

	test('parses @source, @command and a quoted key', () => {
		expect(parseKeybindingQuery('@source:user  file')).toEqual({ source: 'user', text: 'file' });
		expect(parseKeybindingQuery('@source:system')).toEqual({ source: 'default', text: '' });
		expect(parseKeybindingQuery('@command:workbench.action.quickOpen')).toEqual({ command: 'workbench.action.quickOpen', text: '' });
		expect(parseKeybindingQuery('"cmd+k cmd+t"')).toEqual({ key: 'cmd+k cmd+t', text: '' });
		expect(parseKeybindingQuery('"cmd+')).toEqual({ key: 'cmd+', text: '' });
	});

	test('filters by source, command, exact key and words', () => {
		expect(filterKeybindingRows(rows, parseKeybindingQuery('@source:user'), true).map((r) => r.key)).toEqual(['cmd+i']);
		expect(filterKeybindingRows(rows, parseKeybindingQuery('"shift+cmd+p"'), true).map((r) => r.command)).toEqual(['workbench.action.showCommands']);
		expect(filterKeybindingRows(rows, parseKeybindingQuery('format editor'), true).map((r) => r.command)).toEqual(['editor.action.formatDocument']);
		expect(filterKeybindingRows(rows, parseKeybindingQuery('⇧⌘P'), true).map((r) => r.command)).toEqual(['workbench.action.showCommands']);
		expect(filterKeybindingRows(rows, parseKeybindingQuery('@command:workbench.action.quickOpen'), true)).toHaveLength(2);
	});
});

describe('keys', () => {
	test('canonical order; cmd is ctrl off macOS', () => {
		expect(canonicalKey('Shift+Cmd+P', true)).toBe('shift+cmd+p');
		expect(canonicalKey('alt+ctrl+shift+cmd+k  cmd+t', true)).toBe('ctrl+shift+alt+cmd+k cmd+t');
		expect(canonicalKey('cmd+p', false)).toBe(canonicalKey('ctrl+p', false));
	});

	test('records chords and chains two', () => {
		const e = { key: 'P', code: 'KeyP', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false };
		expect(recordedChord(e, true)).toBe('shift+cmd+p');
		expect(recordedChord({ ...e, metaKey: false, ctrlKey: true }, false)).toBe('ctrl+shift+p');
		expect(recordedChord({ key: ' ', code: 'Space', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, true)).toBe('ctrl+space');
		expect(appendChord('', 'cmd+k')).toBe('cmd+k');
		expect(appendChord('cmd+k', 'cmd+t')).toBe('cmd+k cmd+t');
		expect(appendChord('cmd+k cmd+t', 'cmd+p')).toBe('cmd+p');
	});

	test('same keybindings and conflicts respect the layout scope', () => {
		const rows = rowsFor('[{ "key": "cmd+shift+p", "command": "editor.action.formatDocument" }]');
		const format = rows.find((r) => r.command === 'editor.action.formatDocument')!;
		expect(sameKeyRows(rows, format.key, format.scope, format, true).map((r) => r.command)).toEqual(['workbench.action.showCommands']);
		const counts = conflictCounts(rows, true);
		expect(counts[rows.indexOf(format)]).toBe(1);
		// ⌘T is Orca's in the Agents layout and VS Code's in the IDE: no conflict.
		expect(counts[rows.findIndex((r) => r.command === 'agents.newTab')]).toBe(0);
	});
});

describe('keybindings.json edits', () => {
	const read = (text: string) => parseKeybindings(text);

	test('add appends and keeps comments', () => {
		const text = '// mine\n[\n\t// a comment\n]\n';
		const out = addKeybinding(text, 'x', 'cmd+i', 'editorFocus');
		expect(out).toBe('// mine\n[\n\t// a comment\n\t{\n\t\t"key": "cmd+i",\n\t\t"command": "x",\n\t\t"when": "editorFocus"\n\t}\n]\n');
		expect(read(addKeybinding(out, 'y', 'cmd+u'))).toEqual([{ key: 'cmd+i', command: 'x', when: 'editorFocus' }, { key: 'cmd+u', command: 'y' }]);
		expect(read(addKeybinding('', 'y', 'cmd+u'))).toEqual([{ key: 'cmd+u', command: 'y' }]);
	});

	test('remove deletes a user entry and masks a default one', () => {
		const text = '[\n\t{ "key": "cmd+i", "command": "x" },\n\t// keep me\n\t{ "key": "cmd+j", "command": "y" }\n]\n';
		const out = removeKeybinding(text, { command: 'x', key: 'cmd+i', source: 'user', when: '' }, true);
		expect(out).toBe('[\n\t// keep me\n\t{ "key": "cmd+j", "command": "y" }\n]\n');
		const last = removeKeybinding(text, { command: 'y', key: 'cmd+j', source: 'user', when: '' }, true);
		expect(read(last)).toEqual([{ key: 'cmd+i', command: 'x' }]);
		expect(read(removeKeybinding(text, { command: 'z', key: 'cmd+p', source: 'default', when: '' }, true)).at(-1)).toEqual({ key: 'cmd+p', command: '-z' });
	});

	test('change replaces a user key, or masks the default and adds the new one', () => {
		const text = '[{ "key": "cmd+i", "command": "x", "when": "a" }]';
		expect(read(changeKeybinding(text, { command: 'x', key: 'cmd+i', source: 'user', when: 'a' }, 'cmd+u', undefined, true))).toEqual([{ key: 'cmd+u', command: 'x', when: 'a' }]);
		expect(read(changeKeybinding('[]', { command: 'q', key: 'cmd+p', source: 'default', when: '' }, 'cmd+p', 'editorFocus', true))).toEqual([
			{ key: 'cmd+p', command: '-q' },
			{ key: 'cmd+p', command: 'q', when: 'editorFocus' }
		]);
		expect(read(changeKeybinding('[]', { command: 'f', key: '', source: '', when: '' }, 'alt+f', undefined, true))).toEqual([{ key: 'alt+f', command: 'f' }]);
	});

	test('reset drops every entry for the command', () => {
		const text = '[{ "key": "cmd+i", "command": "x" }, { "key": "cmd+p", "command": "-x" }, { "key": "cmd+j", "command": "y" }]';
		expect(read(resetKeybinding(text, 'x'))).toEqual([{ key: 'cmd+j', command: 'y' }]);
	});

	test('a file that does not parse is not edited', () => {
		expect(() => addKeybinding('[{ "key": ', 'x', 'cmd+i')).toThrow();
		expect(() => resetKeybinding('{}', 'x')).toThrow();
	});
});
