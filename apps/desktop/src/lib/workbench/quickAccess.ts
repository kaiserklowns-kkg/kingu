// Quick access prefixes and ranking (VS Code: quickAccess registry, anythingQuickAccess.ts,
// gotoLineQuickAccess.ts, gotoSymbolQuickAccess.ts, symbolsQuickAccess.ts, helpQuickAccess.ts).
// Pure: QuickInput.svelte turns these into rows.

import { rank, type Match } from './fuzzy';
import { t } from '#lib/i18n/index.ts';

export type QuickMode =
	| { kind: 'files'; query: string; line?: number; column?: number }
	| { kind: 'commands'; query: string }
	| { kind: 'line'; line?: number; column?: number }
	| { kind: 'symbol'; query: string; byKind: boolean }
	| { kind: 'workspaceSymbol'; query: string }
	| { kind: 'help'; query: string }
	| { kind: 'view'; query: string }
	| { kind: 'editors'; query: string; mru: boolean };

/** The providers `?` lists, in VS Code's order. */
export const QUICK_ACCESS_HELP: { readonly prefix: string; readonly label: string }[] = [
	{ prefix: '', get label() { return t('workbench.quickAccess.goToFile'); } },
	{ prefix: '>', get label() { return t('workbench.quickAccess.commands'); } },
	{ prefix: ':', get label() { return t('workbench.quickAccess.goToLine'); } },
	{ prefix: '@', get label() { return t('workbench.quickAccess.symbol'); } },
	{ prefix: '@:', get label() { return t('workbench.quickAccess.symbolByKind'); } },
	{ prefix: '#', get label() { return t('workbench.quickAccess.workspaceSymbol'); } },
	{ prefix: 'edt ', get label() { return t('workbench.quickAccess.editors'); } },
	{ prefix: 'edt mru ', get label() { return t('workbench.quickAccess.editorsMru'); } },
	{ prefix: 'view ', get label() { return t('workbench.quickAccess.view'); } },
	{ prefix: '?', get label() { return t('workbench.quickAccess.help'); } }
];

