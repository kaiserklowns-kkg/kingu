// Pure chord parsing and matching, kept free of runes so it is unit-testable.

export const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

export type Chord = { meta: boolean; ctrl: boolean; shift: boolean; alt: boolean; key: string };

export function parseChord(chord: string, mac = isMac): Chord {
	const parts = chord.toLowerCase().split('+');
	const key = parts.pop() ?? '';
	const has = (m: string) => parts.includes(m);
	return {
		meta: mac ? has('cmd') : false,
		ctrl: has('ctrl') || (!mac && has('cmd')),
		shift: has('shift'),
		alt: has('alt'),
		key
	};
}

/** `keyboard.dispatch`: match keybindings by the physical key (`code`) or by what the key types in the layout (`keyCode`). */
export type KeyboardDispatch = 'code' | 'keyCode';
let dispatch: KeyboardDispatch = 'code';
export function setKeyboardDispatch(value: KeyboardDispatch) {
	dispatch = value === 'keyCode' ? 'keyCode' : 'code';
}
export const keyboardDispatch = (): KeyboardDispatch => dispatch;

/** Punctuation by physical key: Shift changes `e.key` (`,` → `<`), so they match by code. */
const CODE_KEYS: Record<string, string> = {
	Backquote: '`',
	Backslash: '\\',
	IntlBackslash: '\\',
	Minus: '-',
	Equal: '=',
	BracketLeft: '[',
	BracketRight: ']',
	Comma: ',',
	Period: '.',
	Slash: '/',
	Semicolon: ';',
	Quote: "'"
};
/** The numeric keypad as VS Code names it (`numpad1`, `numpad_add`…). */
const NUMPAD: Record<string, string> = { NumpadAdd: 'numpad_add', NumpadSubtract: 'numpad_subtract', NumpadMultiply: 'numpad_multiply', NumpadDivide: 'numpad_divide', NumpadDecimal: 'numpad_decimal', NumpadEnter: 'enter' };

/**
 * With `keyboard.dispatch: code` (VS Code's default) letters and digits match by `e.code`, so ⌥
 * combinations on macOS (which change `e.key`) still match and the physical key works in any
 * layout. With `keyCode`, a key that types a plain letter or digit matches by that character
 * (⌘Z is the key labelled Z on a Dvorak or AZERTY keyboard).
 */
export function eventKey(e: Pick<KeyboardEvent, 'key' | 'code'>, mode: KeyboardDispatch = dispatch): string {
	if (mode === 'keyCode' && /^[a-z0-9]$/i.test(e.key)) return e.key.toLowerCase();
	if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
	if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
	if (/^Numpad\d$/.test(e.code)) return `numpad${e.code.slice(6)}`;
	if (NUMPAD[e.code]) return NUMPAD[e.code];
	// Shift changes `e.key` (`-` → `_`, `]` → `}`), so ⌃⇧- (Go Forward) and Orca's ⌘⇧] match by
	// code. With keyCode the character the layout types wins for these too, unless Shift changed it.
	if (CODE_KEYS[e.code]) return mode === 'keyCode' && e.key.length === 1 && Object.values(CODE_KEYS).includes(e.key) ? e.key : CODE_KEYS[e.code];
	if (e.key.startsWith('Arrow')) return e.key.slice(5).toLowerCase();
	if (e.key === ' ') return 'space';
	if (e.key === 'Esc') return 'escape';
	return e.key.toLowerCase();
}

export function matches(chord: Chord, e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): boolean {
	return (
		chord.key === eventKey(e) &&
		chord.meta === e.metaKey &&
		chord.ctrl === e.ctrlKey &&
		chord.shift === e.shiftKey &&
		chord.alt === e.altKey
	);
}

const MAC_KEY_LABELS: Record<string, string> = { left: '←', right: '→', up: '↑', down: '↓', enter: '↩', escape: '⎋', backspace: '⌫', pageup: 'PageUp', pagedown: 'PageDown' };
const KEY_LABELS: Record<string, string> = { left: 'LeftArrow', right: 'RightArrow', up: 'UpArrow', down: 'DownArrow', pageup: 'PageUp', pagedown: 'PageDown' };
const keyName = (key: string) => (key.length === 1 || /^f\d+$/.test(key) ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));

