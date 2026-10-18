// Settings → what each consumer takes (VS Code: the editor/terminal/search contributions that read
// configuration). Pure, so `bun test` checks every mapping; apply.svelte.ts and the views call these
// with `settings.get`.

import type * as Monaco from 'monaco-editor';
import type { ITerminalOptions } from '@xterm/xterm';

export type Get = <T = unknown>(id: string) => T;

/** Monaco editor options (VS Code: editor.* configuration). */
export function editorOptionsFrom(get: Get): Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions {
	const quick = get<boolean>('editor.quickSuggestions');
	const lineNumbers = get<string>('editor.lineNumbers');
	return {
		fontSize: get<number>('editor.fontSize'),
		fontFamily: get<string>('editor.fontFamily'),
		fontWeight: get<string>('editor.fontWeight'),
		fontLigatures: get<boolean>('editor.fontLigatures'),
		lineHeight: get<number>('editor.lineHeight'),
		letterSpacing: get<number>('editor.letterSpacing'),
		wordWrap: get<'off' | 'on' | 'wordWrapColumn' | 'bounded'>('editor.wordWrap'),
		wordWrapColumn: get<number>('editor.wordWrapColumn'),
		lineNumbers: lineNumbers === 'interval' ? (n) => (n % 10 === 0 || n === 1 ? String(n) : '') : (lineNumbers as 'on' | 'off' | 'relative'),
		rulers: [...get<number[]>('editor.rulers')],
		renderWhitespace: get<'none' | 'boundary' | 'selection' | 'trailing' | 'all'>('editor.renderWhitespace'),
		renderLineHighlight: get<'none' | 'gutter' | 'line' | 'all'>('editor.renderLineHighlight'),
		renderControlCharacters: get<boolean>('editor.renderControlCharacters'),
		minimap: {
			enabled: get<boolean>('editor.minimap.enabled'),
			side: get<'left' | 'right'>('editor.minimap.side'),
			renderCharacters: get<boolean>('editor.minimap.renderCharacters')
		},
		cursorStyle: get<Monaco.editor.IEditorOptions['cursorStyle']>('editor.cursorStyle'),
		cursorBlinking: get<Monaco.editor.IEditorOptions['cursorBlinking']>('editor.cursorBlinking'),
		cursorSmoothCaretAnimation: get<'off' | 'explicit' | 'on'>('editor.cursorSmoothCaretAnimation'),
		cursorSurroundingLines: get<number>('editor.cursorSurroundingLines'),
		bracketPairColorization: { enabled: get<boolean>('editor.bracketPairColorization.enabled') },
		guides: { bracketPairs: get<boolean>('editor.guides.bracketPairs'), indentation: get<boolean>('editor.guides.indentation') },
		stickyScroll: { enabled: get<boolean>('editor.stickyScroll.enabled') },
		folding: get<boolean>('editor.folding'),
		glyphMargin: get<boolean>('editor.glyphMargin'),
		scrollBeyondLastLine: get<boolean>('editor.scrollBeyondLastLine'),
		smoothScrolling: get<boolean>('editor.smoothScrolling'),
		mouseWheelZoom: get<boolean>('editor.mouseWheelZoom'),
		multiCursorModifier: get<'ctrlCmd' | 'alt'>('editor.multiCursorModifier'),
		matchBrackets: get<'always' | 'near' | 'never'>('editor.matchBrackets'),
		selectionHighlight: get<boolean>('editor.selectionHighlight'),
		links: get<boolean>('editor.links'),
		dragAndDrop: get<boolean>('editor.dragAndDrop'),
		emptySelectionClipboard: get<boolean>('editor.emptySelectionClipboard'),
		hover: { enabled: get<boolean>('editor.hover.enabled') ? 'on' : 'off' },
		parameterHints: { enabled: get<boolean>('editor.parameterHints.enabled') },
		// VS Code's default object: suggestions in code, not in comments or strings.
		quickSuggestions: quick ? { other: 'on', comments: 'off', strings: 'off' } : false,
		suggestOnTriggerCharacters: get<boolean>('editor.suggestOnTriggerCharacters'),
		acceptSuggestionOnEnter: get<'on' | 'smart' | 'off'>('editor.acceptSuggestionOnEnter'),
		tabCompletion: get<'on' | 'off' | 'onlySnippets'>('editor.tabCompletion'),
		wordBasedSuggestions: get<'off' | 'currentDocument' | 'matchingDocuments' | 'allDocuments'>('editor.wordBasedSuggestions'),
		snippetSuggestions: get<'top' | 'bottom' | 'inline' | 'none'>('editor.snippetSuggestions'),
		autoClosingBrackets: get<Monaco.editor.EditorAutoClosingStrategy>('editor.autoClosingBrackets'),
		autoClosingQuotes: get<Monaco.editor.EditorAutoClosingStrategy>('editor.autoClosingQuotes'),
		autoSurround: get<Monaco.editor.EditorAutoSurroundStrategy>('editor.autoSurround'),
		autoIndent: get<'none' | 'keep' | 'brackets' | 'advanced' | 'full'>('editor.autoIndent'),
		linkedEditing: get<boolean>('editor.linkedEditing'),
		formatOnPaste: get<boolean>('editor.formatOnPaste'),
		formatOnType: get<boolean>('editor.formatOnType')
	};
}

