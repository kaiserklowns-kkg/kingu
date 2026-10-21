// What snaps contribute beyond tasks, settings, MCP servers and skills, after VS Code's
// contribution points (src-tauri/src/snap_contrib.rs reads and checks them): languages, TextMate
// grammars, snippets, language servers, color and file icon themes, and views. Pure, so `bun test`
// covers it; contrib.svelte.ts hands the results to the editor, the LSP client, the theme service
// and the workbench.

import type { LanguageAssociation } from '#lib/editor/languageAssociations.ts';
import type { ServerInfo } from '#lib/lsp/model.ts';
import { isActive, settingId, type SnapInfo, type SnapSource } from './snapModel.ts';

export type SnapLanguage = {
	id: string;
	aliases: string[];
	extensions: string[];
	filenames: string[];
	filenamePatterns: string[];
	firstLine: string | null;
	/** A VS Code `language-configuration.json` in the snap. */
	configuration: string | null;
};
export type TokenTypeName = 'other' | 'comment' | 'string';
export type SnapGrammar = {
	language: string | null;
	scopeName: string;
	path: string;
	embeddedLanguages: Record<string, string>;
	tokenTypes: Record<string, TokenTypeName>;
	injectTo: string[];
	balancedBracketScopes: string[];
	unbalancedBracketScopes: string[];
};
export type SnapSnippets = { language: string; path: string };
export type InstallTool = 'npm' | 'go' | 'rustup' | 'brew' | 'pytool' | 'cargo' | 'pip';
export type SnapLspServer = {
	key: string;
	name: string;
	languages: string[];
	command: string[];
	env: Record<string, string>;
	initializationOptions: unknown;
	settingsSection: string | null;
	install: { tool: InstallTool; package: string }[];
};
/** VS Code's `uiTheme`. */
export type UiTheme = 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
export type SnapTheme = { id: string; label: string; uiTheme: UiTheme; path: string };
export type SnapIconTheme = { id: string; label: string; path: string };
export type ViewLocation = 'sidebar' | 'panel';
export type SnapView = { id: string; name: string; location: ViewLocation; path: string; settings: string[]; tasks: string[]; notifications: boolean };
export type SnapFileHash = { path: string; sha256: string };

export type SnapContributions = {
	languages: SnapLanguage[];
	grammars: SnapGrammar[];
	snippets: SnapSnippets[];
	lsp: SnapLspServer[];
	themes: SnapTheme[];
	iconThemes: SnapIconTheme[];
	views: SnapView[];
	/** SHA-256 of each file the manifest names, as listed (passed back when reading it). */
	files: SnapFileHash[];
};

export const NO_CONTRIBUTIONS: SnapContributions = { languages: [], grammars: [], snippets: [], lsp: [], themes: [], iconThemes: [], views: [], files: [] };

/** A snap's contributions (snaps listed by an older Rust side have none). */
export const contributionsOf = (s: Pick<SnapInfo, 'contributes'>): SnapContributions => ({ ...NO_CONTRIBUTIONS, ...s.contributes });

/** Where a file of a snap is read from: the app bundle (built-in) or `snap_file_read`. */
export type SnapRef = { source: SnapSource; id: string };
export const snapRef = (s: Pick<SnapInfo, 'source' | 'id'>): SnapRef => ({ source: s.source, id: s.id });

/** The SHA-256 a file was listed with (files the manifest names); undefined for others. */
export const listedHash = (s: Pick<SnapInfo, 'contributes'>, path: string) => contributionsOf(s).files.find((f) => f.path === path)?.sha256;

// ---------------------------------------------------------------------------------------------
// Built-in snaps

/**
 * The built-in snaps followed by the listed ones. A built-in is overridden by an active user or
 * repo snap with the same id (as a repo snap overrides a user's), so a user can replace one.
 */
