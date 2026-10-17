// Pure chord parsing and matching, kept free of runes so it is unit-testable.

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

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

/** Uses `e.code` for letters and digits so ⌥ combinations on macOS (which change `e.key`) still match. */
export function eventKey(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
	if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
	if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
	if (e.code === 'Backquote') return '`';
	if (e.code === 'Backslash') return '\\';
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

/** Display label in VS Code's macOS style (⌃⌥⇧⌘) or `Ctrl+Shift+P` elsewhere. */
export function keyLabel(chord: string, mac = isMac): string {
	const c = parseChord(chord, mac);
	const key = c.key.length === 1 ? c.key.toUpperCase() : c.key;
	if (mac) return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.meta ? '⌘' : ''}${key}`;
	return [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', key].filter(Boolean).join('+');
}

