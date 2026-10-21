/// <reference types="bun" />
// Continuous run (which tests a change reruns), the failure peek's expected/actual diff and the
// Test Coverage view's filter and sort.
import { describe, expect, test } from 'bun:test';
import { affectedTests, ALL, isWatched, testCount, toggleWatched, watchedItems } from './continuous.ts';
import { fileItem, projectItems, type Declared } from './model.ts';
import { hasDiff, messageDiff } from './messageDiff.ts';
import { filterCoverageFiles, sortCoverageNodes } from './coverageView.ts';
import { coverageTree, totalPercent, type FileCoverage } from './coverage.ts';

const d = (name: string, line: number, children: Declared[] = []): Declared => ({ name, line, kind: children.length ? 'suite' : 'test', children });

const items = projectItems([
	fileItem('bun', 'web', 'web/src/a.test.ts', [d('adds', 1), d('math', 3, [d('mul', 4)])]),
	fileItem('bun', 'web', 'web/src/b.test.ts', [d('b', 1)]),
	fileItem('cargo', 'core', 'core/src/lib.rs', [d('it_works', 9)], { crate: 'core', target: 'lib', prefix: '' })
]);
const web = items.find((i) => i.project === 'web')!;
const fileA = web.children.find((f) => f.rel === 'web/src/a.test.ts')!;
const mul = fileA.children.find((s) => s.label === 'math')!.children[0];
const ids = (list: { id: string }[]) => list.map((i) => i.id);

describe('continuous run', () => {
	test('a saved test file reruns its watched tests only', () => {
		expect(ids(affectedTests(items, new Set([web.id]), ['web/src/a.test.ts']))).toEqual([fileA.id]);
		expect(ids(affectedTests(items, new Set([mul.id]), ['web/src/a.test.ts']))).toEqual([mul.id]);
		expect(affectedTests(items, new Set([mul.id]), ['web/src/b.test.ts'])).toEqual([]);
	});

	test('another file of the project reruns the watched items there; other projects are left alone', () => {
		expect(ids(affectedTests(items, new Set([web.id]), ['web/src/util.ts']))).toEqual([web.id]);
		expect(affectedTests(items, new Set([web.id]), ['core/src/other.rs'])).toEqual([]);
		const all = affectedTests(items, new Set([ALL]), ['core/src/other.rs']);
		expect(all.map((i) => i.project)).toEqual(['core']);
	});

	test('an item inside another chosen one is not run twice', () => {
		const got = affectedTests(items, new Set([web.id, mul.id]), ['web/src/a.test.ts', 'web/src/util.ts']);
		expect(ids(got)).toEqual([web.id]);
	});

	test('watching: ids, ancestors and ALL; toggling', () => {
		expect(watchedItems(items, new Set([ALL])).length).toBe(items.length);
		expect(watchedItems(items, new Set(['gone']))).toEqual([]);
		expect(isWatched(new Set([web.id]), mul, [web, fileA])).toBe(true);
		expect(isWatched(new Set([fileA.id]), web, [])).toBe(false);
		const on = toggleWatched(new Set(), web.id);
		expect([...on]).toEqual([web.id]);
		expect([...toggleWatched(on, web.id)]).toEqual([]);
		expect(testCount([web])).toBe(3);
	});
});

describe('failure diff', () => {
	test('expected against actual, line by line', () => {
		expect(messageDiff('{\n  "a": 1,\n  "b": 2\n}', '{\n  "a": 1,\n  "b": 3\n}')).toEqual([
			{ kind: 'ctx', text: '{' },
			{ kind: 'ctx', text: '  "a": 1,' },
			{ kind: 'expected', text: '  "b": 2' },
			{ kind: 'actual', text: '  "b": 3' },
			{ kind: 'ctx', text: '}' }
		]);
		expect(messageDiff('a\nb', 'a\nx\nb')).toEqual([
			{ kind: 'ctx', text: 'a' },
			{ kind: 'actual', text: 'x' },
			{ kind: 'ctx', text: 'b' }
		]);
		expect(messageDiff('a\nb\nc', 'a\nc')).toEqual([
			{ kind: 'ctx', text: 'a' },
			{ kind: 'expected', text: 'b' },
			{ kind: 'ctx', text: 'c' }
		]);
		expect(hasDiff('1', '2')).toBe(true);
		expect(hasDiff('1', '1')).toBe(false);
		expect(hasDiff(undefined, '1')).toBe(false);
	});
});

describe('coverage view', () => {
	const file = (rel: string, covered: number, total: number): FileCoverage => ({ rel, lines: new Map(), statement: { covered, total } }) as FileCoverage;
	const files = [file('src/a.ts', 9, 10), file('src/z.ts', 1, 10), file('lib/m.ts', 5, 10), file('main.ts', 2, 10)];

	test('the filter matches every word of the path', () => {
		expect(filterCoverageFiles(files, 'src').map((f) => f.rel)).toEqual(['src/a.ts', 'src/z.ts']);
		expect(filterCoverageFiles(files, 'SRC z').map((f) => f.rel)).toEqual(['src/z.ts']);
		expect(filterCoverageFiles(files, '  ').length).toBe(4);
	});

	test('sort by name or coverage keeps folders first', () => {
		const tree = coverageTree(files);
		const labels = (nodes: ReturnType<typeof coverageTree>): string[] => nodes.flatMap((n) => [n.label, ...labels(n.children)]);
		expect(labels(sortCoverageNodes(tree, 'location', totalPercent))).toEqual(labels(tree));
		const byCoverage = sortCoverageNodes(tree, 'coverage', totalPercent);
		expect(byCoverage.at(-1)?.label).toBe('main.ts');
		const src = byCoverage.find((n) => n.label === 'src');
		expect(src?.children.map((n) => n.label)).toEqual(['z.ts', 'a.ts']);
		expect(sortCoverageNodes(tree, 'name', totalPercent).filter((n) => n.kind === 'folder').map((n) => n.label)).toEqual(['lib', 'src']);
	});
});