export function withBuiltins(builtins: readonly SnapInfo[], list: readonly SnapInfo[]): SnapInfo[] {
	return [...builtins.map((b) => (list.some((s) => s.id === b.id && isActive(s)) ? { ...b, overridden: true } : b)), ...list];
}

/** Snaps whose contributions apply: valid, trusted and not overridden (`isActive`). */
export const contributing = (list: readonly SnapInfo[]) => list.filter(isActive);

/** A path relative to a snap file's folder (`./icons/a.svg` next to `icons/theme.json`), or null when it leaves the snap. */
export function resolveSnapPath(from: string, relative: string): string | null {
	if (relative.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(relative)) return null;
	const parts = from.split('/').slice(0, -1);
	for (const seg of relative.split('/')) {
		if (seg === '..') {
			if (!parts.length) return null;
			parts.pop();
		} else if (seg !== '.' && seg !== '') parts.push(seg);
	}
	return parts.length ? parts.join('/') : null;
}

// ---------------------------------------------------------------------------------------------
// Languages

export type ContributedLanguage = { snap: SnapRef; language: SnapLanguage };

export function languagesOf(list: readonly SnapInfo[]): ContributedLanguage[] {
	return contributing(list).flatMap((s) => contributionsOf(s).languages.map((language) => ({ snap: snapRef(s), language })));
}

/** File associations for languages.ts (after VS Code's and Kingu's own, so a snap's win among equals). */
export function languageAssociations(langs: readonly ContributedLanguage[]): LanguageAssociation[] {
	return langs.map(({ language: l }) => ({
		id: l.id,
		extensions: l.extensions,
		filenames: l.filenames,
		filenamePatterns: l.filenamePatterns,
		...(l.firstLine ? { firstLine: l.firstLine } : {})
	}));
}

/** Monaco's IndentAction for VS Code's `onEnterRules[].action.indent`. */
const INDENT_ACTION: Record<string, number> = { none: 0, indent: 1, indentOutdent: 2, outdent: 3 };

type RegexValue = string | { pattern?: unknown; flags?: unknown };

/** A VS Code configuration regex (`"pattern"` or `{ pattern, flags }`), or undefined when it does not compile. */
function regex(v: unknown): RegExp | undefined {
	const value = v as RegexValue;
	const [pattern, flags] = typeof value === 'string' ? [value, ''] : value && typeof value === 'object' && typeof value.pattern === 'string' ? [value.pattern, typeof value.flags === 'string' ? value.flags : ''] : [undefined, ''];
	if (pattern === undefined) return undefined;
	try {
		return new RegExp(pattern, flags);
	} catch {
		return undefined;
	}
}

const isPair = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string';

function pairs(v: unknown): { open: string; close: string; notIn?: string[] }[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out: { open: string; close: string; notIn?: string[] }[] = [];
	for (const p of v) {
		if (isPair(p)) out.push({ open: p[0], close: p[1] });
		else if (p && typeof p === 'object' && typeof p.open === 'string' && typeof p.close === 'string') {
			const notIn = typeof p.notIn === 'string' ? [p.notIn] : Array.isArray(p.notIn) ? p.notIn.filter((x: unknown) => typeof x === 'string') : undefined;
			out.push({ open: p.open, close: p.close, ...(notIn?.length ? { notIn } : {}) });
		}
	}
	return out;
}

/** What Monaco's `setLanguageConfiguration` takes (structurally; IndentAction as its number). */
export type MonacoLanguageConfiguration = {
	comments?: { lineComment?: string; blockComment?: [string, string] };
	brackets?: [string, string][];
	colorizedBracketPairs?: [string, string][];
	wordPattern?: RegExp;
	indentationRules?: { increaseIndentPattern: RegExp; decreaseIndentPattern: RegExp; indentNextLinePattern?: RegExp; unIndentedLinePattern?: RegExp };
	onEnterRules?: { beforeText: RegExp; afterText?: RegExp; previousLineText?: RegExp; action: { indentAction: number; appendText?: string; removeText?: number } }[];
	autoClosingPairs?: { open: string; close: string; notIn?: string[] }[];
	surroundingPairs?: { open: string; close: string }[];
	autoCloseBefore?: string;
	folding?: { offSide?: boolean; markers?: { start: RegExp; end: RegExp } };
};

