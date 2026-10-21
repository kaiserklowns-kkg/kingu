/// <reference types="bun" />
// Tests a runner reports that the file scan could not see (test.each, parametrized cases, Go subtests).
import { describe, expect, test } from 'bun:test';
import { addDynamic, fileItem, findItem, isDynamic, keepDynamic, leaves } from './model.ts';
import { parseJestJson } from './results.ts';
import { runPlans } from './runners.ts';

const file = fileItem('vitest', '', 'src/math.test.ts', [{ name: 'math', line: 1, kind: 'suite', children: [{ name: 'adds', line: 2, kind: 'test', children: [] }] }]);

describe('dynamic tests', () => {
	test('a reported test.each case joins its suite', () => {
		const { file: next, id } = addDynamic(file, ['math', 'adds 1 + 2'], 5);
		expect(id).toBe('vitest:src/math.test.ts::math > adds 1 + 2');
		const added = findItem([next], id)!;
		expect(added).toMatchObject({ kind: 'test', label: 'adds 1 + 2', line: 5, path: ['math', 'adds 1 + 2'], rel: 'src/math.test.ts' });
		expect(isDynamic(added)).toBe(true);
		expect(next.children[0].children.map((c) => c.label)).toEqual(['adds', 'adds 1 + 2']);
		// Known already: the same file comes back.
		expect(addDynamic(next, ['math', 'adds 1 + 2']).file).toBe(next);
	});

	test('missing parents become suites', () => {
		const { file: next, id } = addDynamic(file, ['table', 'case %s', 'a']);
		expect(findItem([next], 'vitest:src/math.test.ts::table')?.kind).toBe('suite');
		expect(findItem([next], 'vitest:src/math.test.ts::table > case %s')?.kind).toBe('suite');
		expect(findItem([next], id)?.kind).toBe('test');
	});

	test('a Go subtest nests under its test, which still runs as one', () => {
		const go = fileItem('go', '', 'calc_test.go', [{ name: 'TestAdd', line: 3, kind: 'test', children: [] }], { dir: '.', importPath: 'example.com/m' });
		const { file: next, id } = addDynamic(go, ['TestAdd', 'negative']);
		const parent = findItem([next], 'go:calc_test.go::TestAdd')!;
		expect(parent.kind).toBe('test');
		expect(parent.children.map((c) => c.id)).toEqual([id]);
		expect(leaves(parent).map((l) => l.id)).toEqual([parent.id]);
		// Running the subtest runs its top-level test.
		const [plan] = runPlans([findItem([next], id)!], { report: () => '' });
		expect(plan.argv).toContain('^(TestAdd)$');
	});

	test('a rescan keeps what runs added while the parent is still declared', () => {
		const withCase = addDynamic(file, ['math', 'adds 1 + 2'], 5).file;
		const rescanned = fileItem('vitest', '', 'src/math.test.ts', [{ name: 'math', line: 1, kind: 'suite', children: [{ name: 'adds', line: 2, kind: 'test', children: [] }] }]);
		expect(findItem([keepDynamic(rescanned, withCase)], 'vitest:src/math.test.ts::math > adds 1 + 2')).toBeDefined();
		// The describe was renamed: its cases go.
		const renamed = fileItem('vitest', '', 'src/math.test.ts', [{ name: 'arith', line: 1, kind: 'suite', children: [] }]);
		expect(findItem([keepDynamic(renamed, withCase)], 'vitest:src/math.test.ts::math > adds 1 + 2')).toBeUndefined();
	});

	test("jest/vitest JSON gives a case's line", () => {
		const json = JSON.stringify({ testResults: [{ name: '/w/src/math.test.ts', assertionResults: [{ ancestorTitles: ['math'], title: 'adds 1 + 2', status: 'passed', location: { line: 5, column: 3 } }] }] });
		expect(parseJestJson(json)[0]).toMatchObject({ path: ['math', 'adds 1 + 2'], line: 5, state: 'passed' });
	});
});
