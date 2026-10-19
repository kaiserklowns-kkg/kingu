// Settings → what each consumer takes (VS Code: the editor/terminal/search contributions that read
// configuration). Pure, so `bun test` checks every mapping; apply.svelte.ts and the views call these
// with `settings.get`.

import type * as Monaco from 'monaco-editor';
import type { ITerminalOptions } from '@xterm/xterm';
import { themeSettingFor } from '../workbench/workbenchOptions';
import { DIFF_EDITOR_OPTION_PATHS, EDITOR_CONFIG_SETTINGS, EDITOR_KINGU_SETTINGS, EDITOR_OPTION_PATHS } from './editorOptionMap';

export type Get = <T = unknown>(id: string) => T;

export type DiffWordWrap = 'off' | 'on' | 'inherit';

/** Sets `value` at `path` (`minimap.enabled`) in an options object. */
function setPath(target: Record<string, unknown>, path: string, value: unknown) {
	const dot = path.indexOf('.');
	if (dot < 0) target[path] = value;
	else ((target[path.slice(0, dot)] ??= {}) as Record<string, unknown>)[path.slice(dot + 1)] = value;
}

/**
 * Monaco diff editor options (VS Code: every diffEditor.* setting, see editorOptionMap.ts).
 * `sideBySide` is a diff view's own inline / side-by-side toggle, which wins over the setting
 * until it changes.
 */
export function diffEditorOptionsFrom(get: Get, sideBySide?: boolean): Monaco.editor.IDiffEditorOptions {
	const out: Record<string, unknown> = {};
	for (const [id, path] of Object.entries(DIFF_EDITOR_OPTION_PATHS)) {
		const value = get(id);
		if (value !== undefined) setPath(out, path, value);
	}
	if (sideBySide !== undefined) out.renderSideBySide = sideBySide;
	return out as Monaco.editor.IDiffEditorOptions;
}

/** Whether a diff wraps lines: diffEditor.wordWrap, or editor.wordWrap when it inherits (the "…" menu's check). */
export function diffWraps(get: Get): boolean {
	const wrap = get<DiffWordWrap>('diffEditor.wordWrap');
	return wrap === 'inherit' ? get<string>('editor.wordWrap') !== 'off' : wrap === 'on';
}

/**
 * Monaco editor options (VS Code: the `editor` configuration section, handed to the editor as
 * IEditorOptions). Every editor.* setting that is a Monaco option goes through as is; the paths
 * are generated in editorOptionMap.ts.
 */
export function editorOptionsFrom(get: Get, themeSemantic = false): Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions {
	const out: Record<string, unknown> = {};
	for (const [id, path] of Object.entries(EDITOR_OPTION_PATHS)) {
		const value = id === SEMANTIC_HIGHLIGHTING ? semanticHighlightingFrom(get(id), themeSemantic) : get(id);
		if (value !== undefined) setPath(out, path, value);
	}
	// problems.visibility: off hides the squiggles in every editor, like VS Code's text editors.
	if (get('problems.visibility') === false) out.renderValidationDecorations = 'off';
	return out as Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions;
}

/**
 * Every editor.* and diffEditor.* value as `[key, value]` for Monaco's configuration service (in
 * VS Code the editor contributions read `editor.codeActionWidget.showHeaders`,
 * `editor.stickyScroll.enabled`, … from the configuration, not from the editor's options).
 */
export function editorConfigurationFrom(get: Get, themeSemantic = false): [string, unknown][] {
	const ids = [...Object.keys(EDITOR_OPTION_PATHS), ...EDITOR_CONFIG_SETTINGS, ...EDITOR_KINGU_SETTINGS, ...Object.keys(DIFF_EDITOR_OPTION_PATHS)];
	return ids.map((id) => [id, id === SEMANTIC_HIGHLIGHTING ? semanticHighlightingFrom(get(id), themeSemantic) : get(id)] as [string, unknown]).filter(([, v]) => v !== undefined);
}

const SEMANTIC_HIGHLIGHTING = 'editor.semanticHighlighting.enabled';

/**
 * `editor.semanticHighlighting.enabled` as Monaco takes it: `configuredByTheme` becomes the color
 * theme's own `semanticHighlighting` (VS Code's default themes turn it on), because Monaco's
 * standalone themes never do. Monaco reads it from its configuration service, so the
 * configuration value is resolved the same way.
 */
