// Every default keybinding in the app, read from the sources' commands.register calls, checked per
// layout and platform: in the Agents layout Orca's keys win, in the IDE VS Code's, and no key runs
// two commands unless their `when`s cannot both hold.

import { expect, test } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_ADE_SHORTCUTS } from '#lib/ade/adeShortcuts.ts';
import { liveKeys, normalizeKey, ownedKeys, type KeyScope } from './keybindingsModel.ts';

type Entry = { file: string; id: string; key?: string; mac?: string; scope?: KeyScope; keyWhen?: string };

const SRC = join(import.meta.dir, '..', '..');

/** The text of the call's argument list starting at `open` (an opening parenthesis). */
function argumentsAt(text: string, open: number): string {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (c === "'" || c === '"' || c === '`') {
			for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
		} else if (c === '/' && text[i + 1] === '/') i = text.indexOf('\n', i);
		else if (c === '(' || c === '{' || c === '[') depth++;
		else if (c === ')' || c === '}' || c === ']') {
			depth--;
			if (depth === 0) return text.slice(open + 1, i);
		}
	}
	throw new Error('unbalanced call');
}

/** `id`, `key`, `mac` and `scope` of the object literal's own properties (not nested ones). */
function ownProps(obj: string): Record<string, string> {
	const out: Record<string, string> = {};
	let depth = 0;
	for (let i = 0; i < obj.length; i++) {
		const c = obj[i];
		if (c === "'" || c === '"' || c === '`') {
			for (i++; i < obj.length && obj[i] !== c; i++) if (obj[i] === '\\') i++;
		} else if (c === '{' || c === '(' || c === '[') depth++;
		else if (c === '}' || c === ')' || c === ']') depth--;
		else if (depth === 1) {
			const m = /^\b(id|key|mac|scope):\s*'([^']*)'/.exec(obj.slice(i));
			if (m && !(m[1] in out) && !/[\w.]/.test(obj[i - 1] ?? '')) out[m[1]] = m[2];
		}
	}
	return out;
}

