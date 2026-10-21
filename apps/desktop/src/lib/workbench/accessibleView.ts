// The Accessible View and Accessibility Help (VS Code's accessibleView.ts / accessibilityHelp):
// what has focus as plain text a screen reader can walk line by line, one item at a time with
// next / previous (notifications, chat responses), and the keys that matter where focus is.
// Pure: the providers (accessibleView.svelte.ts) hand in the raw content.

import { t } from '#lib/i18n/index.ts';

export type AccessibleKind = 'hover' | 'notification' | 'terminal' | 'chat' | 'output';
export type AccessibleContent = { kind: AccessibleKind; items: string[]; index: number };

/** Where Accessibility Help was asked from (VS Code's per-view help providers). */
export type HelpContext = 'editor' | 'terminal' | 'chat' | 'notifications' | 'notebook' | 'list' | 'workbench';

export const kindLabel = (k: AccessibleKind): string =>
	({
		hover: () => t('accessibility.kind.hover'),
		notification: () => t('accessibility.kind.notification'),
		terminal: () => t('accessibility.kind.terminal'),
		chat: () => t('accessibility.kind.chat'),
		output: () => t('accessibility.kind.output')
	})[k]();

/** The content of the first provider that owns `el` and has something to show. */
export function accessibleViewContentOf<E>(providers: { owns: (el: E) => boolean; content: (el: E) => AccessibleContent | null }[], el: E): AccessibleContent | null {
	for (const p of providers) {
		if (!p.owns(el)) continue;
		const c = p.content(el);
		if (c?.items.length) return c;
	}
	return null;
}

/** The index after a Next (1) / Previous (-1); it stops at the ends (VS Code does not wrap). */
export function stepIndex(c: Pick<AccessibleContent, 'items' | 'index'>, delta: 1 | -1): number {
	return Math.max(0, Math.min(c.items.length - 1, c.index + delta));
}

