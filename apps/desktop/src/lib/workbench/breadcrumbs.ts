// What the breadcrumbs bar shows (VS Code: breadcrumbsModel.ts, documentSymbolsOutline.ts and the
// breadcrumbs.* settings). Pure, so the filtering and sorting are unit-tested.

import type { Crumb } from '#lib/lsp/convert.ts';
import type { DocumentSymbol, Position, SymbolInformation } from '#lib/lsp/protocol.ts';

type Get = <T = unknown>(id: string) => T;
export type PathMode = 'on' | 'off' | 'last';
export type SymbolSortOrder = 'position' | 'name' | 'type';

/** `breadcrumbs.show*` per LSP SymbolKind (1 = File … 26 = TypeParameter), like VS Code's DocumentSymbolFilter. */
export const KIND_SETTINGS: Readonly<Record<number, string>> = {
	1: 'breadcrumbs.showFiles',
	2: 'breadcrumbs.showModules',
	3: 'breadcrumbs.showNamespaces',
	4: 'breadcrumbs.showPackages',
	5: 'breadcrumbs.showClasses',
	6: 'breadcrumbs.showMethods',
	7: 'breadcrumbs.showProperties',
	8: 'breadcrumbs.showFields',
	9: 'breadcrumbs.showConstructors',
	10: 'breadcrumbs.showEnums',
	11: 'breadcrumbs.showInterfaces',
	12: 'breadcrumbs.showFunctions',
	13: 'breadcrumbs.showVariables',
	14: 'breadcrumbs.showConstants',
	15: 'breadcrumbs.showStrings',
	16: 'breadcrumbs.showNumbers',
	17: 'breadcrumbs.showBooleans',
	18: 'breadcrumbs.showArrays',
	19: 'breadcrumbs.showObjects',
	20: 'breadcrumbs.showKeys',
	21: 'breadcrumbs.showNull',
	22: 'breadcrumbs.showEnumMembers',
	23: 'breadcrumbs.showStructs',
	24: 'breadcrumbs.showEvents',
	25: 'breadcrumbs.showOperators',
	26: 'breadcrumbs.showTypeParameters'
};

const CODICONS = [
	'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable',
	'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum-member', 'struct', 'event', 'operator', 'type-parameter'
];

/** The codicon of a symbol kind (`breadcrumbs.icons`), e.g. `codicon-symbol-method`. */
export const symbolCodicon = (kind: number) => `codicon-symbol-${CODICONS[kind - 1] ?? 'misc'}`;

/** `breadcrumbs.filePath`: the whole path, nothing, or only its last part. */
export function filePathCrumbs<T>(parts: T[], mode: PathMode): T[] {
	if (mode === 'off') return [];
	if (mode === 'last') return parts.slice(-1);
	return parts;
}

/**
 * The symbol crumbs (outermost first) after VS Code's filtering: the path stops at the first
 * symbol whose kind is switched off (`breadcrumbs.show*`), then `breadcrumbs.symbolPath` keeps all,
 * none or the innermost.
 */
export function visibleSymbols(crumbs: Crumb[], get: Get, mode: PathMode = get<PathMode>('breadcrumbs.symbolPath')): Crumb[] {
	if (mode === 'off') return [];
	const out: Crumb[] = [];
	for (const c of crumbs) {
		const key = KIND_SETTINGS[c.kind];
		if (key && get<boolean>(key) === false) break;
		out.push(c);
	}
	return mode === 'last' ? out.slice(-1) : out;
}

/** The crumbs copied by Copy Breadcrumbs Path, joined with `breadcrumbs.symbolPathSeparator`. */
export function symbolPathText(crumbs: Crumb[], get: Get): string {
	return crumbs
		.map((c) => c.name)
		.filter(Boolean)
		.join(get<string>('breadcrumbs.symbolPathSeparator') ?? '.');
}

const posBefore = (a: Position, b: Position) => a.line - b.line || a.character - b.character;
const contains = (r: { start: Position; end: Position }, p: Position) => posBefore(r.start, p) <= 0 && posBefore(p, r.end) <= 0;
const isDocumentSymbol = (s: DocumentSymbol | SymbolInformation): s is DocumentSymbol => 'selectionRange' in s;

/**
 * The picker list of each crumb (what a click on it shows): the symbols beside it at its level,
 * filtered by the `breadcrumbs.show*` settings. Index i belongs to the i-th unfiltered crumb.
 */
export function symbolSiblings(symbols: (DocumentSymbol | SymbolInformation)[], pos: Position, get: Get): Crumb[][] {
	const keep = (kind: number) => !KIND_SETTINGS[kind] || get<boolean>(KIND_SETTINGS[kind]) !== false;
	if (!symbols.length) return [];
	if (!isDocumentSymbol(symbols[0])) {
		const flat = (symbols as SymbolInformation[]).filter((s) => keep(s.kind)).map((s) => ({ name: s.name, kind: s.kind, range: s.location.range }));
		return [flat];
	}
	const out: Crumb[][] = [];
	let level = symbols as DocumentSymbol[];
	for (;;) {
		const hit = level.find((s) => contains(s.range, pos));
		if (!hit || !keep(hit.kind)) break;
		out.push(level.filter((s) => keep(s.kind)).map((s) => ({ name: s.name, kind: s.kind, range: s.selectionRange })));
		level = hit.children ?? [];
	}
	return out;
}

/** `breadcrumbs.symbolSortOrder` for the picker: file position, name, or kind then name. */
export function sortSymbols(list: Crumb[], order: SymbolSortOrder): Crumb[] {
	const byPos = (a: Crumb, b: Crumb) => posBefore(a.range.start, b.range.start);
	const byName = (a: Crumb, b: Crumb) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
	const cmp = order === 'name' ? (a: Crumb, b: Crumb) => byName(a, b) || byPos(a, b) : order === 'type' ? (a: Crumb, b: Crumb) => a.kind - b.kind || byName(a, b) : byPos;
	return [...list].sort(cmp);
}