function registrations(): Entry[] {
	const out: Entry[] = [];
	for (const file of new Glob('lib/**/*.{ts,svelte}').scanSync(SRC)) {
		if (file.endsWith('.test.ts')) continue;
		const text = readFileSync(join(SRC, file), 'utf8');
		if (file.endsWith('adeCommands.svelte.ts')) {
			expect(text).toContain("scope: 'agents'");
			for (const s of ALL_ADE_SHORTCUTS) out.push({ file, ...s, scope: 'agents' });
			continue;
		}
		for (const m of text.matchAll(/commands\.register\(/g)) {
			const arg = argumentsAt(text, m.index + m[0].length - 1).trim();
			if (!arg.startsWith('{')) continue;
			const p = ownProps(arg);
			if (!p.id) continue;
			const keyWhen = /\bkeyWhen:\s*([^,\n]+)/.exec(arg)?.[1].trim();
			out.push({ file, id: p.id, key: p.key, mac: p.mac, scope: p.scope as KeyScope | undefined, keyWhen });
		}
	}
	return out;
}

/**
 * Keys two commands share on purpose in one layout: their `when`s exclude each other, so at most
 * one is enabled. Each pair is the VS Code (or Orca) arrangement.
 */
const EXCLUSIVE: [string, string][] = [
	// Pin / Unpin Editor: VS Code binds both to ⌘K ⇧↵, one per pinned state.
	['workbench.action.pinEditor', 'workbench.action.unpinEditor'],
	// New Chat takes ⌘N only while the chat has focus (keyWhen + weight), New Untitled File elsewhere.
	['workbench.action.chat.newChat', 'workbench.action.files.newUntitledFile'],
	// F11 off macOS (VS Code's keys): Step Into while the debugger is stopped, Toggle Full Screen (lower weight) otherwise.
	['workbench.action.debug.stepInto', 'workbench.action.toggleFullScreen'],
	// Search Again needs an active Search Editor with focus in it, Rerun Task a focused task terminal (Windows/Linux keys).
	['rerunSearchEditorSearch', 'workbench.action.tasks.rerunForActiveTerminal'],
	// Delete File Results acts in the IDE's Search Editor, Delete Workspace only in the Agents layout.
	['search.searchEditor.action.deleteFileResults', 'kingu.agents.deleteWorkspace'],
	// The Search Editor's Match Case / Regex (⌥⌘C / ⌥⌘R) act with focus in it, where Copy Path / Reveal in Finder do not.
	['toggleSearchEditorCaseSensitive', 'copyFilePath'],
	['toggleSearchEditorRegex', 'revealFileInOS']
];

/** VS Code's `terminalFocus` / `!terminalFocus`: one command's key acts only in a focused panel
 *  terminal, the other's only outside one. */
const TERMINAL_ONLY = 'panelTerminalFocus';
const outsideTerminal = (keyWhen?: string) => !!keyWhen && keyWhen.includes('!panelTerminalFocus()');

function exclusive(ids: string[], byId: Map<string, Entry>): boolean {
	if (ids.length !== 2) return false;
	if (EXCLUSIVE.some(([a, b]) => ids.includes(a) && ids.includes(b))) return true;
	const [a, b] = ids.map((id) => byId.get(id)?.keyWhen);
	return (a === TERMINAL_ONLY && outsideTerminal(b)) || (b === TERMINAL_ONLY && outsideTerminal(a));
}

function liveKeymap(entries: Entry[], layout: KeyScope, mac: boolean): Map<string, string[]> {
	const keysOf = (e: Entry) => {
		const k = mac ? (e.mac ?? e.key) : e.key;
		return k ? [normalizeKey(k)] : [];
	};
	const owned = ownedKeys(entries.map((e) => ({ scope: e.scope, keys: keysOf(e) })), layout);
	const map = new Map<string, string[]>();
	for (const e of entries) for (const k of liveKeys(keysOf(e), e.scope, layout, owned)) map.set(k, [...(map.get(k) ?? []), e.id]);
	return map;
}

const entries = registrations();
const byId = new Map(entries.map((e) => [e.id, e]));

test('the scan finds the app keymap', () => {
	const ids = new Set(entries.map((e) => e.id));
	for (const id of ['workbench.action.showAllSymbols', 'workbench.action.quickOpen', 'kingu.ade.tab.newTerminal', 'workbench.action.terminal.focusFind', 'kingu.agents.toggleRightSidebar']) expect(ids).toContain(id);
	expect(entries.filter((e) => e.key || e.mac).length).toBeGreaterThan(80);
});

for (const layout of ['ide', 'agents'] as const)
	for (const mac of [true, false])
		test(`no key runs two commands in the ${layout} layout (${mac ? 'macOS' : 'Windows/Linux'})`, () => {
			const clashes = [...liveKeymap(entries, layout, mac)].filter(([, ids]) => ids.length > 1 && !exclusive(ids, byId));
			expect(clashes).toEqual([]);
		});

test('Orca keys in the Agents layout, VS Code keys in the IDE', () => {
	for (const mac of [true, false]) {
		const agents = liveKeymap(entries, 'agents', mac);
		const ide = liveKeymap(entries, 'ide', mac);
		expect(agents.get('cmd+t')).toEqual(['kingu.ade.tab.newTerminal']);
		expect(ide.get('cmd+t')).toEqual(['workbench.action.showAllSymbols']);
		expect(agents.get('cmd+shift+t')).toEqual(['kingu.ade.tab.reopenClosed']);
		expect(ide.get('cmd+shift+t')).toEqual(['workbench.action.reopenClosedEditor']);
		expect(agents.get('ctrl+tab')).toEqual(['kingu.ade.tab.previousRecent']);
		expect(agents.get('cmd+shift+e')).toEqual(['kingu.agents.rightSidebar.explorer']);
		expect(ide.get('cmd+shift+e')).toEqual(['workbench.view.explorer']);
		// Shared by both layouts.
		expect(agents.get('cmd+p')).toEqual(['workbench.action.quickOpen']);
		expect(ide.get('cmd+p')).toEqual(['workbench.action.quickOpen']);
	}
	// Every Orca shortcut with a key is live in the Agents layout and in none in the IDE.
	for (const s of ALL_ADE_SHORTCUTS)
		for (const mac of [true, false]) {
			const k = mac ? (s.mac ?? s.key) : s.key;
			if (!k) continue;
			expect(liveKeymap(entries, 'agents', mac).get(normalizeKey(k))).toContain(s.id);
			expect(liveKeymap(entries, 'ide', mac).get(normalizeKey(k)) ?? []).not.toContain(s.id);
		}
});

test('a scoped key wins over an unscoped default; the user’s own key stays', () => {
	const owned = new Set(['cmd+t']);
	expect(liveKeys(['cmd+t'], undefined, 'agents', owned)).toEqual([]);
	expect(liveKeys(['cmd+t'], undefined, 'agents', owned, ['cmd+t'])).toEqual(['cmd+t']);
	expect(liveKeys(['cmd+t'], 'agents', 'agents', owned)).toEqual(['cmd+t']);
	expect(liveKeys(['cmd+t'], 'agents', 'ide', new Set())).toEqual([]);
	expect(liveKeys(['cmd+shift+e'], 'ide', 'ide', new Set())).toEqual(['cmd+shift+e']);
});
