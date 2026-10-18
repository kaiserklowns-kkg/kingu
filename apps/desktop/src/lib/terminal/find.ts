// Find in a terminal (pure parts). The IDE panel behaves like VS Code's terminal find widget
// (Enter searches up, Shift+Enter down, "1 of 5", ⌥⌘C/W/R toggles); ADE terminals like Orca's
// TerminalSearch (Enter next, Shift+Enter previous, "1/5"). Both use @xterm/addon-search.

import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';
import type { TerminalFlavor } from './terminalMenu.ts';
import { t } from '#lib/i18n/index.ts';

/** VS Code's XtermTerminalConstants.SearchHighlightLimit. */
export const HIGHLIGHT_LIMIT = 20000;

export type FindOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
export type FindKeyAction = 'next' | 'previous' | 'close' | 'caseSensitive' | 'wholeWord' | 'regex';

/** The match count shown next to the input. */
export function findStatus(flavor: TerminalFlavor, query: string, index: number, count: number): string {
	if (flavor === 'ade') {
		if (!query) return '0/0';
		if (count === 0) return t('tools.terminal.find.none');
		if (index < 0) return `${count}+`;
		return `${index + 1}/${count}`;
	}
	if (!query) return '';
	if (count === 0) return t('tools.terminal.find.noResults');
	const total = count >= HIGHLIGHT_LIMIT ? `${HIGHLIGHT_LIMIT}+` : String(count);
	return t('tools.terminal.find.of', { index: index < 0 ? '?' : index + 1, total });
}

/** What a key in the find input does. */
export function findKey(flavor: TerminalFlavor, e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>, mac: boolean): FindKeyAction | null {
	if (e.key === 'Escape') return 'close';
	if (e.key === 'Enter') {
		// The terminal searches bottom-up in VS Code, so Enter is Find Previous there.
		if (flavor === 'ide') return e.shiftKey ? 'next' : 'previous';
		return e.shiftKey ? 'previous' : 'next';
	}
	if (flavor === 'ide') {
		if (e.key === 'F3') return e.shiftKey ? 'previous' : 'next';
		if (mac && e.metaKey && e.code === 'KeyG') return e.shiftKey ? 'previous' : 'next';
		const toggle = mac ? e.altKey && e.metaKey : e.altKey && !e.ctrlKey && !e.metaKey;
		if (toggle && e.code === 'KeyC') return 'caseSensitive';
		if (toggle && e.code === 'KeyW') return 'wholeWord';
		if (toggle && e.code === 'KeyR') return 'regex';
	}
	return null;
}

/** Match colors: VS Code's dark defaults (blended onto the terminal background, since xterm
 *  decorations take no alpha) for the IDE, Orca's TerminalSearch colors for the ADE. */
export function findDecorations(flavor: TerminalFlavor) {
	return flavor === 'ide'
		? { matchBackground: '#5B2F10', matchOverviewRuler: '#D18616', activeMatchBackground: '#515C6A', activeMatchColorOverviewRuler: '#A0A0A0' }
		: { matchBackground: '#5c4a00', matchBorder: '#5c4a00', matchOverviewRuler: '#ffcc00', activeMatchBackground: '#c4580e', activeMatchBorder: '#ffcf6b', activeMatchColorOverviewRuler: '#ff9900' };
}

/** Options every terminal needs for find: the search addon highlights matches with
 *  `registerDecoration`, a proposed xterm API that throws without this flag, so every search
 *  failed before reporting its results ("no results" for text on screen). */
export const FIND_TERMINAL_OPTIONS = { allowProposedApi: true } as const;

/** Runs one search step; an empty query clears the highlights. */
export function runFind(search: Pick<SearchAddon, 'findNext' | 'findPrevious' | 'clearDecorations'>, flavor: TerminalFlavor, query: string, opts: FindOptions, dir: 'next' | 'previous', incremental = false): boolean {
	if (!query) {
		search.clearDecorations();
		return false;
	}
	const o: ISearchOptions = { ...opts, incremental, decorations: findDecorations(flavor) };
	return dir === 'next' ? search.findNext(query, o) : search.findPrevious(query, o);
}
