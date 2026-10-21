// The Keyboard Shortcuts editor's model (VS Code: KeybindingsEditorModel and
// KeybindingEditingService). Pure: the rows (one per command and key, plus unbound commands), the
// search (`@source:user`, `@command:id`, a recorded `"cmd+k cmd+t"`), same-key conflicts, and the
// keybindings.json edits behind Change / Add / Remove / Reset / Change When Expression.

import { appendArrayElement, arrayElements, removeArrayElements } from '#lib/settings/jsonc.ts';
import { eventKey, isMac, keyboardDispatch, keyLabel, parseChord, splitKeybinding, type KeyboardDispatch } from './keys';
import { keysFor, normalizeKey, parseKeybindings, whenKey, type KeyScope, type UserKeybindings } from './keybindingsModel';

export type KeybindingSource = 'user' | 'default' | '';

export type KeybindingRow = {
	command: string;
	/** `Category: Title`, or the id of a keybindings.json command Kingu does not register. */
	title: string;
	/** Normalized keybinding, '' for a command with none. */
	key: string;
	when: string;
	source: KeybindingSource;
	scope?: KeyScope;
	/** The command's KeybindingWeight (a higher one wins a shared key among defaults). */
	weight?: number;
};

export type KeybindingCommand = { id: string; title: string; category?: string; palette?: boolean; scope?: KeyScope; defaultKey?: string; weight?: number };

/** `ctrl+shift+alt+cmd+k`: modifiers in VS Code's order, so `shift+cmd+p` and `cmd+shift+p` compare
 * equal. Off macOS `cmd` is Ctrl (keys.parseChord), so it becomes `ctrl`. */
export function canonicalKey(key: string, mac = isMac): string {
	return splitKeybinding(normalizeKey(key))
		.filter(Boolean)
		.map((part) => {
			const c = parseChord(part, mac);
			return [c.ctrl && 'ctrl', c.shift && 'shift', c.alt && 'alt', c.meta && 'cmd', c.key].filter(Boolean).join('+');
		})
		.join(' ');
}

/** Every row: a command's user keys, then its default unless removed, or one unbound row. User
 * entries for commands Kingu does not register are listed under their id. */
export function keybindingRows(cmds: readonly KeybindingCommand[], user: UserKeybindings): KeybindingRow[] {
	const rows: KeybindingRow[] = [];
	const seen = new Set<string>();
	for (const c of cmds) {
		seen.add(c.id);
		const userKeys = user.added.get(c.id) ?? [];
		const keys = keysFor(c.id, c.defaultKey, user);
		const title = c.category ? `${c.category}: ${c.title}` : c.title;
		for (const key of keys) {
			const fromUser = userKeys.includes(key);
			rows.push({ command: c.id, title, key, when: fromUser ? (user.when.get(whenKey(c.id, key)) ?? '') : '', source: fromUser ? 'user' : 'default', scope: c.scope, weight: c.weight });
		}
		if (!keys.length && c.palette !== false) rows.push({ command: c.id, title, key: '', when: '', source: '', scope: c.scope });
	}
	for (const [id, keys] of user.added)
		if (!seen.has(id)) for (const key of keys) rows.push({ command: id, title: id, key, when: user.when.get(whenKey(id, key)) ?? '', source: 'user' });
	return rows;
}

export type KeybindingQuery = { source?: 'user' | 'default'; command?: string; key?: string; conflicts?: boolean; text: string };

/** `@source:user`, `@source:default` (also `system`), `@command:id`, `@conflicts` (Show Conflicts), a quoted keybinding, and words. */
export function parseKeybindingQuery(query: string): KeybindingQuery {
	const out: KeybindingQuery = { text: '' };
	const rest = query
		.replace(/@source:\s*(\w+)/gi, (_, s: string) => {
			const v = s.toLowerCase();
			if (v === 'user') out.source = 'user';
			else if (v === 'default' || v === 'system') out.source = 'default';
			return '';
		})
		.replace(/@command:\s*(\S+)/gi, (_, id: string) => ((out.command = id), ''))
		.replace(/@conflicts\b/gi, () => ((out.conflicts = true), ''))
		.replace(/"([^"]*)"?/, (_, k: string) => ((out.key = k.trim()), ''));
	out.text = rest.trim().toLowerCase();
	return out;
}

