// The Outline view's model (VS Code: contrib/outline/browser/outlinePane.ts, outlineModel.ts and
// documentSymbolsOutline.ts): a tree of document symbols with stable ids, the outline.show* kind
// filter, sorting by position / name / kind, filter on type, the element enclosing the cursor
// (Follow Cursor) and problem markers per element. Pure, so `bun test` covers it.

import type * as Monaco from 'monaco-editor';
import type { DocumentSymbol, Position, Range, SymbolInformation } from '#lib/lsp/protocol.ts';
import { fuzzyMatch } from './fuzzy';

type Get = <T = unknown>(id: string) => T;

export type OutlineMarker = { count: number; topSev: number };
export type OutlineItem = {
	/** Stable across edits: the parent's id, the name and a counter for same-named siblings (TreeElement.findId). */
	id: string;
	name: string;
	detail: string;
	/** LSP SymbolKind (1-based). */
	kind: number;
	range: Range;
	selectionRange: Range;
	children: OutlineItem[];
	/** Errors/warnings inside it not claimed by a child (`count`), and the worst severity below it. */
	marker?: OutlineMarker;
};

export type OutlineSortOrder = 'position' | 'name' | 'kind';

const cmpPos = (a: Position, b: Position) => a.line - b.line || a.character - b.character;
const contains = (r: Range, p: Position) => cmpPos(r.start, p) <= 0 && cmpPos(p, r.end) <= 0;
const containsRange = (outer: Range, inner: Range) => cmpPos(outer.start, inner.start) <= 0 && cmpPos(inner.end, outer.end) <= 0;
const isDocumentSymbol = (s: DocumentSymbol | SymbolInformation): s is DocumentSymbol => 'selectionRange' in s;

/** Monaco's document symbols (1-based ranges, 0-based kinds) back to LSP shapes. */
export function fromMonacoSymbols(list: readonly Monaco.languages.DocumentSymbol[]): DocumentSymbol[] {
	const r = (x: Monaco.IRange): Range => ({ start: { line: x.startLineNumber - 1, character: x.startColumn - 1 }, end: { line: x.endLineNumber - 1, character: x.endColumn - 1 } });
	return list.map((s) => ({ name: s.name, detail: s.detail, kind: s.kind + 1, range: r(s.range), selectionRange: r(s.selectionRange), children: s.children ? fromMonacoSymbols(s.children) : undefined }));
}

/** SymbolInformation is flat: nest each symbol in the smallest one whose range contains it. */
function nestSymbolInformation(list: SymbolInformation[]): DocumentSymbol[] {
	const sorted = [...list].sort((a, b) => cmpPos(a.location.range.start, b.location.range.start) || cmpPos(b.location.range.end, a.location.range.end));
	const roots: DocumentSymbol[] = [];
	const stack: DocumentSymbol[] = [];
	for (const s of sorted) {
		const node: DocumentSymbol = { name: s.name, detail: s.containerName ?? '', kind: s.kind, range: s.location.range, selectionRange: s.location.range, children: [] };
		while (stack.length && !containsRange(stack[stack.length - 1].range, node.range)) stack.pop();
		(stack.length ? stack[stack.length - 1].children! : roots).push(node);
		stack.push(node);
	}
	return roots;
}

export function outlineTree(symbols: readonly (DocumentSymbol | SymbolInformation)[]): OutlineItem[] {
	const docs = symbols.length && !isDocumentSymbol(symbols[0]) ? nestSymbolInformation(symbols as SymbolInformation[]) : (symbols as DocumentSymbol[]);
	const build = (list: DocumentSymbol[], parent: string): OutlineItem[] => {
		const seen = new Map<string, number>();
		return list.map((s) => {
			const n = seen.get(s.name) ?? 0;
			seen.set(s.name, n + 1);
			const id = `${parent}/${s.name}${n ? `#${n}` : ''}`;
			return { id, name: s.name, detail: s.detail ?? '', kind: s.kind, range: s.range, selectionRange: s.selectionRange, children: build(s.children ?? [], id) };
		});
	};
	return build(docs, '');
}

/** `outline.show*` per LSP SymbolKind; a hidden element hides its children (VS Code's DocumentSymbolFilter). */
export const OUTLINE_KIND_SETTINGS: Readonly<Record<number, string>> = {
	1: 'outline.showFiles',
	2: 'outline.showModules',
	3: 'outline.showNamespaces',
	4: 'outline.showPackages',
	5: 'outline.showClasses',
	6: 'outline.showMethods',
	7: 'outline.showProperties',
	8: 'outline.showFields',
	9: 'outline.showConstructors',
	10: 'outline.showEnums',
	11: 'outline.showInterfaces',
	12: 'outline.showFunctions',
	13: 'outline.showVariables',
	14: 'outline.showConstants',
	15: 'outline.showStrings',
	16: 'outline.showNumbers',
	17: 'outline.showBooleans',
	18: 'outline.showArrays',
	19: 'outline.showObjects',
	20: 'outline.showKeys',
	21: 'outline.showNull',
	22: 'outline.showEnumMembers',
	23: 'outline.showStructs',
	24: 'outline.showEvents',
	25: 'outline.showOperators',
	26: 'outline.showTypeParameters'
};

