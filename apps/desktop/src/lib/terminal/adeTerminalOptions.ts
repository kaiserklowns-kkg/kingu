// The ADE terminal settings (`kingu.terminal.*`, Orca's Terminal page) turned into what the
// terminals and their split view apply. Pure, so `bun test` covers it; Terminal.svelte and
// PaneSplitView.svelte bind it live.

import type { ITheme } from '@xterm/xterm';

type Get = <T = unknown>(id: string) => T;

export type AdeTerminalSettings = {
	activePaneOpacity: number;
	inactivePaneOpacity: number;
	paneOpacityTransitionMs: number;
	dividerColorDark: string;
	dividerColorLight: string;
	dividerThicknessPx: number;
	backgroundOpacity: number;
	cursorOpacity: number;
	colorOverrides: Record<string, string>;
	paddingX: number;
	paddingY: number;
	allowOsc52Clipboard: boolean;
	copyTrimsGutter: boolean;
	middleClickPaste: boolean;
	focusFollowsMouse: boolean;
	mouseHideWhileTyping: boolean;
	jisYenToBackslash: boolean;
	tuiScrollSensitivity: number;
};

export function adeTerminalSettings(get: Get): AdeTerminalSettings {
	const k = (name: string) => get(`kingu.terminal.${name}`);
	return {
		activePaneOpacity: k('activePaneOpacity') as number,
		inactivePaneOpacity: k('inactivePaneOpacity') as number,
		paneOpacityTransitionMs: k('paneOpacityTransitionMs') as number,
		dividerColorDark: k('dividerColorDark') as string,
		dividerColorLight: k('dividerColorLight') as string,
		dividerThicknessPx: k('dividerThicknessPx') as number,
		backgroundOpacity: k('backgroundOpacity') as number,
		cursorOpacity: k('cursorOpacity') as number,
		colorOverrides: (k('colorOverrides') as Record<string, string>) ?? {},
		paddingX: k('paddingX') as number,
		paddingY: k('paddingY') as number,
		allowOsc52Clipboard: k('allowOsc52Clipboard') !== false,
		copyTrimsGutter: k('copyTrimsGutter') !== false,
		middleClickPaste: k('middleClickPaste') !== false,
		focusFollowsMouse: k('focusFollowsMouse') === true,
		mouseHideWhileTyping: k('mouseHideWhileTyping') === true,
		jisYenToBackslash: k('jisYenToBackslash') === true,
		tuiScrollSensitivity: k('tuiScrollSensitivity') as number
	};
}

// --- Colors -------------------------------------------------------------------------------------

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v.trim());

/** `#abc` / `#aabbcc` with `alpha` as `rgba(…)`. */
export function hexToRgba(hex: string, alpha: number): string {
	let c = hex.trim().replace('#', '');
	if (c.length === 3) c = [...c].map((x) => x + x).join('');
	const n = (i: number) => Number.parseInt(c.slice(i, i + 2), 16);
	return `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${alpha})`;
}

/** The xterm theme keys `colorOverrides` may set (Orca's TerminalColorOverrides). */
export const COLOR_KEYS = [
	'foreground',
	'background',
	'cursor',
	'cursorAccent',
	'selectionBackground',
	'selectionForeground',
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
	'brightBlack',
	'brightRed',
	'brightGreen',
	'brightYellow',
	'brightBlue',
	'brightMagenta',
	'brightCyan',
	'brightWhite'
] as const;

/** A CSS color the terminal may use: hex, rgb()/rgba()/hsl(), or a plain color name. */
const isCssColor = (v: string) => HEX.test(v) || /^(?:rgba?|hsla?)\([\d\s.,%/]+\)$/i.test(v) || /^[a-z]{3,20}$/i.test(v);

/** Orca's composeActiveTerminalTheme: overrides over the base, then background and cursor alpha (hex only). */
export function composeTheme(base: ITheme, s: Pick<AdeTerminalSettings, 'colorOverrides' | 'backgroundOpacity' | 'cursorOpacity'>): ITheme {
	const theme: Record<string, unknown> = { ...base };
	for (const key of COLOR_KEYS) {
		const v = s.colorOverrides[key];
		if (typeof v === 'string' && isCssColor(v.trim())) theme[key] = v.trim();
	}
	const t = theme as ITheme;
	if (s.backgroundOpacity < 1 && isHexColor(t.background)) t.background = hexToRgba(t.background, s.backgroundOpacity);
	if (s.cursorOpacity < 1 && isHexColor(t.cursor)) t.cursor = hexToRgba(t.cursor, s.cursorOpacity);
	return t;
}

// --- Split panes ----------------------------------------------------------------------------------

/** One pane's opacity: only a split tab dims its unfocused panes (a single pane stays as is). */
export function paneOpacity(s: Pick<AdeTerminalSettings, 'activePaneOpacity' | 'inactivePaneOpacity'>, active: boolean, split: boolean): number {
	if (!split) return 1;
	return active ? s.activePaneOpacity : s.inactivePaneOpacity;
}

