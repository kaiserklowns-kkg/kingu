// keybindings.json keys as Monaco keybinding numbers, so a `-editor.action.x` entry can remove
// Monaco's own default (monaco.editor.addKeybindingRule with a `-` command). Pure: the enums are
// passed in.

import { parseChord, splitKeybinding } from './keys';

export type MonacoKeyEnums = {
	KeyMod: { CtrlCmd: number; Shift: number; Alt: number; WinCtrl: number; chord(first: number, second: number): number };
	KeyCode: Record<string, number | string>;
};

const NAMED: Record<string, string> = {
	left: 'LeftArrow',
	right: 'RightArrow',
	up: 'UpArrow',
	down: 'DownArrow',
	enter: 'Enter',
	escape: 'Escape',
	space: 'Space',
	tab: 'Tab',
	backspace: 'Backspace',
	delete: 'Delete',
	home: 'Home',
	end: 'End',
	pageup: 'PageUp',
	pagedown: 'PageDown',
	insert: 'Insert',
	'/': 'Slash',
	'\\': 'Backslash',
	'[': 'BracketLeft',
	']': 'BracketRight',
	';': 'Semicolon',
	"'": 'Quote',
	',': 'Comma',
	'.': 'Period',
	'-': 'Minus',
	'=': 'Equal',
	'`': 'Backquote'
};

function codeName(key: string): string | null {
	if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
	if (/^\d$/.test(key)) return `Digit${key}`;
	if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
	return NAMED[key] ?? null;
}

function encodeChord(part: string, e: MonacoKeyEnums, mac: boolean): number | null {
	const c = parseChord(part, mac);
	const name = codeName(c.key);
	const code = name ? e.KeyCode[name] : undefined;
	if (typeof code !== 'number') return null;
	let n = code;
	// CtrlCmd is ⌘ on macOS and Ctrl elsewhere; WinCtrl is the real Ctrl key on macOS.
	if (mac ? c.meta : c.ctrl) n |= e.KeyMod.CtrlCmd;
	if (mac && c.ctrl) n |= e.KeyMod.WinCtrl;
	if (c.shift) n |= e.KeyMod.Shift;
	if (c.alt) n |= e.KeyMod.Alt;
	return n;
}

/** `cmd+k cmd+c` → Monaco's number, or null when a key has no Monaco code. */
export function toMonacoKeybinding(key: string, e: MonacoKeyEnums, mac: boolean): number | null {
	const parts = splitKeybinding(key).map((p) => encodeChord(p, e, mac));
	if (parts.some((p) => p === null) || !parts.length || parts.length > 2) return null;
	return parts.length === 2 ? e.KeyMod.chord(parts[0]!, parts[1]!) : parts[0];
}
