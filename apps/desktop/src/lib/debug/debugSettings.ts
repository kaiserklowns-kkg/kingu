// What the debug.* settings decide (VS Code: debug.contribution.ts and the views that read them).
// Pure, so every rule is unit-tested; debug.svelte.ts and the views call these with the values.

import type { OutputLine } from './model.ts';
import type { Scope, Variable } from './protocol.ts';

export type ToolBarLocation = 'floating' | 'docked' | 'commandCenter' | 'hidden';

/** `debug.toolBarLocation`: whether the toolbar instance at `placement` shows. The command center
 * placement needs `window.commandCenter`; without it the toolbar floats, like VS Code. */
export function toolbarShown(placement: Exclude<ToolBarLocation, 'hidden'>, location: ToolBarLocation, commandCenter: boolean): boolean {
	if (location === 'commandCenter' && !commandCenter) return placement === 'floating';
	return placement === location;
}

/** `debug.openDebug: openOnDebugBreak` opens the Run and Debug view when execution breaks. */
export const opensOnBreak = (setting: string) => setting === 'openOnDebugBreak';

/** `debug.showInStatusBar`: the debug status item, from the first session on (or always / never). */
export function statusItemShown(setting: string, sessionsStarted: number): boolean {
	return setting === 'always' || (setting === 'onFirstSessionStart' && sessionsStarted > 0);
}

/** `debug.saveBeforeStart`: the dirty editors of the active group to save (untitled ones too, unless `nonUntitled…`). */
export function editorsToSave(setting: string, groupTabs: readonly string[], isDirty: (p: string) => boolean, isUntitled: (p: string) => boolean): string[] {
	if (setting === 'none') return [];
	return groupTabs.filter((p) => isDirty(p) && !(setting === 'nonUntitledEditorsInActiveGroup' && isUntitled(p)));
}

/** Languages Kingu's debuggers (lldb-dap, Delve, debugpy, js-debug) set breakpoints in, like VS Code's debugger `breakpoints` contributions. */
export const BREAKPOINT_LANGUAGES = new Set(['rust', 'c', 'cpp', 'objective-c', 'objective-cpp', 'swift', 'zig', 'go', 'python', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'html', 'fsharp', 'wat']);

/** `debug.allowBreakpointsEverywhere`: a breakpoint goes only in a debuggable language unless this is on. */
export const canSetBreakpoint = (language: string, everywhere: boolean) => everywhere || BREAKPOINT_LANGUAGES.has(language);

export type ConsoleLine = OutputLine & { count: number };

/** `debug.console.collapseIdenticalLines`: consecutive identical whole lines of the same kind show once with a count. */
export function collapseLines(output: readonly OutputLine[], collapse: boolean): ConsoleLine[] {
	const out: ConsoleLine[] = [];
	for (const line of output) {
		const prev = out.at(-1);
		if (collapse && prev && prev.category === line.category && prev.text === line.text && line.text.endsWith('\n') && line.text.trim()) prev.count++;
		else out.push({ ...line, count: 1 });
	}
	return out;
}

/** `debug.console.fontFamily` (`default` = the workbench's monospace font), fontSize and lineHeight (0 = from the font size). */
export function consoleFont(fontFamily: string, fontSize: number, lineHeight: number): { family: string | null; size: string; lineHeight: string } {
	return { family: fontFamily && fontFamily !== 'default' ? fontFamily : null, size: `${fontSize}px`, lineHeight: lineHeight > 0 ? `${lineHeight}px` : 'normal' };
}

/** `debug.console.historySuggestions`: earlier inputs that start with what is typed, most recent first. */
export function historyMatches(history: readonly string[], input: string, enabled: boolean): string[] {
	if (!enabled || !input) return [];
	return history.filter((h) => h !== input && h.startsWith(input)).slice(0, 10);
}

/** `debug.showVariableTypes`: `name: type` in the Variables view when the adapter sends a type. */
export const variableLabel = (v: Pick<Variable, 'name' | 'type'>, showTypes: boolean) => (showTypes && v.type ? `${v.name}: ${v.type}` : v.name);

