/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { explorerCoverage, coverageColor, coverageTotals, coverageTree, displayedPercent, displayPercent, lineDecorations, mergeCoverage, parseGoCoverProfile, parseLcov, totalPercent } from './coverage.ts';

const ROOT = '/work';
const resolve = (p: string) => (p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length + 1) : p.startsWith('/') ? null : `app/${p}`);

describe('lcov', () => {
	const lcov = [
		'TN:',
		'SF:/work/app/src/math.ts',
		'FN:1,add',
		'FN:5,sub',
		'FNDA:3,add',
		'FNDA:0,sub',
		'FNF:2',
		'FNH:1',
		'DA:1,3',
		'DA:2,3',
		'DA:5,0',
		'DA:6,0',
		'BRDA:2,0,0,3',
		'BRDA:2,0,1,-',
		'LF:4',
		'LH:2',
		'end_of_record',
		// bun writes paths relative to the project.
		'SF:src/util.ts',
		'DA:1,1',
		'end_of_record',
		// A file outside the folder is dropped.
		'SF:/usr/lib/node/x.js',
		'DA:1,1',
		'end_of_record'
	].join('\n');

	test('reads statements, functions and branches per file', () => {
		const files = parseLcov(lcov, resolve);
		expect(files.map((f) => f.rel)).toEqual(['app/src/math.ts', 'app/src/util.ts']);
		const math = files[0];
		expect(math.statement).toEqual({ covered: 2, total: 4 });
		expect(math.declaration).toEqual({ covered: 1, total: 2 });
		expect(math.branch).toEqual({ covered: 1, total: 2 });
		expect([...math.missedBranches]).toEqual([2]);
		expect(lineDecorations(math, 100)).toEqual([
			{ line: 1, kind: 'covered' },
			{ line: 2, kind: 'partial' },
			{ line: 5, kind: 'uncovered' },
			{ line: 6, kind: 'uncovered' }
		]);
		expect(lineDecorations(math, 2).length).toBe(2);
	});

	test('two records of one file keep the most hits per line', () => {
		const a = parseLcov('SF:/work/a.ts\nDA:1,0\nDA:2,1\nend_of_record', resolve);
		const b = parseLcov('SF:/work/a.ts\nDA:1,4\nDA:2,0\nend_of_record', resolve);
		const [m] = mergeCoverage([...a, ...b]);
		expect(m.statement).toEqual({ covered: 2, total: 2 });
		expect(m.lines.get(1)).toBe(4);
	});
});

test('Go cover profile', () => {
	const profile = ['mode: set', 'example.com/m/calc/calc.go:3.24,5.2 1 1', 'example.com/m/calc/calc.go:7.24,9.2 2 0', 'other.org/x/y.go:1.1,2.2 1 1'].join('\n');
	const files = parseGoCoverProfile(profile, (p) => (p.startsWith('example.com/m/') ? `svc/${p.slice('example.com/m/'.length)}` : null));
	expect(files).toHaveLength(1);
	expect(files[0].rel).toBe('svc/calc/calc.go');
	expect(files[0].statement).toEqual({ covered: 1, total: 3 });
	expect(files[0].lines.get(4)).toBe(1);
	expect(files[0].lines.get(8)).toBe(0);
});

describe('percentages', () => {
	const c = { statement: { covered: 8, total: 10 }, branch: { covered: 1, total: 4 }, declaration: { covered: 2, total: 2 } };
	test('testing.displayedCoveragePercent', () => {
		expect(totalPercent(c)).toBeCloseTo(11 / 16);
		expect(displayedPercent(c, 'totalCoverage')).toBeCloseTo(11 / 16);
		expect(displayedPercent(c, 'statement')).toBeCloseTo(0.8);
		expect(displayedPercent(c, 'minimum')).toBeCloseTo(0.25);
		expect(displayedPercent({ statement: { covered: 0, total: 0 } }, 'statement')).toBe(1);
	});
	test('displayPercent never rounds up to 100%', () => {
		expect(displayPercent(0.5)).toBe('50.00%');
		expect(displayPercent(0.999999)).toBe('99.99%');
		expect(displayPercent(1)).toBe('100.00%');
	});
	test('testing.coverageBarThresholds', () => {
		expect(coverageColor(0.3, null)).toBe('red');
		expect(coverageColor(0.7, null)).toBe('yellow');
		expect(coverageColor(0.95, null)).toBe('green');
		expect(coverageColor(0.7, { yellow: 80, green: 95 })).toBe('red');
		expect(coverageColor(0.96, { yellow: 80, green: 95 })).toBe('green');
	});
});

test('the Test Coverage tree sums folders and compacts single-folder chains', () => {
	const files = parseLcov(['SF:/work/src/lib/a.ts', 'DA:1,1', 'DA:2,0', 'end_of_record', 'SF:/work/src/lib/b.ts', 'DA:1,1', 'end_of_record', 'SF:/work/main.ts', 'DA:1,0', 'end_of_record'].join('\n'), resolve);
	const tree = coverageTree(files);
	expect(tree.map((n) => [n.label, n.kind])).toEqual([
		['src/lib', 'folder'],
		['main.ts', 'file']
	]);
	expect(tree[0].statement).toEqual({ covered: 2, total: 3 });
	expect(tree[0].children.map((c) => c.label)).toEqual(['a.ts', 'b.ts']);
	expect(coverageTotals(files).statement).toEqual({ covered: 2, total: 4 });
});

test('testing.showCoverageInExplorer: files and the folders above them', () => {
	const files = parseLcov(['SF:/work/src/a.ts', 'DA:1,1', 'DA:2,0', 'end_of_record', 'SF:/work/src/b/c.ts', 'DA:1,1', 'end_of_record'].join('\n'), resolve);
	const map = explorerCoverage(files);
	expect(map.get('src')?.statement).toEqual({ covered: 2, total: 3 });
	expect(map.get('src/b')?.statement).toEqual({ covered: 1, total: 1 });
	expect(map.get('src/a.ts')?.statement).toEqual({ covered: 1, total: 2 });
	expect(map.has('src/b/c.ts')).toBe(true);
});