/** Rows matching a parsed query. Words match the title, id, key (as typed or as shown), when and source. */
export function filterKeybindingRows(rows: readonly KeybindingRow[], query: KeybindingQuery, mac = isMac): KeybindingRow[] {
	const exact = query.key ? canonicalKey(query.key, mac) : '';
	const words = query.text.split(/\s+/).filter(Boolean);
	const counts = query.conflicts ? new Map(conflictCounts(rows, mac).map((n, i) => [rows[i], n])) : null;
	return rows.filter((r) => {
		if (counts && !counts.get(r)) return false;
		if (query.source && r.source !== query.source) return false;
		if (query.command && r.command !== query.command) return false;
		if (query.key !== undefined && (!r.key || canonicalKey(r.key, mac) !== exact)) return false;
		if (!words.length) return true;
		const hay = [r.title, r.command, r.key, r.key && keyLabel(r.key, mac), r.when, r.source].join('\n').toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

const overlaps = (a?: KeyScope, b?: KeyScope) => !a || !b || a === b;

/** The other rows bound to `key` in a layout `scope` shares (VS Code's Show Same Keybindings). */
export function sameKeyRows(rows: readonly KeybindingRow[], key: string, scope?: KeyScope, except?: KeybindingRow, mac = isMac): KeybindingRow[] {
	if (!key) return [];
	const k = canonicalKey(key, mac);
	return rows.filter((r) => r !== except && r.key && overlaps(r.scope, scope) && canonicalKey(r.key, mac) === k);
}

/** How many other commands each bound row shares its key with, by row index. */
export function conflictCounts(rows: readonly KeybindingRow[], mac = isMac): number[] {
	const byKey = new Map<string, number[]>();
	rows.forEach((r, i) => r.key && byKey.set(canonicalKey(r.key, mac), [...(byKey.get(canonicalKey(r.key, mac)) ?? []), i]));
	return rows.map((r, i) => (r.key ? (byKey.get(canonicalKey(r.key, mac)) ?? []).filter((j) => j !== i && rows[j].command !== r.command && overlaps(rows[j].scope, r.scope)).length : 0));
}

/**
 * Sort by Precedence (VS Code's toggle): the order the dispatcher tries bindings in — keybindings.json
 * before the defaults, a higher weight first within each — then the unbound commands.
 */
export function sortByPrecedence(rows: readonly KeybindingRow[]): KeybindingRow[] {
	const rank = (r: KeybindingRow) => (r.source === 'user' ? 0 : r.source === 'default' ? 1 : 2);
	return rows
		.map((r, i) => ({ r, i }))
		.sort((a, b) => rank(a.r) - rank(b.r) || (b.r.weight ?? 0) - (a.r.weight ?? 0) || a.i - b.i)
		.map((x) => x.r);
}

/**
 * Bindings that make `key` unreachable or that it makes unreachable: for a two-part chord, a binding
 * of its first part alone (it runs before the second key is pressed); for one key, the chords that
 * start with it.
 */
export function chordPrefixRows(rows: readonly KeybindingRow[], key: string, scope?: KeyScope, except?: string, mac = isMac): KeybindingRow[] {
	const parts = splitKeybinding(canonicalKey(key, mac));
	if (!key.trim()) return [];
	return rows.filter((r) => {
		if (!r.key || r.command === except || !overlaps(r.scope, scope)) return false;
		const other = splitKeybinding(canonicalKey(r.key, mac));
		return parts.length === 2 ? other.length === 1 && other[0] === parts[0] : other.length === 2 && other[0] === parts[0];
	});
}

// --- Recording (the define-keybinding widget and the search's Record Keys mode)

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

/** Keys a keybinding cannot name: dead keys, IME composition, unknown keys, modifiers alone. */
const UNRECORDABLE = new Set(['', 'dead', 'unidentified', 'process', 'meta', 'control', 'shift', 'alt', 'altgraph', 'capslock', 'fn', 'fnlock', 'os']);

/**
 * A pressed chord as keybindings.json writes it: `cmd+shift+p` on macOS, `ctrl+shift+p` elsewhere
 * (the Windows key off macOS is not a keybinding modifier). '' for a key that cannot be bound.
 * Letters and digits follow `keyboard.dispatch` like the dispatcher does.
 */
export function recordedChord(e: KeyEventLike, mac = isMac, mode: KeyboardDispatch = keyboardDispatch()): string {
	const key = eventKey(e, mode);
	const named = key === ' ' ? 'space' : key === 'esc' ? 'escape' : key;
	if (UNRECORDABLE.has(named)) return '';
	return [e.ctrlKey && 'ctrl', e.shiftKey && 'shift', e.altKey && 'alt', mac && e.metaKey && 'cmd', named].filter(Boolean).join('+');
}

/** The next recorded keybinding: a second chord makes a two-part chord, a third starts over. */
export const appendChord = (current: string, chord: string) => (!chord ? current : current && splitKeybinding(current).length === 1 ? `${current} ${chord}` : chord);

/** The chords of a keybinding for display, each as its own label (`⌘K`, `⌘T`). */
export const chordLabels = (key: string, mac = isMac): string[] => splitKeybinding(key).filter(Boolean).map((part) => keyLabel(part, mac));

// --- keybindings.json edits (each takes and returns the file's text)

type Entry = { key?: string; command: string; when?: string; args?: unknown };

/** Indexes of entries matching the predicate. A file that does not parse is an error for the caller. */
function entryIndexes(text: string, match: (e: Entry) => boolean): number[] {
	const root = arrayElements(text);
	if (!root) return [];
	// Parse each element alone, so indexes line up with the text even when some are not objects.
	return root.elements.flatMap((el, i) => {
		try {
			const [e] = parseKeybindings(`[${text.slice(el.start, el.end)}]`);
			return e && match(e) ? [i] : [];
		} catch {
			return [];
		}
	});
}

const sameKey = (a: string | undefined, b: string, mac: boolean) => typeof a === 'string' && canonicalKey(a, mac) === canonicalKey(b, mac);

const entry = (key: string, command: string, when?: string): Entry => (when?.trim() ? { key, command, when: when.trim() } : { key, command });

/** Adds a key for a command (Add Keybinding…). */
export function addKeybinding(text: string, command: string, key: string, when?: string): string {
	parseKeybindings(text);
	return appendArrayElement(text, entry(key, command, when));
}

/** Removes a row's key: a user entry is deleted, a default one gets a `-command` entry. */
export function removeKeybinding(text: string, row: Pick<KeybindingRow, 'command' | 'key' | 'source' | 'when'>, mac = isMac): string {
	parseKeybindings(text);
	if (!row.key) return text;
	if (row.source === 'user') return removeArrayElements(text, entryIndexes(text, (e) => e.command === row.command && sameKey(e.key, row.key, mac)));
	return appendArrayElement(text, entry(row.key, `-${row.command}`, row.when));
}

/** Change Keybinding… (and Change When Expression…, which keeps the key): the old key goes the way
 * Remove Keybinding takes it, the new one is added. An unbound row only gets the new key. */
export function changeKeybinding(text: string, row: Pick<KeybindingRow, 'command' | 'key' | 'source' | 'when'>, key: string, when: string | undefined, mac = isMac): string {
	const removed = row.key ? removeKeybinding(text, row, mac) : (parseKeybindings(text), text);
	return appendArrayElement(removed, entry(key, row.command, when ?? row.when));
}

/** Reset Keybinding: drops every keybindings.json entry for the command, so its default is back. */
export function resetKeybinding(text: string, command: string): string {
	parseKeybindings(text);
	return removeArrayElements(text, entryIndexes(text, (e) => e.command === command || e.command === `-${command}`));
}