export function semanticHighlightingFrom(value: unknown, themeSemantic: boolean): boolean | undefined {
	if (value === undefined) return undefined;
	return value === 'configuredByTheme' ? themeSemantic : value === true;
}

/** A model's indentation: `indentSize` is a number or `"tabSize"` (VS Code's editor.indentSize). */
export type Indent = { tabSize: number; indentSize: number | 'tabSize'; insertSpaces: boolean; detect: boolean; trimAutoWhitespace: boolean };

export function indentFrom(get: Get): Indent {
	return {
		tabSize: get<number>('editor.tabSize'),
		indentSize: get<number | 'tabSize'>('editor.indentSize') ?? 'tabSize',
		insertSpaces: get<boolean>('editor.insertSpaces'),
		detect: get<boolean>('editor.detectIndentation'),
		trimAutoWhitespace: get<boolean>('editor.trimAutoWhitespace') ?? true
	};
}

/** The model options for an indentation (detected tab size and spaces win when detection is on). */
export function modelOptionsFrom(i: Indent, detected?: { tabSize: number; insertSpaces: boolean }): Monaco.editor.ITextModelUpdateOptions {
	const tabSize = detected?.tabSize ?? i.tabSize;
	return {
		tabSize,
		indentSize: i.indentSize === 'tabSize' || detected ? tabSize : i.indentSize,
		insertSpaces: detected?.insertSpaces ?? i.insertSpaces,
		trimAutoWhitespace: i.trimAutoWhitespace
	};
}

/**
 * A terminal font weight like VS Code's TerminalConfigurationService: `normal`/`bold` stay, a
 * number (or numeric string) is clamped to 1–1000, anything else is the default.
 */
export function terminalFontWeight(value: unknown, fallback: 'normal' | 'bold'): NonNullable<ITerminalOptions['fontWeight']> {
	if (value === 'normal' || value === 'bold') return value;
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
	return Number.isFinite(n) ? Math.min(1000, Math.max(1, Math.round(n))) : fallback;
}

/** VS Code's terminal cursor names → xterm's (`line` is xterm's `bar`). */
const xtermCursor = <T extends string>(style: string) => (style === 'line' ? 'bar' : style) as T;

/** VS Code's smooth scroll duration for the terminal (RenderConstants.SmoothScrollDuration). */
export const TERMINAL_SMOOTH_SCROLL_MS = 125;

/**
 * xterm options (VS Code: terminal.integrated.*, as xtermTerminal.ts applies them); the font
 * falls back to the editor's.
 */
export function terminalOptionsFrom(get: Get): ITerminalOptions {
	return {
		fontSize: get<number>('terminal.integrated.fontSize'),
		fontFamily: get<string>('terminal.integrated.fontFamily') || get<string>('editor.fontFamily'),
		fontWeight: terminalFontWeight(get('terminal.integrated.fontWeight'), 'normal'),
		fontWeightBold: terminalFontWeight(get('terminal.integrated.fontWeightBold'), 'bold'),
		lineHeight: get<number>('terminal.integrated.lineHeight'),
		letterSpacing: get<number>('terminal.integrated.letterSpacing'),
		cursorStyle: xtermCursor<NonNullable<ITerminalOptions['cursorStyle']>>(get<string>('terminal.integrated.cursorStyle')),
		cursorInactiveStyle: xtermCursor<NonNullable<ITerminalOptions['cursorInactiveStyle']>>(get<string>('terminal.integrated.cursorStyleInactive')),
		cursorBlink: get<boolean>('terminal.integrated.cursorBlinking'),
		cursorWidth: get<number>('terminal.integrated.cursorWidth'),
		scrollback: get<number>('terminal.integrated.scrollback'),
		tabStopWidth: get<number>('terminal.integrated.tabStopWidth'),
		wordSeparator: get<string>('terminal.integrated.wordSeparators'),
		macOptionIsMeta: get<boolean>('terminal.integrated.macOptionIsMeta'),
		macOptionClickForcesSelection: get<boolean>('terminal.integrated.macOptionClickForcesSelection'),
		// VS Code: Alt+click moves the shell cursor only while Alt is the editor's multi-cursor modifier.
		altClickMovesCursor: get<boolean>('terminal.integrated.altClickMovesCursor') && get<string>('editor.multiCursorModifier') === 'alt',
		rightClickSelectsWord: get<string>('terminal.integrated.rightClickBehavior') === 'selectWord',
		drawBoldTextInBrightColors: get<boolean>('terminal.integrated.drawBoldTextInBrightColors'),
		minimumContrastRatio: get<number>('terminal.integrated.minimumContrastRatio'),
		scrollSensitivity: get<number>('terminal.integrated.mouseWheelScrollSensitivity'),
		fastScrollSensitivity: get<number>('terminal.integrated.fastScrollSensitivity'),
		smoothScrollDuration: get<boolean>('terminal.integrated.smoothScrolling') ? TERMINAL_SMOOTH_SCROLL_MS : 0,
		ignoreBracketedPasteMode: get<boolean>('terminal.integrated.ignoreBracketedPasteMode')
	};
}