/** The divider's color for the theme kind, falling back to Orca's default for a bad value. */
export function dividerColor(s: Pick<AdeTerminalSettings, 'dividerColorDark' | 'dividerColorLight'>, dark: boolean): string {
	const v = dark ? s.dividerColorDark : s.dividerColorLight;
	return isHexColor(v) ? v.trim() : dark ? '#3f3f46' : '#d4d4d8';
}

// --- Copy ---------------------------------------------------------------------------------------

/**
 * Orca's stripTerminalSelectionGutter: drop the run of leading spaces every non-blank selected
 * line shares (the gutter agent CLIs paint behind), keeping relative indentation. A CR stays with
 * its line so CRLF selections behave the same.
 */
export function stripSelectionGutter(selection: string): string {
	const lines = selection.split('\n').map((raw) => {
		const cr = raw.endsWith('\r');
		const text = cr ? raw.slice(0, -1) : raw;
		return { text, cr, indent: /^ */.exec(text)![0].length };
	});
	let gutter = Infinity;
	for (const l of lines) {
		if (l.indent === l.text.length) continue;
		gutter = Math.min(gutter, l.indent);
		if (gutter === 0) return selection;
	}
	if (!Number.isFinite(gutter) || gutter === 0) return selection;
	return lines.map((l) => l.text.slice(Math.min(l.indent, gutter)) + (l.cr ? '\r' : '')).join('\n');
}

// --- OSC 52 -------------------------------------------------------------------------------------

export const MAX_OSC52_BASE64 = 128 * 1024;

export type Osc52 = { kind: 'write'; text: string } | { kind: 'query' } | { kind: 'invalid'; reason: string };

/** Orca's parseOsc52: `<selections>;<base64>`; `?` is a clipboard read, never answered. */
export function parseOsc52(data: string): Osc52 {
	const semi = data.indexOf(';');
	if (semi === -1) return { kind: 'invalid', reason: 'missing separator' };
	const selections = data.slice(0, semi) || 'c';
	const payload = data.slice(semi + 1);
	if (!/^[cpqs0-7]+$/.test(selections)) return { kind: 'invalid', reason: 'unknown selection' };
	if (payload === '?') return { kind: 'query' };
	if (payload.length > MAX_OSC52_BASE64) return { kind: 'invalid', reason: 'too large' };
	const b64 = payload.replace(/\s+/g, '');
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { kind: 'invalid', reason: 'not base64' };
	let text: string;
	try {
		const bin = atob(b64);
		text = new TextDecoder('utf-8').decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
	} catch {
		return { kind: 'invalid', reason: 'not base64' };
	}
	// An empty write is "clear the clipboard": declined, any program could blank it.
	if (!text) return { kind: 'invalid', reason: 'empty' };
	return { kind: 'write', text };
}

// --- Keys and wheel -----------------------------------------------------------------------------

type KeyLike = { type: string; key: string; code?: string; keyCode?: number; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

/**
 * Orca's resolveTerminalJisYenInput: the physical JIS ¥ key (IntlYen, no modifier, no IME) types
 * a backslash on macOS; its keypress/keyup are swallowed so ¥ never follows.
 */
export function jisYenInput(e: KeyLike, enabled: boolean, mac: boolean): { type: 'input'; data: string } | { type: 'suppress' } | null {
	if (!enabled || !mac) return null;
	if (e.keyCode === 229 || e.code !== 'IntlYen' || e.key !== '¥' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
	if (e.type === 'keydown') return { type: 'input', data: '\\' };
	if (e.type === 'keypress' || e.type === 'keyup') return { type: 'suppress' };
	return null;
}

/**
 * Wheel events a TUI receives for one real one at `multiplier` (1–10): the whole part each time,
 * the fraction carried over in `carry` so 1.5 alternates 1 and 2.
 */
export function tuiWheelReports(multiplier: number, carry: { value: number }): number {
	const m = Number.isFinite(multiplier) ? Math.min(10, Math.max(1, multiplier)) : 1;
	const total = m + carry.value;
	const n = Math.floor(total);
	carry.value = total - n;
	return n;
}

// --- Quick commands -----------------------------------------------------------------------------

export const MAX_QUICK_COMMANDS = 40;

/** `kingu.terminal.quickCommands` as a list: trimmed, non-empty, single-line labels (Orca's caps). */
export function quickCommands(map: Readonly<Record<string, unknown>> | undefined): { label: string; command: string }[] {
	return Object.entries(map ?? {})
		.map(([label, command]) => ({ label: label.trim().slice(0, 80), command: typeof command === 'string' ? command.replace(/\s+$/, '') : '' }))
		.filter((q) => q.label && q.command.trim() && q.command.length <= 4000)
		.slice(0, MAX_QUICK_COMMANDS);
}

/** What is typed into the shell: each line followed by Enter, like typing it. */
export function quickCommandInput(command: string): string {
	return `${command.replace(/\r?\n/g, '\r')}\r`;
}
