/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { parseKeybindings, userKeybindings } from './keybindingsModel';
import { eventKey, setKeyboardDispatch } from './keys';
import {
	addKeybinding,
	appendChord,
	canonicalKey,
	changeKeybinding,
	chordLabels,
	chordPrefixRows,
	conflictCounts,
	filterKeybindingRows,
	keybindingRows,
	parseKeybindingQuery,
	recordedChord,
	removeKeybinding,
	resetKeybinding,
	sameKeyRows,
	sortByPrecedence,
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

describe('precedence, conflicts, recording edge cases, chords', () => {
	const cmds: KeybindingCommand[] = [
		{ id: 'a', title: 'A', defaultKey: 'cmd+k' },
		{ id: 'b', title: 'B', defaultKey: 'cmd+k cmd+t', weight: 5 },
		{ id: 'c', title: 'C', defaultKey: 'cmd+j', weight: 1 },
		{ id: 'd', title: 'D', defaultKey: 'cmd+j' },
		{ id: 'e', title: 'E' }
	];
	const rows = keybindingRows(cmds, userKeybindings(parseKeybindings('[{ "key": "cmd+i", "command": "e" }]')));

	test('sort by precedence: user entries, then defaults by weight, then unbound', () => {
		expect(sortByPrecedence(rows).map((r) => r.command)).toEqual(['e', 'b', 'c', 'a', 'd']);
	});

	test('@conflicts shows only keys shared by two commands', () => {
		const q = parseKeybindingQuery('@conflicts');
		expect(q.conflicts).toBe(true);
		expect(filterKeybindingRows(rows, q, true).map((r) => r.command)).toEqual(['c', 'd']);
		expect(filterKeybindingRows(rows, parseKeybindingQuery('@conflicts @command:c'), true).map((r) => r.command)).toEqual(['c']);
	});

	test('a chord and a binding of its first key shadow each other', () => {
		expect(chordPrefixRows(rows, 'cmd+k cmd+t', undefined, 'b', true).map((r) => r.command)).toEqual(['a']);
		expect(chordPrefixRows(rows, 'cmd+k', undefined, 'a', true).map((r) => r.command)).toEqual(['b']);
		expect(chordPrefixRows(rows, 'cmd+j', undefined, 'c', true)).toEqual([]);
	});

	const ev = (key: string, code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({ key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

	test('recording: punctuation with Shift, the keypad, dead and lone modifier keys', () => {
		expect(recordedChord(ev('<', 'Comma', { shiftKey: true, metaKey: true }), true, 'code')).toBe('shift+cmd+,');
		expect(recordedChord(ev('?', 'Slash', { shiftKey: true }), true, 'code')).toBe('shift+/');
		expect(recordedChord(ev('1', 'Numpad1'), true, 'code')).toBe('numpad1');
		expect(recordedChord(ev('+', 'NumpadAdd', { ctrlKey: true }), true, 'code')).toBe('ctrl+numpad_add');
		expect(recordedChord(ev('Dead', 'Unknown', { altKey: true }), true, 'code')).toBe('');
		expect(recordedChord(ev('Unidentified', ''), true, 'code')).toBe('');
		// The Windows key is no keybinding modifier off macOS.
		expect(recordedChord(ev('p', 'KeyP', { metaKey: true, ctrlKey: true }), false, 'code')).toBe('ctrl+p');
		// An unrecordable key keeps what was recorded.
		expect(appendChord('cmd+k', '')).toBe('cmd+k');
	});

	test("keyboard.dispatch: by physical key, or by the layout's character", () => {
		// AZERTY: the key labelled A sits where QWERTY has Q.
		expect(recordedChord(ev('a', 'KeyQ', { metaKey: true }), true, 'code')).toBe('cmd+q');
		expect(recordedChord(ev('a', 'KeyQ', { metaKey: true }), true, 'keyCode')).toBe('cmd+a');
		setKeyboardDispatch('keyCode');
		expect(recordedChord(ev('a', 'KeyQ', { metaKey: true }), true)).toBe('cmd+a');
		expect(eventKey(ev('a', 'KeyQ'))).toBe('a');
		setKeyboardDispatch('code');
		expect(eventKey(ev('a', 'KeyQ'))).toBe('q');
		expect(eventKey(ev(' ', 'Space'))).toBe('space');
	});

	test('chords display as one label per part', () => {
		expect(chordLabels('cmd+k cmd+t', true)).toEqual(['⌘K', '⌘T']);
		expect(chordLabels('ctrl+k ctrl+shift+s', false)).toEqual(['Ctrl+K', 'Ctrl+Shift+S']);
		expect(chordLabels('', true)).toEqual([]);
	});
});
