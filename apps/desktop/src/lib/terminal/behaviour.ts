// How the terminal settings that are not xterm options behave (pure, so `bun test` covers them):
// right and middle click, the multi-line paste warning, link schemes, auto replies, OSC 99
// notifications, the tabs list, Cmd+wheel zoom, and which keys the workbench takes from a focused
// terminal. Terminal.svelte, terminals.svelte.ts and the keybinding service apply them.

/** `terminal.integrated.rightClickBehavior` → what a right click does (selectWord: xterm selects, then the menu). */
export function rightClickAction(behavior: string, hasSelection: boolean): 'menu' | 'copy' | 'paste' | 'none' {
	switch (behavior) {
		case 'copyPaste':
			return hasSelection ? 'copy' : 'paste';
		case 'paste':
			return 'paste';
		case 'nothing':
			return 'none';
		default:
			return 'menu';
	}
}

/**
 * `terminal.integrated.enableMultiLinePasteWarning`: whether pasting `text` asks first. `auto`
 * skips the warning when the shell has bracketed paste mode on (it takes multi-line input as one).
 */
export function pasteNeedsWarning(mode: string, text: string, bracketedPasteMode: boolean): boolean {
	if (mode === 'never' || !/\r?\n/.test(text.replace(/\r?\n$/, ''))) return false;
	return mode === 'always' || !bracketedPasteMode;
}

/** `terminal.integrated.allowedLinkSchemes`: whether a link with this URL's scheme may be opened. */
export function linkSchemeAllowed(url: string, schemes: readonly string[]): boolean {
	const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
	return !!m && schemes.some((s) => s.toLowerCase() === m[1].toLowerCase());
}

/**
 * `terminal.integrated.autoReplies`, like VS Code's TerminalAutoResponder: each message is matched
 * character by character across output chunks; on a match its reply is sent, then that reply waits
 * a second before it can fire again. `\r` in a reply is Enter. A `null` reply turns a message off.
 */
export class AutoReplies {
	#entries: { match: string; reply: string; pointer: number; until: number }[];

	constructor(replies: Readonly<Record<string, string | null>>) {
		this.#entries = Object.entries(replies)
			.filter((e): e is [string, string] => typeof e[1] === 'string' && e[0].length > 0)
			.map(([match, reply]) => ({ match, reply, pointer: 0, until: 0 }));
	}

	get empty() {
		return this.#entries.length === 0;
	}

	/** The replies to send for this output chunk, `now` in ms. */
	feed(data: string, now: number): string[] {
		const out: string[] = [];
		for (const e of this.#entries) {
			if (now < e.until) continue;
			for (const ch of data) {
				if (ch === e.match[e.pointer]) e.pointer++;
				else e.pointer = ch === e.match[0] ? 1 : 0;
				if (e.pointer === e.match.length) {
					out.push(e.reply);
					e.pointer = 0;
					e.until = now + 1000;
					break;
				}
			}
		}
		return out;
	}
}

/**
 * OSC 99 desktop notifications (the kitty protocol VS Code's terminal.integrated.enableNotifications
 * handles): `metadata;payload`, metadata `key=value` pairs split by `:`. `p` says whether the
 * payload is the title (default) or the body, `d=0` means more chunks follow for the same `i`, and
 * `e=1` marks a base64 payload. Returns the finished notification, if this chunk completes one.
 */
export class Osc99 {
	#pending = new Map<string, { title: string; body: string }>();

	handle(data: string): { title: string; body: string } | null {
		const semi = data.indexOf(';');
		if (semi < 0) return null;
		const meta = new Map(
			data
				.slice(0, semi)
				.split(':')
				.filter(Boolean)
				.map((kv) => {
					const eq = kv.indexOf('=');
					return eq < 0 ? [kv, ''] : [kv.slice(0, eq), kv.slice(eq + 1)];
				})
		);
		let payload = data.slice(semi + 1);
		if (meta.get('e') === '1') {
			try {
				payload = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
			} catch {
				return null;
			}
		}
		const type = meta.get('p') || 'title';
		if (type !== 'title' && type !== 'body') return null;
		const id = meta.get('i') ?? '';
		const n = this.#pending.get(id) ?? { title: '', body: '' };
		n[type] += payload;
		if (meta.get('d') === '0') {
			this.#pending.set(id, n);
			return null;
		}
		this.#pending.delete(id);
		return n.title || n.body ? n : null;
	}
}

/** `terminal.integrated.tabs.enabled` / `tabs.hideCondition`: whether the tabs list shows. */
export function showTabsList(enabled: boolean, hideCondition: string, terminalCount: number, groupCount: number): boolean {
	if (!enabled || terminalCount === 0) return false;
	if (hideCondition === 'singleTerminal') return terminalCount > 1;
	if (hideCondition === 'singleGroup') return groupCount > 1;
	return true;
}

/**
 * `terminal.integrated.tabs.showActiveTerminal` / `tabs.showActions`: whether the panel title shows
 * the active terminal's name, or the Split and Kill buttons. VS Code's "narrow" is a tabs list too
 * narrow for names; Kingu's list has a fixed width, so a hidden list counts as narrow.
 */
export function panelTitleShows(setting: string, terminalCount: number, tabsListShown: boolean): boolean {
	switch (setting) {
		case 'always':
			return true;
		case 'never':
			return false;
		case 'singleTerminal':
			return terminalCount === 1;
		default:
			return terminalCount === 1 || !tabsListShown;
	}
}

/** `terminal.integrated.mouseWheelZoom`: the font size after one wheel step (6–100 like the setting's range). */
export function zoomedFontSize(size: number, deltaY: number): number {
	if (deltaY === 0) return size;
	return Math.min(100, Math.max(6, size + (deltaY < 0 ? 1 : -1)));
}

/**
 * Whether the workbench runs a keybinding while a terminal has focus, or the key goes to the shell
 * (VS Code's terminalInstance key handler). With `sendKeybindingsToShell` only ⌘ keys reach the
 * workbench. Otherwise every workbench command is skipped from the shell, except ones removed
 * with `-commandId` in `terminal.integrated.commandsToSkipShell` (Kingu has no separate default
 * list: its commands all count as VS Code's default skip list).
 */
export function workbenchTakesKey(commandId: string, metaKey: boolean, sendKeybindingsToShell: boolean, commandsToSkipShell: readonly string[]): boolean {
	if (metaKey) return true;
	if (sendKeybindingsToShell) return false;
	let skip = true;
	for (const c of commandsToSkipShell) {
		if (c === `-${commandId}`) skip = false;
		else if (c === commandId) skip = true;
	}
	return skip;
}

/** `terminal.integrated.allowChords`: whether a key that starts a chord waits for the second key inside a terminal (Escape never does). */
export const terminalStartsChord = (allowChords: boolean, key: string) => allowChords && key !== 'Escape';
