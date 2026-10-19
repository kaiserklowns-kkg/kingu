import { describe, expect, test } from 'bun:test';
import type { DocumentSymbol, SymbolInformation } from '#lib/lsp/protocol.ts';
import { applyMarkers, enclosingPath, filterKinds, filterText, fromMonacoSymbols, outlineRows, outlineTree, parentIds, sortOutline, type OutlineItem } from './outlineModel';
import { hierarchyRows, nodeLocation, type HierarchyNode } from './hierarchyModel';
import { selectorMatches } from '#lib/editor/symbolProviders.ts';

const range = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
const sym = (name: string, kind: number, r: ReturnType<typeof range>, children: DocumentSymbol[] = []): DocumentSymbol => ({ name, kind, range: r, selectionRange: r, children });

// class Zoo { b() {} a() {} a() {} }  const x = 1;
const doc: DocumentSymbol[] = [
	sym('x', 14, range(10, 0, 10, 12)),
	sym('Zoo', 5, range(0, 0, 8, 1), [sym('b', 6, range(1, 2, 2, 3)), sym('a', 6, range(3, 2, 4, 3), [sym('inner', 13, range(3, 10, 3, 20))]), sym('a', 6, range(5, 2, 6, 3))])
];
const names = (items: OutlineItem[]): unknown[] => items.map((i) => (i.children.length ? [i.name, names(i.children)] : i.name));

describe('outline tree', () => {
	test('stable ids, same-named siblings counted', () => {
		const tree = outlineTree(doc);
		expect(tree.map((i) => i.id)).toEqual(['/x', '/Zoo']);
		expect(tree[1].children.map((i) => i.id)).toEqual(['/Zoo/b', '/Zoo/a', '/Zoo/a#1']);
		expect(tree[1].children[1].children[0].id).toBe('/Zoo/a/inner');
	});

	test('flat SymbolInformation is nested by range', () => {
		const info: SymbolInformation[] = [
			{ name: 'm', kind: 6, location: { uri: 'file:///a', range: range(1, 0, 2, 0) } },
			{ name: 'C', kind: 5, location: { uri: 'file:///a', range: range(0, 0, 5, 0) } },
			{ name: 'f', kind: 12, location: { uri: 'file:///a', range: range(6, 0, 7, 0) } }
		];
		expect(names(outlineTree(info))).toEqual([['C', ['m']], 'f']);
	});

	test('Monaco symbols convert back to LSP shapes', () => {
		const m = fromMonacoSymbols([{ name: 'f', detail: '', kind: 11, tags: [], range: { startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 2 }, selectionRange: { startLineNumber: 2, startColumn: 10, endLineNumber: 2, endColumn: 11 } }]);
		expect(m[0]).toMatchObject({ name: 'f', kind: 12, range: range(1, 0, 3, 1), selectionRange: range(1, 9, 1, 10) });
	});

	test('sort by position, name and category', () => {
		const tree = outlineTree(doc);
		expect(names(sortOutline(tree, 'position'))).toEqual([['Zoo', ['b', ['a', ['inner']], 'a']], 'x']);
		expect(names(sortOutline(tree, 'name'))).toEqual(['x', ['Zoo', [['a', ['inner']], 'a', 'b']]]);
		expect(names(sortOutline(tree, 'kind'))).toEqual([['Zoo', [['a', ['inner']], 'a', 'b']], 'x']); // class 5 before constant 14
		expect(names(sortOutline(outlineTree([sym('item10', 13, range(0, 0, 0, 1)), sym('item9', 13, range(1, 0, 1, 1))]), 'name'))).toEqual(['item9', 'item10']);
	});

	test('outline.show* hides an element with its children', () => {
		const get = <T,>(id: string) => (id === 'outline.showMethods' ? false : true) as T;
		expect(names(filterKinds(outlineTree(doc), get))).toEqual(['x', 'Zoo']);
	});

	test('filter on type keeps matches and their ancestors', () => {
		const { items, matches } = filterText(outlineTree(doc), 'inn');
		expect(names(items)).toEqual([['Zoo', [['a', ['inner']]]]]);
		expect([...matches]).toEqual(['/Zoo/a/inner']);
		expect(filterText(outlineTree(doc), '').items.length).toBe(2);
	});

	test('follow cursor: the deepest element around the position', () => {
		const tree = outlineTree(doc);
		expect(enclosingPath(tree, { line: 3, character: 12 }).map((i) => i.name)).toEqual(['Zoo', 'a', 'inner']);
		expect(enclosingPath(tree, { line: 7, character: 0 }).map((i) => i.name)).toEqual(['Zoo']);
		expect(enclosingPath(tree, { line: 9, character: 0 })).toEqual([]);
	});

	test('rows follow expansion; Collapse All ids', () => {
		const tree = sortOutline(outlineTree(doc), 'position');
		expect(outlineRows(tree, () => false).map((r) => r.item.name)).toEqual(['Zoo', 'x']);
		const rows = outlineRows(tree, () => true);
		expect(rows.map((r) => [r.item.name, r.depth])).toEqual([['Zoo', 0], ['b', 1], ['a', 1], ['inner', 2], ['a', 1], ['x', 0]]);
		expect(outlineRows(tree, () => false, true).length).toBe(6); // filtering shows everything
		expect(parentIds(tree)).toEqual(['/Zoo', '/Zoo/a']);
	});

	test('problem markers: counted where no child claims them, worst severity bubbles up', () => {
		const tree = applyMarkers(outlineTree(doc), [
			{ ...range(3, 12, 3, 13), severity: 2 }, // in inner
			{ ...range(7, 0, 7, 3), severity: 1 }, // in Zoo only
			{ ...range(10, 1, 10, 2), severity: 3 } // info: ignored
		]);
		const zoo = tree[1];
		expect(zoo.marker).toEqual({ count: 1, topSev: 1 });
		expect(zoo.children[1].marker).toEqual({ count: 0, topSev: 2 });
		expect(zoo.children[1].children[0].marker).toEqual({ count: 1, topSev: 2 });
		expect(zoo.children[0].marker).toBeUndefined();
		expect(tree[0].marker).toBeUndefined();
	});
});

describe('Monaco symbol providers and hierarchy rows', () => {
	test('language selectors', () => {
		expect(selectorMatches('typescript', 'typescript')).toBe(true);
		expect(selectorMatches(['json', 'css'], 'css')).toBe(true);
		expect(selectorMatches({ language: 'html' }, 'css')).toBe(false);
		expect(selectorMatches('*', 'rust')).toBe(true);
	});

	test('hierarchy rows and where nodes open', () => {
		const item = (name: string) => ({ name, kind: 12, uri: `file:///ws/${name}.ts`, range: range(0, 0, 9, 0), selectionRange: range(0, 9, 0, 12) });
		const child: HierarchyNode = { id: '0/0', item: item('caller'), ranges: [range(4, 2, 4, 5)], children: null, loading: false, expanded: false };
		const root: HierarchyNode = { id: '0', item: item('f'), ranges: [], children: [child], loading: false, expanded: true };
		expect(hierarchyRows([root]).map((r) => [r.node.item.name, r.depth])).toEqual([['f', 0], ['caller', 1]]);
		expect(hierarchyRows([{ ...root, expanded: false }]).length).toBe(1);
		expect(nodeLocation(child, 'incoming').range).toEqual(range(4, 2, 4, 5));
		expect(nodeLocation(child, 'outgoing').range).toEqual(range(0, 9, 0, 12));
		expect(nodeLocation(root, 'incoming').range).toEqual(range(0, 9, 0, 12));
	});
});