/** `42`, `42:5`, `42,5` → line and column (1-based); nothing for text that is not a position. */
export function parseLineColumn(text: string): { line?: number; column?: number } {
	const m = /^\s*(\d+)?\s*(?:[:,#]\s*(\d+))?\s*$/.exec(text);
	if (!m) return {};
	return { line: m[1] ? Number(m[1]) : undefined, column: m[2] ? Number(m[2]) : undefined };
}

/**
 * VS Code's `extractRangeFromFilter`: `src/a.ts:42`, `a.ts:42:5`, `a.ts#42`, `a.ts(42,5)` → the
 * file filter plus the position. A filter without one is returned as is.
 */
export function splitFileAndPosition(filter: string): { query: string; line?: number; column?: number } {
	const m = /^(.*?)(?:[:#](\d+)(?:[:,](\d+))?|\((\d+)(?:,\s*(\d+))?\))\s*$/.exec(filter);
	if (!m || !m[1].trim()) return { query: filter };
	const line = Number(m[2] ?? m[4]);
	const col = m[3] ?? m[5];
	return { query: m[1].trim(), line, column: col ? Number(col) : undefined };
}

/** Which provider the typed text selects (VS Code matches the longest registered prefix). */
export function parseQuickInput(value: string): QuickMode {
	if (value.startsWith('>')) return { kind: 'commands', query: value.slice(1).trim() };
	if (value.startsWith(':')) return { kind: 'line', ...parseLineColumn(value.slice(1)) };
	if (value.startsWith('@:')) return { kind: 'symbol', query: value.slice(2).trim(), byKind: true };
	if (value.startsWith('@')) return { kind: 'symbol', query: value.slice(1).trim(), byKind: false };
	if (value.startsWith('#')) return { kind: 'workspaceSymbol', query: value.slice(1).trim() };
	if (value.startsWith('?')) return { kind: 'help', query: value.slice(1).trim() };
	if (value.startsWith('view ')) return { kind: 'view', query: value.slice(5).trim() };
	if (value.startsWith('edt mru ')) return { kind: 'editors', query: value.slice(8).trim(), mru: true };
	if (value.startsWith('edt ')) return { kind: 'editors', query: value.slice(4).trim(), mru: false };
	return { kind: 'files', ...splitFileAndPosition(value.trim()) };
}

export type RankedFile = { path: string; match?: Match; recent: boolean };

/** search.quickOpen.includeHistory and search.quickOpen.history.filterSortOrder. */
export type HistoryOptions = { includeHistory?: boolean; sortOrder?: 'default' | 'recency' };

/**
 * Quick Open's file list: recently opened files first (VS Code's editor history, its "recently
 * opened" section), then the rest ("file results"). With no query, only the history shows.
 * Without history (`includeHistory: false`) only file results show; `sortOrder: 'recency'` keeps
 * matching history entries in the order they were opened instead of by match quality.
 */
export function rankFiles(query: string, files: readonly string[], history: readonly string[], limit = 60, opts: HistoryOptions = {}): RankedFile[] {
	const known = new Set(files);
	// History entries that still exist (all of them while the file list is still loading).
	const recent = opts.includeHistory === false ? [] : files.length ? history.filter((p) => known.has(p)) : [...history];
	if (!query) return recent.slice(0, limit).map((path) => ({ path, recent: true }));
	let recentHits = rank(query, recent, (p) => p, limit).map(({ item, match }) => ({ path: item, match, recent: true }));
	if (opts.sortOrder === 'recency') recentHits = recentHits.sort((a, b) => recent.indexOf(a.path) - recent.indexOf(b.path));
	const seen = new Set(recentHits.map((r) => r.path));
	const rest = rank(
		query,
		files.filter((f) => !seen.has(f)),
		(f) => f,
		limit
	).map(({ item, match }) => ({ path: item, match, recent: false }));
	return [...recentHits, ...rest].slice(0, limit);
}

/** Puts `path` at the front of the editor history (VS Code keeps 200). */
export function pushHistory(history: readonly string[], path: string, max = 200): string[] {
	return [path, ...history.filter((p) => p !== path)].slice(0, max);
}

// --- Symbols -----------------------------------------------------------------------------------

/** One symbol of the active file or the workspace, flattened. Lines and columns are 1-based. */
export type FlatSymbol = { name: string; kind: number; container?: string; line: number; column: number; path?: string; detail?: string };

type DocSym = { name: string; kind: number; detail?: string; selectionRange: { start: { line: number; character: number } }; children?: DocSym[] };
type InfoSym = { name: string; kind: number; containerName?: string; location: { uri: string; range: { start: { line: number; character: number } } } };

/** Document symbols (tree or flat) as a flat list in document order, with their container. */
export function flattenSymbols(symbols: readonly (DocSym | InfoSym)[]): FlatSymbol[] {
	const out: FlatSymbol[] = [];
	const walk = (list: readonly DocSym[], container?: string) => {
		for (const s of list) {
			out.push({ name: s.name, kind: s.kind, detail: s.detail, container, line: s.selectionRange.start.line + 1, column: s.selectionRange.start.character + 1 });
			if (s.children?.length) walk(s.children, s.name);
		}
	};
	if (symbols.length && 'selectionRange' in symbols[0]) walk(symbols as DocSym[]);
	else for (const s of symbols as InfoSym[]) out.push({ name: s.name, kind: s.kind, container: s.containerName, line: s.location.range.start.line + 1, column: s.location.range.start.character + 1 });
	return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** LSP SymbolKind → VS Code's group label in `@:` ("classes", "functions"…). */
const KIND_GROUPS: Record<number, string> = {
	1: 'files',
	2: 'modules',
	3: 'namespaces',
	4: 'packages',
	5: 'classes',
	6: 'methods',
	7: 'properties',
	8: 'fields',
	9: 'constructors',
	10: 'enumerations',
	11: 'interfaces',
	12: 'functions',
	13: 'variables',
	14: 'constants',
	15: 'strings',
	16: 'numbers',
	17: 'booleans',
	18: 'arrays',
	19: 'objects',
	20: 'keys',
	22: 'enumeration members',
	23: 'structs',
	24: 'events',
	25: 'operators',
	26: 'type parameters'
};

/** Codicon-ish names of symbol kinds, for the row's description. */
export const SYMBOL_KIND_NAMES: Record<number, string> = {
	1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum',
	11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 15: 'string', 16: 'number', 17: 'boolean', 18: 'array', 19: 'object',
	20: 'key', 21: 'null', 22: 'enum member', 23: 'struct', 24: 'event', 25: 'operator', 26: 'type parameter'
};

export type SymbolPick = { symbol: FlatSymbol; match?: Match; separator?: string };

/**
 * `@query`: symbols matching the query, in document order with a "symbols (N)" header. `@:query`
 * groups them by kind (VS Code's "classes (2)", "functions (5)"…), kinds in SymbolKind order.
 */
export function pickSymbols(symbols: readonly FlatSymbol[], query: string, byKind: boolean): SymbolPick[] {
	const hits: SymbolPick[] = query ? rank(query, [...symbols], (s) => s.name, 500).map(({ item, match }) => ({ symbol: item, match })) : symbols.map((symbol) => ({ symbol }));
	if (!byKind) {
		if (hits.length) hits[0] = { ...hits[0], separator: `symbols (${hits.length})` };
		return hits;
	}
	const groups = new Map<number, SymbolPick[]>();
	for (const h of hits) groups.set(h.symbol.kind, [...(groups.get(h.symbol.kind) ?? []), h]);
	return [...groups.entries()]
		.sort(([a], [b]) => a - b)
		.flatMap(([kind, list]) => {
			const sorted = [...list].sort((x, y) => x.symbol.line - y.symbol.line);
			sorted[0] = { ...sorted[0], separator: `${KIND_GROUPS[kind] ?? 'symbols'} (${list.length})` };
			return sorted;
		});
}

// --- Quick input position (VS Code: Align Quick Input Top / Center, Customize Layout) ------------

export type QuickAlignment = 'top' | 'center';

/** A stored alignment read back ('top' unless it says 'center'). */
export const parseAlignment = (raw: unknown): QuickAlignment => (raw === 'center' ? 'center' : 'top');

/** The quick input's CSS `top`: just below the title bar, or a quarter down the window (VS Code's center snap line). */
export const quickInputTop = (alignment: QuickAlignment) => (alignment === 'center' ? '25vh' : 'calc(var(--kg-titlebar-height) + 2px)');