export type Indent = { tabSize: number; insertSpaces: boolean; detect: boolean };

export function indentFrom(get: Get): Indent {
	return { tabSize: get<number>('editor.tabSize'), insertSpaces: get<boolean>('editor.insertSpaces'), detect: get<boolean>('editor.detectIndentation') };
}

/** xterm options (VS Code: terminal.integrated.*); the font falls back to the editor's. */
export function terminalOptionsFrom(get: Get): ITerminalOptions {
	const cursor = get<string>('terminal.integrated.cursorStyle');
	return {
		fontSize: get<number>('terminal.integrated.fontSize'),
		fontFamily: get<string>('terminal.integrated.fontFamily') || get<string>('editor.fontFamily'),
		fontWeight: get<ITerminalOptions['fontWeight']>('terminal.integrated.fontWeight'),
		lineHeight: get<number>('terminal.integrated.lineHeight'),
		letterSpacing: get<number>('terminal.integrated.letterSpacing'),
		cursorStyle: cursor === 'line' ? 'bar' : (cursor as 'block' | 'underline'),
		cursorBlink: get<boolean>('terminal.integrated.cursorBlinking'),
		cursorWidth: get<number>('terminal.integrated.cursorWidth'),
		scrollback: get<number>('terminal.integrated.scrollback'),
		macOptionIsMeta: get<boolean>('terminal.integrated.macOptionIsMeta'),
		altClickMovesCursor: get<boolean>('terminal.integrated.altClickMovesCursor'),
		drawBoldTextInBrightColors: get<boolean>('terminal.integrated.drawBoldTextInBrightColors'),
		minimumContrastRatio: get<number>('terminal.integrated.minimumContrastRatio'),
		scrollSensitivity: get<number>('terminal.integrated.mouseWheelScrollSensitivity'),
		fastScrollSensitivity: get<number>('terminal.integrated.fastScrollSensitivity')
	};
}

export type ShellPlatform = 'osx' | 'linux';

export function shellPlatform(): ShellPlatform {
	return isMacPlatform() ? 'osx' : 'linux';
}

/** What pty_spawn gets for a new shell: `null` fields keep Rust's defaults ($SHELL -l in the folder). */
export function shellFrom(get: Get, platform: ShellPlatform): { shell: string | null; args: string[]; env: Record<string, string>; cwd: string | null } {
	return {
		shell: get<string>(`terminal.integrated.shell.${platform}`).trim() || null,
		args: [...get<string[]>(`terminal.integrated.shellArgs.${platform}`)],
		env: { ...get<Record<string, string>>(`terminal.integrated.env.${platform}`) },
		cwd: get<string>('terminal.integrated.cwd').trim() || null
	};
}

/** The patterns of a glob map (`{ "**\/.git": true }`) that are switched on. */
export function enabledGlobs(map: Readonly<Record<string, unknown>>): string[] {
	return Object.entries(map)
		.filter(([, on]) => on === true)
		.map(([glob]) => glob);
}

/** Options the Rust search takes from settings (merged into the view's own options). */
export type SearchSettings = {
	exclude_globs: string[];
	follow_symlinks: boolean;
	smart_case: boolean;
	max_results: number;
	use_global_ignore: boolean;
	use_parent_ignore: boolean;
};

/** VS Code: search.exclude inherits files.exclude; both apply unless "Use Exclude Settings" is off. */
export function searchSettingsFrom(get: Get, useExcludes: boolean): SearchSettings {
	const globs = useExcludes ? [...new Set([...enabledGlobs(get('files.exclude')), ...enabledGlobs(get('search.exclude'))])] : [];
	return {
		exclude_globs: globs,
		follow_symlinks: get<boolean>('search.followSymlinks'),
		smart_case: get<boolean>('search.smartCase'),
		max_results: get<number>('search.maxResults'),
		use_global_ignore: get<boolean>('search.useGlobalIgnoreFiles'),
		use_parent_ignore: get<boolean>('search.useParentIgnoreFiles')
	};
}

const reCache = new Map<string, RegExp>();

/**
 * A VS Code glob as a RegExp over `/`-separated workspace-relative paths: `**` spans folders,
 * `*` and `?` stay within one, `{a,b}` and `[...]` work. Like VS Code there is no implicit
 * leading `**` (`*.log` matches at the root only).
 */