/**
 * A VS Code `language-configuration.json` (already parsed as JSONC) as Monaco's language
 * configuration, the way VS Code's LanguageConfigurationFileHandler reads it: strings become
 * RegExps (one that does not compile is left out), pairs become objects, `onEnterRules` actions
 * get their IndentAction.
 */
export function languageConfiguration(raw: unknown): MonacoLanguageConfiguration {
	const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const out: MonacoLanguageConfiguration = {};
	const comments = c.comments as Record<string, unknown> | undefined;
	if (comments && typeof comments === 'object') {
		const line = comments.lineComment;
		const lineComment = typeof line === 'string' ? line : line && typeof line === 'object' && typeof (line as { comment?: unknown }).comment === 'string' ? (line as { comment: string }).comment : undefined;
		out.comments = { ...(lineComment ? { lineComment } : {}), ...(isPair(comments.blockComment) ? { blockComment: comments.blockComment } : {}) };
	}
	if (Array.isArray(c.brackets)) out.brackets = c.brackets.filter(isPair);
	if (Array.isArray(c.colorizedBracketPairs)) out.colorizedBracketPairs = c.colorizedBracketPairs.filter(isPair);
	const autoClosing = pairs(c.autoClosingPairs);
	if (autoClosing) out.autoClosingPairs = autoClosing;
	const surrounding = pairs(c.surroundingPairs);
	if (surrounding) out.surroundingPairs = surrounding.map(({ open, close }) => ({ open, close }));
	if (typeof c.autoCloseBefore === 'string') out.autoCloseBefore = c.autoCloseBefore;
	const word = c.wordPattern !== undefined ? regex(c.wordPattern) : undefined;
	if (word) out.wordPattern = word;
	const ind = c.indentationRules as Record<string, unknown> | undefined;
	if (ind && typeof ind === 'object') {
		const increase = regex(ind.increaseIndentPattern);
		const decrease = regex(ind.decreaseIndentPattern);
		if (increase && decrease) {
			const next = regex(ind.indentNextLinePattern);
			const unIndented = regex(ind.unIndentedLinePattern);
			out.indentationRules = { increaseIndentPattern: increase, decreaseIndentPattern: decrease, ...(next ? { indentNextLinePattern: next } : {}), ...(unIndented ? { unIndentedLinePattern: unIndented } : {}) };
		}
	}
	const folding = c.folding as Record<string, unknown> | undefined;
	if (folding && typeof folding === 'object') {
		const markers = folding.markers as Record<string, unknown> | undefined;
		const start = markers && regex(markers.start);
		const end = markers && regex(markers.end);
		out.folding = { ...(typeof folding.offSide === 'boolean' ? { offSide: folding.offSide } : {}), ...(start && end ? { markers: { start, end } } : {}) };
	}
	if (Array.isArray(c.onEnterRules)) {
		out.onEnterRules = [];
		for (const r of c.onEnterRules as Record<string, unknown>[]) {
			const beforeText = r && regex(r.beforeText);
			const action = r?.action as Record<string, unknown> | undefined;
			const indentAction = action && typeof action.indent === 'string' ? INDENT_ACTION[action.indent] : undefined;
			if (!beforeText || indentAction === undefined) continue;
			const afterText = r.afterText !== undefined ? regex(r.afterText) : undefined;
			const previousLineText = r.previousLineText !== undefined ? regex(r.previousLineText) : undefined;
			out.onEnterRules.push({
				beforeText,
				...(afterText ? { afterText } : {}),
				...(previousLineText ? { previousLineText } : {}),
				action: { indentAction, ...(typeof action!.appendText === 'string' ? { appendText: action!.appendText } : {}), ...(typeof action!.removeText === 'number' ? { removeText: action!.removeText } : {}) }
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Grammars and snippets

/** vscode-textmate's StandardTokenType for `tokenTypes` values. */
const TOKEN_TYPE: Record<TokenTypeName, number> = { other: 0, comment: 1, string: 2 };

export type ContributedGrammar = {
	snap: SnapRef;
	scopeName: string;
	path: string;
	sha256: string | undefined;
	language: string | null;
	embeddedLanguages: Record<string, string>;
	tokenTypes: Record<string, number>;
	injectTo: string[];
	balancedBracketSelectors: string[];
	unbalancedBracketSelectors: string[];
};

export function grammarsOf(list: readonly SnapInfo[]): ContributedGrammar[] {
	return contributing(list).flatMap((s) =>
		contributionsOf(s).grammars.map((g) => ({
			snap: snapRef(s),
			scopeName: g.scopeName,
			path: g.path,
			sha256: listedHash(s, g.path),
			language: g.language,
			embeddedLanguages: g.embeddedLanguages,
			tokenTypes: Object.fromEntries(Object.entries(g.tokenTypes).map(([scope, type]) => [scope, TOKEN_TYPE[type] ?? 0])),
			injectTo: g.injectTo,
			balancedBracketSelectors: g.balancedBracketScopes,
			unbalancedBracketSelectors: g.unbalancedBracketScopes
		}))
	);
}

export type ContributedSnippets = { snap: SnapRef; snapName: string; language: string; path: string; sha256: string | undefined };

export function snippetsOf(list: readonly SnapInfo[]): ContributedSnippets[] {
	return contributing(list).flatMap((s) => contributionsOf(s).snippets.map((x) => ({ snap: snapRef(s), snapName: s.name, language: x.language, path: x.path, sha256: listedHash(s, x.path) })));
}

// ---------------------------------------------------------------------------------------------
// Language servers

/** A server key in the LSP client: the declared one for a built-in snap (rust-analyzer stays
 * `rust`, so `kingu.lsp.disabled`, trace settings and status keys are unchanged), else namespaced. */
export const serverKey = (s: Pick<SnapInfo, 'source' | 'id'>, key: string) => (s.source === 'builtin' ? key : `${s.id}/${key}`);

/** Language servers of active snaps as the LSP client's server table rows. User and repo snaps'
 * come first (a snap a user installed serves its languages before a built-in table row). */
export function lspServersOf(list: readonly SnapInfo[]): ServerInfo[] {
	const rows = contributing(list).flatMap((s) =>
		contributionsOf(s).lsp.map(
			(l): ServerInfo => ({
				key: serverKey(s, l.key),
				name: l.name,
				languages: l.languages,
				...(l.initializationOptions !== null && l.initializationOptions !== undefined ? { initializationOptions: l.initializationOptions } : {}),
				snap: { source: s.source, id: s.id, server: l.key, command: l.command, env: l.env, settingsSection: l.settingsSection }
			})
		)
	);
	return [...rows.filter((r) => r.snap!.source !== 'builtin'), ...rows.filter((r) => r.snap!.source === 'builtin')];
}

/** `workspace/configuration` for a snap server's settings section: the snap's settings by key. */
export function snapServerSettings(snap: SnapInfo | undefined, section: string | null, get: (id: string) => unknown): Record<string, unknown> {
	if (!snap || !section) return {};
	const values: Record<string, unknown> = {};
	for (const st of snap.settings) {
		const v = get(settingId(snap.id, st.key));
		values[st.key] = v === undefined ? st.default : v;
	}
	return { [section]: values };
}

// ---------------------------------------------------------------------------------------------
// Themes

export type ContributedTheme = { snap: SnapRef; theme: SnapTheme; sha256: string | undefined };

export function themesOf(list: readonly SnapInfo[]): ContributedTheme[] {
	return contributing(list).flatMap((s) => contributionsOf(s).themes.map((theme) => ({ snap: snapRef(s), theme, sha256: listedHash(s, theme.path) })));
}

export type ContributedIconTheme = { snap: SnapRef; theme: SnapIconTheme; sha256: string | undefined };

export function iconThemesOf(list: readonly SnapInfo[]): ContributedIconTheme[] {
	return contributing(list).flatMap((s) => contributionsOf(s).iconThemes.map((theme) => ({ snap: snapRef(s), theme, sha256: listedHash(s, theme.path) })));
}

// ---------------------------------------------------------------------------------------------
// Views

export type ContributedView = { key: string; snap: SnapInfo; view: SnapView };

/** `<source>:<snap id>:<view id>`, unique in a window (the side bar's `snap:<key>` view, a panel tab). */
export const viewKey = (s: Pick<SnapInfo, 'source' | 'id'>, view: Pick<SnapView, 'id'>) => `${s.source}:${s.id}:${view.id}`;

export function viewsOf(list: readonly SnapInfo[], location?: ViewLocation): ContributedView[] {
	return contributing(list)
		.filter((s) => s.source !== 'builtin')
		.flatMap((snap) => contributionsOf(snap).views.filter((v) => !location || v.location === location).map((view) => ({ key: viewKey(snap, view), snap, view })));
}

// ---------------------------------------------------------------------------------------------
// The details page

export type ContributionKind = 'languages' | 'grammars' | 'snippets' | 'lsp' | 'themes' | 'iconThemes' | 'views' | 'commands' | 'settings' | 'mcp' | 'skills';
export type ContributionGroup = { kind: ContributionKind; items: { label: string; detail?: string }[] };

const UI_THEME_LABEL: Record<UiTheme, string> = { vs: 'light', 'vs-dark': 'dark', 'hc-black': 'high contrast dark', 'hc-light': 'high contrast light' };

/** Everything a snap adds, by kind, for the details page (empty kinds left out). */
export function contributionGroups(s: SnapInfo): ContributionGroup[] {
	const c = contributionsOf(s);
	const groups: ContributionGroup[] = [
		{ kind: 'languages', items: c.languages.map((l) => ({ label: l.aliases[0] ?? l.id, detail: [l.id, ...l.extensions, ...l.filenames].join(' ') })) },
		{ kind: 'grammars', items: c.grammars.map((g) => ({ label: g.scopeName, detail: g.language ?? (g.injectTo.length ? `→ ${g.injectTo.join(', ')}` : undefined) })) },
		{ kind: 'snippets', items: c.snippets.map((x) => ({ label: x.language, detail: x.path })) },
		{ kind: 'lsp', items: c.lsp.map((l) => ({ label: l.name, detail: `${l.languages.join(', ')} · ${l.command.join(' ')}` })) },
		{ kind: 'themes', items: c.themes.map((th) => ({ label: th.label, detail: UI_THEME_LABEL[th.uiTheme] })) },
		{ kind: 'iconThemes', items: c.iconThemes.map((th) => ({ label: th.label, detail: th.id })) },
		{ kind: 'views', items: c.views.map((v) => ({ label: v.name, detail: v.location })) },
		{ kind: 'commands', items: s.tasks.map((x) => ({ label: x.title, detail: x.command.join(' ') })) },
		{ kind: 'settings', items: s.settings.map((x) => ({ label: settingId(s.id, x.key), detail: x.description || x.type })) },
		{ kind: 'mcp', items: s.mcp.map((m) => ({ label: m.name, detail: m.command.join(' ') })) },
		{ kind: 'skills', items: s.skills.map((k) => ({ label: k.name, detail: k.description || undefined })) }
	];
	return groups.filter((g) => g.items.length);
}

/** The commands a snap's language servers run (the trust and install confirms list them). */
export const serverCommands = (s: SnapInfo) => contributionsOf(s).lsp.map((l) => ({ name: l.name, command: l.command.join(' ') }));
