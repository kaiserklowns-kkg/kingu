/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { ProblemFile } from './model.ts';
import type { Diagnostic } from './protocol.ts';
import { copyText, DEFAULT_PROBLEMS_FILTER, filterProblems, isFiltering, matchesText, parseProblemsFilter, splitGlobAware, type ProblemsFilterState } from './problemsFilter.ts';

const diag = (message: string, severity = 1, extra: Partial<Diagnostic> = {}): Diagnostic => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message, severity, ...extra });
const file = (rel: string, items: Diagnostic[]): ProblemFile => ({ uri: `file:///w/${rel}`, rel, label: rel, detail: '', items });

const FILES = [
	file('src/a.ts', [diag('Cannot find name foo', 1, { source: 'ts', code: 2304 }), diag('Unused variable', 2, { source: 'eslint', code: 'no-unused-vars' })]),
	file('src/b.rs', [diag('mismatched types', 1, { source: 'rustc' }), diag('consider borrowing', 3, { source: 'rustc' }), diag('hint only', 4)]),
	file('node_modules/x/index.js', [diag('Lint in a dependency', 2)])
];
const run = (state: Partial<ProblemsFilterState>, files = FILES) => filterProblems(files, { ...DEFAULT_PROBLEMS_FILTER, ...state });
const messages = (r: ReturnType<typeof run>) => r.files.flatMap((f) => f.items.map((d) => d.message));

describe('parseProblemsFilter', () => {
	test('text, negation and globs (VS Code FilterOptions)', () => {
		const f = parseProblemsFilter('  !foo ');
		expect([f.text, f.negate]).toEqual(['foo', true]);
		expect(f.exclude.some((re) => re.test('a/foo/b.ts'))).toBe(true);
		const g = parseProblemsFilter('.ts, !**/node_modules/**');
		expect(g.include.some((re) => re.test('/w/src/a.ts'))).toBe(true);
		expect(g.exclude.some((re) => re.test('/w/node_modules/x/index.js'))).toBe(true);
	});

	test('@source filters are taken out of the text', () => {
		const f = parseProblemsFilter('@source:ts !@source:"my lint" foo');
		expect(f.includeSources).toEqual(['ts']);
		expect(f.excludeSources).toEqual(['my lint']);
		expect(f.text).toBe('foo');
	});

	test('splitGlobAware keeps braces together', () => {
		expect(splitGlobAware('*.{ts,js},src')).toEqual(['*.{ts,js}', 'src']);
	});

	test('matchesText is a case-insensitive substring with * wildcards', () => {
		expect(matchesText('find', 'Cannot FIND name')).toBe(true);
		expect(matchesText('can*name', 'Cannot find name')).toBe(true);
		expect(matchesText('x.y', 'xzy')).toBe(false);
	});
});

describe('filterProblems', () => {
	test('no filter: everything but hints, with the totals', () => {
		const r = run({});
		expect(r.total).toBe(5);
		expect(r.shown).toBe(5);
		expect(messages(r)).not.toContain('hint only');
	});

	test('severity toggles', () => {
		expect(messages(run({ showErrors: false, showWarnings: false }))).toEqual(['consider borrowing']);
		expect(run({ showInfos: false }).shown).toBe(4);
	});

	test('text matches the message, source or code; ! hides them', () => {
		expect(messages(run({ text: 'mismatched' }))).toEqual(['mismatched types']);
		expect(messages(run({ text: 'eslint' }))).toEqual(['Unused variable']);
		expect(messages(run({ text: '2304' }))).toEqual(['Cannot find name foo']);
		expect(messages(run({ text: '!rustc' }))).toEqual(['Cannot find name foo', 'Unused variable', 'Lint in a dependency']);
	});

	test('a file name match shows all its problems', () => {
		expect(messages(run({ text: 'b.rs' }))).toEqual(['mismatched types', 'consider borrowing']);
	});

	test('globs include and exclude files', () => {
		expect(run({ text: '.rs' }).files.map((f) => f.rel)).toEqual(['src/b.rs']);
		expect(run({ text: '!**/node_modules/**' }).files.map((f) => f.rel)).toEqual(['src/a.ts', 'src/b.rs']);
	});

	test('source filter', () => {
		expect(messages(run({ text: '@source:rustc' }))).toEqual(['mismatched types', 'consider borrowing']);
		expect(run({ text: '!@source:rustc' }).files.map((f) => f.rel)).toEqual(['src/a.ts', 'node_modules/x/index.js']);
	});

	test('active file only and hide excluded files', () => {
		expect(run({ activeFile: 'src/a.ts' }).files.map((f) => f.rel)).toEqual(['src/a.ts']);
		expect(run({ filesExclude: ['**/node_modules'] }).files.map((f) => f.rel)).toEqual(['src/a.ts', 'src/b.rs']);
	});

	test('isFiltering and copy', () => {
		expect(isFiltering(DEFAULT_PROBLEMS_FILTER)).toBe(false);
		expect(isFiltering({ ...DEFAULT_PROBLEMS_FILTER, showInfos: false })).toBe(true);
		const json = JSON.parse(copyText(FILES[0], FILES[0].items[0]));
		expect(json).toMatchObject({ resource: 'file:///w/src/a.ts', code: 2304, severity: 8, message: 'Cannot find name foo', startLineNumber: 1, startColumn: 1 });
	});
});