export function globToRegExp(glob: string): RegExp {
	const cached = reCache.get(glob);
	if (cached) return cached;
	let re = '';
	let i = 0;
	let inGroup = false;
	while (i < glob.length) {
		const c = glob[i];
		if (c === '*' && glob[i + 1] === '*') {
			const slashAfter = glob[i + 2] === '/';
			// `**/` matches zero or more whole folders; a trailing `**` matches anything.
			re += slashAfter ? '(?:.*/)?' : '.*';
			i += slashAfter ? 3 : 2;
			continue;
		}
		if (c === '*') re += '[^/]*';
		else if (c === '?') re += '[^/]';
		else if (c === '{') {
			inGroup = true;
			re += '(?:';
		} else if (c === '}' && inGroup) {
			inGroup = false;
			re += ')';
		} else if (c === ',' && inGroup) re += '|';
		else if (c === '[') {
			const end = glob.indexOf(']', i + 1);
			if (end < 0) re += '\\[';
			else {
				const body = glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
				re += `[${body}]`;
				i = end;
			}
		} else re += c.replace(/[.+^$()|\\/]/g, '\\$&');
		i++;
	}
	const out = new RegExp(`^${re}$`);
	reCache.set(glob, out);
	return out;
}

/** Whether `rel` (or a folder above it) matches one of `globs`, like VS Code's excludes. */
export function isExcluded(rel: string, globs: readonly string[]): boolean {
	if (!globs.length || !rel) return false;
	const parts = rel.split('/');
	for (let n = parts.length; n > 0; n--) {
		const prefix = parts.slice(0, n).join('/');
		if (globs.some((g) => globToRegExp(g).test(prefix))) return true;
	}
	return false;
}

/** `files.associations`: a pattern with `/` matches the path, else the file name. Last match wins. */
export function associatedLanguage(rel: string, associations: Readonly<Record<string, string>>): string | undefined {
	const name = rel.split('/').pop() ?? rel;
	let found: string | undefined;
	for (const [glob, language] of Object.entries(associations)) {
		if (globToRegExp(glob).test(glob.includes('/') ? rel : name)) found = language;
	}
	return found;
}

export type SortOrder = 'default' | 'mixed' | 'filesFirst' | 'type' | 'modified';
type Sortable = { name: string; is_dir: boolean; modified?: number };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const extOf = (name: string) => {
	const i = name.lastIndexOf('.');
	return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

/** `explorer.sortOrder` (VS Code's explorer sorter; `modified` is newest first, folders first). */
export function sortEntries<T extends Sortable>(entries: readonly T[], order: SortOrder): T[] {
	const byName = (a: T, b: T) => collator.compare(a.name, b.name);
	const cmp: Record<SortOrder, (a: T, b: T) => number> = {
		default: (a, b) => Number(b.is_dir) - Number(a.is_dir) || byName(a, b),
		mixed: byName,
		filesFirst: (a, b) => Number(a.is_dir) - Number(b.is_dir) || byName(a, b),
		type: (a, b) => Number(b.is_dir) - Number(a.is_dir) || (a.is_dir ? 0 : collator.compare(extOf(a.name), extOf(b.name))) || byName(a, b),
		modified: (a, b) => Number(b.is_dir) - Number(a.is_dir) || (b.modified ?? 0) - (a.modified ?? 0) || byName(a, b)
	};
	return [...entries].sort(cmp[order] ?? cmp.default);
}

/** `files.eol` for a file that has no line break yet; `auto` is LF (Kingu runs on macOS and Linux). */
export function eolFor(setting: string): '\n' | '\r\n' {
	return setting === '\r\n' ? '\r\n' : '\n';
}

export type SaveReason = 'explicit' | 'afterDelay' | 'focusChange' | 'windowChange';

/** `editor.codeActionsOnSave` kinds to run for a save: `explicit`/`true` on manual saves, `always` on every save. */
export function codeActionsOnSave(map: Readonly<Record<string, unknown>>, reason: SaveReason): string[] {
	return Object.entries(map)
		.filter(([, v]) => v === 'always' || ((v === 'explicit' || v === true) && reason === 'explicit'))
		.map(([kind]) => kind);
}

/** VS Code skips format on save for auto save after a delay (it would reformat while typing). */
export const formatsOnSave = (enabled: boolean, reason: SaveReason) => enabled && reason !== 'afterDelay';

/** `debug.openDebug` / `debug.internalConsoleOptions` at a session start. */
export function opensOnStart(setting: string, firstSession: boolean): boolean {
	return setting === 'openOnSessionStart' || (setting === 'openOnFirstSessionStart' && firstSession);
}

/** The color theme in effect: the preferred one for the OS scheme when auto-detect is on. */
export function effectiveTheme(get: Get, prefersDark: boolean): string {
	if (!get<boolean>('window.autoDetectColorScheme')) return get<string>('workbench.colorTheme');
	return get<string>(prefersDark ? 'workbench.preferredDarkColorTheme' : 'workbench.preferredLightColorTheme');
}

function isMacPlatform(): boolean {
	return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
}