/** `debug.breakpointsView.presentation`: a flat list, or a tree with one node per file. */
export type BreakpointRow<T> = { kind: 'file'; rel: string; count: number } | { kind: 'breakpoint'; rel: string; item: T; depth: number };
export function breakpointRows<T>(files: readonly (readonly [string, readonly T[]])[], presentation: string): BreakpointRow<T>[] {
	const rows: BreakpointRow<T>[] = [];
	for (const [rel, list] of files) {
		if (presentation === 'tree') rows.push({ kind: 'file', rel, count: list.length });
		for (const item of list) rows.push({ kind: 'breakpoint', rel, item, depth: presentation === 'tree' ? 1 : 0 });
	}
	return rows;
}

/**
 * `debug.inlineValues: on` without a language's inline values provider (VS Code's fallback): the
 * values of the local variables whose names appear in the lines from the function start to the
 * stopped line, shown after each line. `lines[i]` is line `first + i` (1-based).
 */
export function inlineValues(lines: readonly string[], first: number, variables: readonly Pick<Variable, 'name' | 'value'>[], maxLength = 50): { line: number; text: string }[] {
	const byName = new Map(variables.filter((v) => /^[A-Za-z_$][\w$]*$/.test(v.name)).map((v) => [v.name, v.value]));
	const out: { line: number; text: string }[] = [];
	const seen = new Set<string>();
	// From the stopped line upwards, so each name shows once, nearest the stop (VS Code does the same).
	for (let i = lines.length - 1; i >= 0; i--) {
		const names: string[] = [];
		for (const m of lines[i].matchAll(/[A-Za-z_$][\w$]*/g)) {
			const name = m[0];
			if (byName.has(name) && !seen.has(name)) {
				seen.add(name);
				names.push(name);
			}
		}
		if (!names.length) continue;
		const text = names.map((n) => {
			const v = byName.get(n)!.replace(/\s+/g, ' ');
			return `${n} = ${v.length > maxLength ? `${v.slice(0, maxLength)}…` : v}`;
		});
		out.push({ line: first + i, text: text.join(', ') });
	}
	return out.reverse();
}

/** The scope inline values read: the first non-expensive one (Locals), like VS Code. */
export const localsScope = (scopes: readonly Scope[]) => scopes.find((s) => !s.expensive) ?? null;

/** A session in the session tree (a js-debug child names its parent). */
export type SessionNode = { key: number; parentKey: number | null };

/** The top-level session of `key` (itself when it has no parent). */
export function rootSession(sessions: readonly SessionNode[], key: number): number {
	let s = sessions.find((x) => x.key === key);
	while (s && s.parentKey !== null) {
		const parent = sessions.find((x) => x.key === s!.parentKey);
		if (!parent) break;
		s = parent;
	}
	return s?.key ?? key;
}

/** `debug.showSubSessionsInToolBar`: the sessions the toolbar's session picker lists (only the
 * top-level ones unless the setting is on, VS Code: SelectSessionActionViewItem.getSessions). */
export function toolbarSessions<T extends SessionNode>(sessions: readonly T[], showSubSessions: boolean): T[] {
	return showSubSessions ? [...sessions] : sessions.filter((s) => s.parentKey === null);
}

/** The session the toolbar shows and Stop / Restart act on: the focused one, or (setting off) its
 * top-level session (VS Code walks up `parentSession` when sub-sessions are hidden). */
export function toolbarTarget(sessions: readonly SessionNode[], focusedKey: number | null, showSubSessions: boolean): number | null {
	if (focusedKey === null) return null;
	return showSubSessions ? focusedKey : rootSession(sessions, focusedKey);
}

/** `debug.autoExpandLazyVariables`: `on`, or `auto` with a screen reader (`editor.accessibilitySupport: on`). */
export const autoExpandsLazy = (setting: string, screenReader: boolean) => setting === 'on' || (setting === 'auto' && screenReader);

/** A lazy variable (presentationHint.lazy) shows its one child's value once fetched (VS Code: Variable's lazy button). */
export function lazyValue(v: Pick<Variable, 'variablesReference' | 'presentationHint'> & Partial<Variable>, children: readonly Variable[] | undefined): Variable | null | undefined {
	if (!v.presentationHint?.lazy || v.variablesReference <= 0) return undefined;
	return children && children.length === 1 ? children[0] : null;
}

/** `debug.hideLauncherWhileDebugging`: the Run and Debug view keeps its Start Debugging button while
 * a session runs, unless hidden or replaced by the docked toolbar (VS Code: debugViewlet). */
export const launcherWhileDebugging = (hide: boolean, location: ToolBarLocation) => !hide && location !== 'docked';