/** Display label in VS Code's macOS style (⌃⌥⇧⌘) or `Ctrl+Shift+P` elsewhere; chord parts joined by a space. */
export function keyLabel(keybinding: string, mac = isMac): string {
	return keyParts(keybinding, mac)
		.map((keys) => keys.join(mac ? '' : '+'))
		.join(' ');
}

/** The keys of each chord part, one keycap each (VS Code's KeybindingLabel): `[['⌃', '⌘', 'I']]`. */
export function keyParts(keybinding: string, mac = isMac): string[][] {
	return splitKeybinding(keybinding).map((part) => {
		const c = parseChord(part, mac);
		const key = mac ? (MAC_KEY_LABELS[c.key] ?? keyName(c.key)) : (KEY_LABELS[c.key] ?? keyName(c.key));
		const mods = mac ? [c.ctrl && '⌃', c.alt && '⌥', c.shift && '⇧', c.meta && '⌘'] : [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift'];
		return [...mods.filter((m): m is string => !!m), key];
	});
}

/** A keybinding is one chord (`cmd+p`) or a two-part chord like VS Code's `cmd+k cmd+t`. */
export function splitKeybinding(keybinding: string): string[] {
	return keybinding.trim().split(/\s+/);
}

/** Label of a pressed key combination, e.g. `⌘K` (for chord status messages). */
export function eventLabel(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac = isMac): string {
	const mods = [e.ctrlKey && (mac ? 'ctrl' : 'cmd'), e.altKey && 'alt', e.shiftKey && 'shift', mac && e.metaKey && 'cmd'].filter(Boolean);
	return keyLabel([...mods, eventKey(e)].join('+'), mac);
}

/** Modifier keydowns never complete a chord (VS Code waits for the next real key). */
export function isModifierKey(e: Pick<KeyboardEvent, 'key'>): boolean {
	return ['Meta', 'Control', 'Shift', 'Alt', 'CapsLock', 'Fn'].includes(e.key);
}


const ACCELERATOR_KEYS: Record<string, string> = {
	'`': 'Backquote',
	'\\': 'Backslash',
	',': 'Comma',
	'.': 'Period',
	'=': 'Equal',
	'-': 'Minus',
	'/': 'Slash',
	';': 'Semicolon',
	"'": 'Quote',
	'[': 'BracketLeft',
	']': 'BracketRight',
	left: 'ArrowLeft',
	right: 'ArrowRight',
	up: 'ArrowUp',
	down: 'ArrowDown',
	enter: 'Enter',
	escape: 'Escape',
	space: 'Space',
	tab: 'Tab',
	backspace: 'Backspace',
	delete: 'Delete',
	pageup: 'PageUp',
	pagedown: 'PageDown',
	home: 'Home',
	end: 'End'
};

/**
 * A native menu accelerator (Tauri/muda syntax, e.g. `Shift+Cmd+P`) for a keybinding, or null for
 * two-part chords, which native menus cannot express (VS Code's macOS menus omit them too).
 */
export function toAccelerator(keybinding: string, mac = isMac): string | null {
	const parts = splitKeybinding(keybinding);
	if (parts.length !== 1) return null;
	const c = parseChord(parts[0], mac);
	let key = ACCELERATOR_KEYS[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : null);
	if (!key && /^f\d{1,2}$/.test(c.key)) key = c.key.toUpperCase();
	if (!key) return null;
	return [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', c.meta && 'Cmd', key].filter(Boolean).join('+');
}

/** The keybinding on this platform: VS Code's `mac:` override, else `key`. */
export function keyOf(binding: { key?: string; mac?: string }, mac = isMac): string | undefined {
	return (mac ? binding.mac : undefined) ?? binding.key;
}

/**
 * A keyboard chord and the native menu could both deliver one keypress: the webview's listener runs
 * the command and, if the OS also fired the menu item's accelerator, the menu event would follow
 * within milliseconds. The menu side skips a run of the same command that close behind the key.
 */
export const MENU_ECHO_MS = 300;

export function isMenuEcho(id: string, now: number, lastKey: { id: string; at: number } | null): boolean {
	return lastKey !== null && lastKey.id === id && now - lastKey.at >= 0 && now - lastKey.at < MENU_ECHO_MS;
}