export type ShellPlatform = 'osx' | 'linux';

export function shellPlatform(): ShellPlatform {
	return isMacPlatform() ? 'osx' : 'linux';
}

/** What pty_spawn gets for a new shell (lib.rs TerminalSettings): `null` fields keep Rust's defaults ($SHELL -l in the folder). */
export type ShellSettings = {
	shell: string | null;
	args: string[];
	/** `terminal.integrated.env.*`: a `null` value removes the variable. */
	env: Record<string, string | null>;
	cwd: string | null;
	inheritEnv: boolean;
	detectLocale: string;
	/** The UI locale `detectLocale` derives `$LANG` from (`th-TH` → `th_TH.UTF-8`). */
	locale: string | null;
	splitCwd: string;
};

export function shellFrom(get: Get, platform: ShellPlatform, locale: string | null = typeof navigator !== 'undefined' ? navigator.language : null): ShellSettings {
	return {
		shell: get<string>(`terminal.integrated.shell.${platform}`).trim() || null,
		args: [...get<string[]>(`terminal.integrated.shellArgs.${platform}`)],
		env: { ...get<Record<string, string | null>>(`terminal.integrated.env.${platform}`) },
		cwd: get<string>('terminal.integrated.cwd').trim() || null,
		inheritEnv: get<boolean>('terminal.integrated.inheritEnv'),
		detectLocale: get<string>('terminal.integrated.detectLocale'),
		locale,
		splitCwd: get<string>('terminal.integrated.splitCwd')
	};
}

/** The patterns of a glob map (`{ "**\/.git": true }`) that are switched on. */
export function enabledGlobs(map: Readonly<Record<string, unknown>>): string[] {
	return Object.entries(map)
		.filter(([, on]) => on === true)
		.map(([glob]) => glob);
}

/** A sibling clause of an exclude map: `"**\/*.js": { "when": "$(basename).ts" }`. */
export type SiblingClause = { glob: string; when: string };

/** The sibling clauses of exclude maps (the `{ "when": … }` values). */
export function siblingClauses(...maps: Readonly<Record<string, unknown>>[]): SiblingClause[] {
	return maps.flatMap((map) =>
		Object.entries(map).flatMap(([glob, v]) => (v && typeof v === 'object' && typeof (v as { when?: unknown }).when === 'string' ? [{ glob, when: (v as { when: string }).when }] : []))
	);
}

/**
 * VS Code's sibling check: `rel` matches a clause's glob and the file its `when` names (with
 * `$(basename)` = the file name without its extension) sits next to it. `exists` answers for a
 * workspace-relative path.
 */
export function hiddenBySibling(rel: string, clauses: readonly SiblingClause[], exists: (rel: string) => boolean): boolean {
	if (!clauses.length) return false;
	const slash = rel.lastIndexOf('/');
	const dir = slash < 0 ? '' : rel.slice(0, slash + 1);
	const name = rel.slice(slash + 1);
	const dot = name.lastIndexOf('.');
	const base = dot < 0 ? name : name.slice(0, dot);
	return clauses.some((c) => globToRegExp(c.glob).test(rel) && exists(dir + c.when.replaceAll('$(basename)', base)));
}

/** Options the Rust search takes from settings (merged into the view's own options). */
export type SearchSettings = {
	exclude_globs: string[];
	sibling_clauses: SiblingClause[];
	follow_symlinks: boolean;
	smart_case: boolean;
	max_results: number;
	use_global_ignore: boolean;
	use_parent_ignore: boolean;
	max_threads: number;
	/** kingu.search.smart: a plain query also finds its words in any case, order and name spelling (Rust smart_search.rs). */
	smart: boolean;
};