export function filterKinds(items: OutlineItem[], get: Get): OutlineItem[] {
	return items.filter((i) => get<boolean>(OUTLINE_KIND_SETTINGS[i.kind] ?? '') !== false).map((i) => ({ ...i, children: filterKinds(i.children, get) }));
}

const collator = new Intl.Collator(undefined, { numeric: true });

/** OutlineItemComparator: position (range start), name, or kind then name. */
export function sortOutline(items: OutlineItem[], order: OutlineSortOrder): OutlineItem[] {
	const byPos = (a: OutlineItem, b: OutlineItem) => cmpPos(a.range.start, b.range.start) || cmpPos(a.range.end, b.range.end);
	const cmp =
		order === 'name'
			? (a: OutlineItem, b: OutlineItem) => collator.compare(a.name, b.name) || byPos(a, b)
			: order === 'kind'
				? (a: OutlineItem, b: OutlineItem) => a.kind - b.kind || collator.compare(a.name, b.name)
				: byPos;
	return [...items].sort(cmp).map((i) => ({ ...i, children: sortOutline(i.children, order) }));
}

/** Filter on type: matching elements and their ancestors stay; `matches` says which matched. */
export function filterText(items: OutlineItem[], query: string): { items: OutlineItem[]; matches: Set<string> } {
	const matches = new Set<string>();
	if (!query.trim()) return { items, matches };
	const walk = (list: OutlineItem[]): OutlineItem[] =>
		list.flatMap((i) => {
			const children = walk(i.children);
			const hit = fuzzyMatch(query, i.name) !== null;
			if (hit) matches.add(i.id);
			return hit || children.length ? [{ ...i, children }] : [];
		});
	return { items: walk(items), matches };
}

/** OutlineModel.getItemEnclosingPosition: the deepest element whose range holds `pos`, with its ancestors. */
export function enclosingPath(items: OutlineItem[], pos: Position): OutlineItem[] {
	const out: OutlineItem[] = [];
	let level = items;
	for (;;) {
		const hit = level.find((i) => contains(i.range, pos));
		if (!hit) return out;
		out.push(hit);
		level = hit.children;
	}
}

export type MarkerRange = Range & { severity: number };

/**
 * OutlineModel._updateMarker: each element takes the markers intersecting it, lets its children
 * claim theirs, and keeps the count of the rest plus the worst severity of all (the dot that says
 * "a child has problems"). Severities are LSP's (1 Error, 2 Warning); only those two count.
 */
export function applyMarkers(items: OutlineItem[], markers: MarkerRange[]): OutlineItem[] {
	const intersects = (a: Range, b: Range) => !(cmpPos(a.end, b.start) < 0 || cmpPos(b.end, a.start) < 0);
	const visit = (list: OutlineItem[], pool: MarkerRange[]): OutlineItem[] => {
		const claimed = new Set<MarkerRange>();
		const out = list.map((item) => {
			const mine = pool.filter((m) => !claimed.has(m) && intersects(item.range, m));
			mine.forEach((m) => claimed.add(m));
			const topSev = mine.length ? Math.min(...mine.map((m) => m.severity)) : 0;
			const inChildren = new Set<MarkerRange>();
			const children = visit(item.children, mine);
			const collect = (l: OutlineItem[], ms: MarkerRange[]) => {
				for (const c of l) for (const m of ms) if (intersects(c.range, m)) inChildren.add(m);
			};
			collect(item.children, mine);
			const count = mine.filter((m) => !inChildren.has(m)).length;
			return { ...item, children, marker: topSev ? { count, topSev } : undefined };
		});
		return out;
	};
	return visit(items, markers.filter((m) => m.severity === 1 || m.severity === 2));
}

export type OutlineRow = { item: OutlineItem; depth: number; expanded: boolean; hasChildren: boolean };

/** The visible rows: `expanded(id)` decides each element with children. */
export function outlineRows(items: OutlineItem[], expanded: (id: string) => boolean, forceOpen = false): OutlineRow[] {
	const out: OutlineRow[] = [];
	const walk = (list: OutlineItem[], depth: number) => {
		for (const item of list) {
			const hasChildren = item.children.length > 0;
			const open = hasChildren && (forceOpen || expanded(item.id));
			out.push({ item, depth, expanded: open, hasChildren });
			if (open) walk(item.children, depth + 1);
		}
	};
	walk(items, 0);
	return out;
}

/** Ids of every element with children (Collapse All, Expand All). */
export function parentIds(items: OutlineItem[]): string[] {
	return items.flatMap((i) => (i.children.length ? [i.id, ...parentIds(i.children)] : []));
}