/** Text with trailing spaces and runs of blank lines tidied (a hover's or a terminal's). */
export function tidyText(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((l) => l.replace(/\s+$/, ''))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** A terminal's buffer: its lines without the empty rows below the prompt. */
export function terminalText(lines: string[]): string {
	let end = lines.length;
	while (end > 0 && !lines[end - 1].trim()) end--;
	return lines
		.slice(0, end)
		.map((l) => l.replace(/\s+$/, ''))
		.join('\n');
}

export type NotificationLike = { severity: string; message: string; source?: string; actions?: { label: string }[] };

export function notificationText(n: NotificationLike): string {
	const lines = [`${n.severity === 'error' ? 'Error' : n.severity === 'warning' ? 'Warning' : 'Info'}: ${n.message}`];
	if (n.source) lines.push(t('accessibility.notification.source', { source: n.source }));
	if (n.actions?.length) lines.push(t('accessibility.notification.actions', { actions: n.actions.map((a) => a.label).join(', ') }));
	return lines.join('\n');
}

export type ChatTurnLike = { request?: string; response: string; done: boolean };

/** One item per turn: the request, then its response (VS Code reads the response; the request gives it context). */
export function chatItems(turns: ChatTurnLike[]): string[] {
	return turns
		.filter((tn) => tn.request || tn.response)
		.map((tn) => {
			const parts: string[] = [];
			if (tn.request) parts.push(t('accessibility.chat.request', { text: tn.request }));
			parts.push(tn.response ? t('accessibility.chat.response', { text: tn.response }) : t('accessibility.chat.pending'));
			if (tn.response && !tn.done) parts.push(t('accessibility.chat.pending'));
			return parts.join('\n\n');
		});
}

/** The help context of the focused element, from the closest marker around it (outermost last). */
export function helpContextOf(markers: { notebook: boolean; terminal: boolean; chat: boolean; notification: boolean; editor: boolean; list: boolean }): HelpContext {
	if (markers.notification) return 'notifications';
	if (markers.notebook) return 'notebook';
	if (markers.terminal) return 'terminal';
	if (markers.chat) return 'chat';
	if (markers.editor) return 'editor';
	if (markers.list) return 'list';
	return 'workbench';
}

/**
 * Accessibility Help for `context`. `key(command, fallback)` is the key label of a command (the
 * user's keybinding first), or '' when it has none; `fallback` is a key Monaco binds itself.
 */
export function helpText(context: HelpContext, key: (command: string, fallback?: string) => string, screenReader: boolean): string {
	const k = (command: string, fallback?: string) => key(command, fallback) || t('accessibility.help.noKey', { command });
	const view = k('editor.action.accessibleView');
	const next = k('editor.action.accessibleViewNext');
	const previous = k('editor.action.accessibleViewPrevious');
	const lines: string[] = [];
	switch (context) {
		case 'editor':
			lines.push(
				t('accessibility.help.editor.intro'),
				t('accessibility.help.editor.hover', { key: k('editor.action.showHover', 'cmd+k cmd+i') }),
				t('accessibility.help.editor.problem', { key: k('editor.action.marker.next', 'alt+f8') }),
				t('accessibility.help.editor.tabFocus', { key: k('editor.action.toggleTabFocusMode', 'ctrl+shift+m') }),
				t('accessibility.help.editor.gotoLine', { key: k('workbench.action.gotoLine') })
			);
			break;
		case 'terminal':
			lines.push(
				t('accessibility.help.terminal.intro'),
				t('accessibility.help.terminal.view', { key: view }),
				t('accessibility.help.terminal.commands', { previous: k('workbench.action.terminal.scrollToPreviousCommand'), next: k('workbench.action.terminal.scrollToNextCommand') }),
				t('accessibility.help.terminal.recent', { key: k('workbench.action.terminal.runRecentCommand') }),
				t('accessibility.help.terminal.find', { key: k('workbench.action.terminal.focusFind') })
			);
			break;
		case 'chat':
			lines.push(
				t('accessibility.help.chat.intro'),
				t('accessibility.help.chat.view', { key: view, next, previous }),
				t('accessibility.help.chat.input', { key: k('workbench.action.chat.focusInput') }),
				t('accessibility.help.chat.new', { key: k('workbench.action.chat.newChat') })
			);
			break;
		case 'notifications':
			lines.push(
				t('accessibility.help.notifications.intro'),
				t('accessibility.help.notifications.view', { key: view, next, previous }),
				t('accessibility.help.notifications.list', { key: k('notifications.showList'), hide: k('notifications.hideToasts') })
			);
			break;
		case 'notebook':
			lines.push(
				t('accessibility.help.notebook.intro'),
				t('accessibility.help.notebook.keys'),
				t('accessibility.help.notebook.run', { run: k('notebook.cell.execute'), next: k('notebook.cell.executeAndSelectBelow') })
			);
			break;
		case 'list':
			lines.push(t('accessibility.help.list.intro'), t('accessibility.help.list.keys'));
			break;
		case 'workbench':
			lines.push(t('accessibility.help.workbench.intro'), t('accessibility.help.workbench.quickOpen', { key: k('workbench.action.quickOpen') }));
			break;
	}
	if (context !== 'terminal' && context !== 'chat' && context !== 'notifications') lines.push(t('accessibility.help.common.view', { key: view }));
	lines.push(
		t('accessibility.help.common.screenReader', { state: screenReader ? t('accessibility.help.on') : t('accessibility.help.off'), key: k('editor.action.toggleScreenReaderAccessibilityMode') }),
		t('accessibility.help.common.palette', { key: k('workbench.action.showCommands') }),
		t('accessibility.help.common.settings', { key: k('workbench.action.openSettings') })
	);
	return lines.join('\n\n');
}

// --- Keyboard navigation of lists ---------------------------------------------------------------

/**
 * The item a key moves to in a list of `count` items from `current` (-1: none focused): ↑/↓ one,
 * Home/End the ends, PageUp/PageDown a page. Null when the key does not move.
 */
export function listTarget(key: string, current: number, count: number, page = 10): number | null {
	if (count <= 0) return null;
	const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
	switch (key) {
		case 'ArrowDown':
			return current < 0 ? 0 : clamp(current + 1);
		case 'ArrowUp':
			return current < 0 ? count - 1 : clamp(current - 1);
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		case 'PageDown':
			return clamp(Math.max(current, 0) + page);
		case 'PageUp':
			return clamp(Math.max(current, 0) - page);
		default:
			return null;
	}
}