/** VS Code: search.exclude inherits files.exclude; both apply unless "Use Exclude Settings" is off. */
export function searchSettingsFrom(get: Get, useExcludes: boolean): SearchSettings {
	const globs = useExcludes ? [...new Set([...enabledGlobs(get('files.exclude')), ...enabledGlobs(get('search.exclude'))])] : [];
	return {
		exclude_globs: globs,
		sibling_clauses: useExcludes ? siblingClauses(get('files.exclude'), get('search.exclude')) : [],
		follow_symlinks: get<boolean>('search.followSymlinks'),
		smart_case: get<boolean>('search.smartCase'),
		// `null` (empty) is VS Code's "no limit".
		max_results: get<number | null>('search.maxResults') ?? Number.MAX_SAFE_INTEGER,
		use_global_ignore: get<boolean>('search.useGlobalIgnoreFiles'),
		use_parent_ignore: get<boolean>('search.useParentIgnoreFiles'),
		max_threads: get<number>('search.ripgrep.maxThreads'),
		smart: get<boolean>('kingu.search.smart') === true
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

export type SortOrder = 'default' | 'mixed' | 'filesFirst' | 'type' | 'modified' | 'foldersNestsFiles';
export type LexicographicOrder = 'default' | 'upper' | 'lower' | 'unicode';
/** `hasNests`: the file has nested children (explorer.fileNesting), for `foldersNestsFiles`. */
type Sortable = { name: string; is_dir: boolean; modified?: number; hasNests?: boolean };

// VS Code's comparers.ts collators: numeric, and numeric ignoring case for extensions.
const collatorNumeric = new Intl.Collator(undefined, { numeric: true });
const collatorNumericCaseless = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** `.gitignore` → `gitignore`, `a.b.ts` → `ts` (VS Code's extractExtension). */
const extOf = (name: string) => /^(.*?)(\.([^.]*))?$/.exec(name)?.[3] ?? '';
const byLength = (c: Intl.Collator, a: string, b: string) => c.compare(a, b) || (a.length !== b.length ? (a.length < b.length ? -1 : 1) : 0);
const isUpper = (s: string) => !!s && s[0] !== s[0].toLowerCase();
const isLower = (s: string) => !!s && s[0] !== s[0].toUpperCase();
const upperFirst = (a: string, b: string) => (isUpper(a) && isLower(b) ? -1 : isLower(a) && isUpper(b) ? 1 : 0);
const unicode = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

/** `explorer.sortOrderLexicographicOptions`: VS Code's compareFileNames* / compareFileExtensions*. */
export function nameComparers(order: LexicographicOrder): { names: (a: string, b: string) => number; extensions: (a: string, b: string) => number } {
	const ext = (a: string, b: string) => byLength(collatorNumericCaseless, extOf(a), extOf(b));
	switch (order) {
		case 'upper':
			return { names: (a, b) => upperFirst(a, b) || byLength(collatorNumeric, a, b), extensions: (a, b) => ext(a, b) || upperFirst(a, b) || byLength(collatorNumeric, a, b) };
		case 'lower':
			return { names: (a, b) => -upperFirst(a, b) || byLength(collatorNumeric, a, b), extensions: (a, b) => ext(a, b) || -upperFirst(a, b) || byLength(collatorNumeric, a, b) };
		case 'unicode':
			return { names: unicode, extensions: (a, b) => unicode(extOf(a).toLowerCase(), extOf(b).toLowerCase()) || unicode(a, b) };
		default:
			return { names: (a, b) => byLength(collatorNumeric, a, b), extensions: (a, b) => ext(a, b) || byLength(collatorNumeric, a, b) };
	}
}

/**
 * `explorer.sortOrder` with `explorer.sortOrderLexicographicOptions` and `explorer.sortOrderReverse`
 * (VS Code's explorer FileSorter; reversing swaps the two sides of every comparison, so folders
 * come last too).
 */
export function sortEntries<T extends Sortable>(entries: readonly T[], order: SortOrder, lexicographic: LexicographicOrder = 'default', reverse = false): T[] {
	const { names, extensions } = nameComparers(lexicographic);
	const dirsFirst = (a: T, b: T) => (a.is_dir === b.is_dir ? 0 : a.is_dir ? -1 : 1);
	const cmp = (a: T, b: T): number => {
		switch (order) {
			case 'mixed':
				return names(a.name, b.name);
			case 'filesFirst':
				return -dirsFirst(a, b) || names(a.name, b.name);
			case 'type':
				return dirsFirst(a, b) || (a.is_dir ? names(a.name, b.name) : extensions(a.name, b.name));
			case 'foldersNestsFiles':
				return dirsFirst(a, b) || (!!a.hasNests === !!b.hasNests ? 0 : a.hasNests ? -1 : 1) || names(a.name, b.name);
			case 'modified':
				return dirsFirst(a, b) || ((a.modified ?? 0) !== (b.modified ?? 0) ? ((a.modified ?? 0) < (b.modified ?? 0) ? 1 : -1) : names(a.name, b.name));
			default:
				return dirsFirst(a, b) || names(a.name, b.name);
		}
	};
	return [...entries].sort(reverse ? (a, b) => cmp(b, a) : cmp);
}

/** `files.eol` for a file that has no line break yet; `auto` is LF (Kingu runs on macOS and Linux). */
export function eolFor(setting: string): '\n' | '\r\n' {
	return setting === '\r\n' ? '\r\n' : '\n';
}

export type SaveReason = 'explicit' | 'afterDelay' | 'focusChange' | 'windowChange';

/** `editor.codeActionsOnSave`: a map of kind → `explicit`/`always`/`never` (or true/false), or a list of kinds. */
export type CodeActionsOnSave = Readonly<Record<string, unknown>> | readonly string[];

const isFixAll = (kind: string) => kind === 'source.fixAll' || kind.startsWith('source.fixAll.');

/**
 * The code action kinds to run for a save, like VS Code's CodeActionOnSaveParticipant: none on
 * auto save after a delay; a list runs on explicit saves only; in a map `explicit`/`true` run on
 * explicit saves and `always` on focus and window changes too; fix-all kinds go first.
 */
export function codeActionsOnSave(setting: CodeActionsOnSave, reason: SaveReason): string[] {
	if (reason === 'afterDelay') return [];
	if (Array.isArray(setting)) return reason === 'explicit' ? [...setting] : [];
	const map = setting as Readonly<Record<string, unknown>>;
	return Object.entries(map)
		.filter(([, v]) => v === 'always' || ((v === 'explicit' || v === true) && reason === 'explicit'))
		.map(([kind]) => kind)
		.sort((a, b) => Number(isFixAll(b)) - Number(isFixAll(a)));
}

/**
 * `editor.codeActions.triggerOnFocusChange`: with `files.autoSave` on `afterDelay`, the `always`
 * source actions of `editor.codeActionsOnSave` run when the window or the active editor changes.
 */
export function codeActionsOnFocusChange(enabled: boolean, autoSave: string, setting: CodeActionsOnSave): string[] {
	if (!enabled || autoSave !== 'afterDelay' || Array.isArray(setting)) return [];
	return Object.entries(setting as Readonly<Record<string, unknown>>)
		.filter(([kind, v]) => v === 'always' && (kind === 'source' || kind.startsWith('source.')))
		.map(([kind]) => kind);
}

/**
 * Whether auto save may save a file: files.autoSaveWorkspaceFilesOnly keeps it to files of the
 * open folder, files.autoSaveWhenNoErrors to files without error markers.
 */
export function autoSaves(get: Get, file: { inWorkspace: boolean; hasErrors: boolean }): boolean {
	if (get<boolean>('files.autoSaveWorkspaceFilesOnly') && !file.inWorkspace) return false;
	return !(get<boolean>('files.autoSaveWhenNoErrors') && file.hasErrors);
}

/** VS Code skips format on save for auto save after a delay (it would reformat while typing). */
export const formatsOnSave = (enabled: boolean, reason: SaveReason) => enabled && reason !== 'afterDelay';

/** `debug.openDebug` / `debug.internalConsoleOptions` at a session start. */
export function opensOnStart(setting: string, firstSession: boolean): boolean {
	return setting === 'openOnSessionStart' || (setting === 'openOnFirstSessionStart' && firstSession);
}

/**
 * The color theme in effect: a preferred high contrast theme while the OS asks for more contrast
 * (window.autoDetectHighContrast), else the preferred one for the OS scheme when
 * window.autoDetectColorScheme is on, else workbench.colorTheme.
 */
export function effectiveTheme(get: Get, prefersDark: boolean, highContrast = false): string {
	return get<string>(
		themeSettingFor({
			autoDetectHighContrast: get<boolean>('window.autoDetectHighContrast'),
			autoDetectColorScheme: get<boolean>('window.autoDetectColorScheme'),
			highContrast,
			prefersDark
		})
	);
}

function isMacPlatform(): boolean {
	return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
}
