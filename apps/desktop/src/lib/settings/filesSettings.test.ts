/// <reference types="bun" />
// files.* / explorer.* / search.* settings → what the Explorer, Search, Quick Open and the text
// file service do with them (the pure parts).
import { describe, expect, test } from 'bun:test';
import { autoSaves, searchSettingsFrom, sortEntries, type Get } from './mappings';
import { resolveSettings } from './registry';
import { trimTrailingWhitespaceEdits } from './saveParticipants';
import { autoRevealOf, withPathSeparator } from '../workbench/explorerModel';
import { isReadonly } from '../workbench/readonly';
import { defaultLanguage } from '../workbench/untitled';
import { flattenResults, folderKey, sortResults, startsCollapsed, type FileMatches } from '../workbench/searchResults';
import { rankFiles } from '../workbench/quickAccess';

const getter = (user: Record<string, unknown> = {}): Get => {
	const m = resolveSettings(user, {});
	return (<T>(id: string) => m.get(id)?.value as T) as Get;
};

describe('explorer sorting', () => {
	const entries = [
		{ name: 'b.ts', is_dir: false },
		{ name: 'B.md', is_dir: false },
		{ name: 'a10.ts', is_dir: false },
		{ name: 'a9.ts', is_dir: false },
		{ name: 'src', is_dir: true },
		{ name: 'Zed', is_dir: true }
	];
	const names = (...args: Parameters<typeof sortEntries>) => sortEntries(...args).map((e) => e.name);

	test('explorer.sortOrderLexicographicOptions', () => {
		expect(names(entries, 'default', 'default')).toEqual(['src', 'Zed', 'a9.ts', 'a10.ts', 'B.md', 'b.ts']);
		expect(names(entries, 'default', 'upper')).toEqual(['Zed', 'src', 'B.md', 'a9.ts', 'a10.ts', 'b.ts']);
		expect(names(entries, 'default', 'lower')).toEqual(['src', 'Zed', 'a9.ts', 'a10.ts', 'b.ts', 'B.md']);
		expect(names(entries, 'mixed', 'unicode')).toEqual(['B.md', 'Zed', 'a10.ts', 'a9.ts', 'b.ts', 'src']);
	});

	test('explorer.sortOrderReverse flips every comparison, folders included', () => {
		expect(names(entries, 'default', 'default', true)).toEqual(['b.ts', 'B.md', 'a10.ts', 'a9.ts', 'Zed', 'src']);
	});

	test('foldersNestsFiles: folders, then files with nested files, then the rest', () => {
		const nested = [{ name: 'a.js', is_dir: false }, { name: 'z.ts', is_dir: false, hasNests: true }, { name: 'lib', is_dir: true }];
		expect(names(nested, 'foldersNestsFiles')).toEqual(['lib', 'z.ts', 'a.js']);
		expect(names(nested, 'default')).toEqual(['lib', 'a.js', 'z.ts']);
	});
});

describe('explorer', () => {
	test('explorer.copyPathSeparator / copyRelativePathSeparator', () => {
		expect(withPathSeparator('src/lib/a.ts', 'auto')).toBe('src/lib/a.ts');
		expect(withPathSeparator('src/lib/a.ts', '/')).toBe('src/lib/a.ts');
		expect(withPathSeparator('src/lib/a.ts', '\\')).toBe('src\\lib\\a.ts');
	});

	test('explorer.autoReveal and autoRevealExclude', () => {
		expect(autoRevealOf(true, false)).toEqual({ reveal: true, scroll: true });
		expect(autoRevealOf('focusNoScroll', false)).toEqual({ reveal: true, scroll: false });
		expect(autoRevealOf(false, false)).toEqual({ reveal: false, scroll: false });
		expect(autoRevealOf(true, true)).toEqual({ reveal: false, scroll: false });
		expect(getter()<unknown>('explorer.autoReveal')).toBe(true);
		expect(getter({ 'explorer.autoReveal': 'focusNoScroll' })<unknown>('explorer.autoReveal')).toBe('focusNoScroll');
		expect(getter({ 'explorer.autoReveal': 'sometimes' })<unknown>('explorer.autoReveal')).toBe(true);
		expect(getter()<unknown>('explorer.autoRevealExclude')).toEqual({ '**/node_modules': true, '**/bower_components': true });
	});
});

describe('files', () => {
	test('files.readonlyInclude / readonlyExclude / readonlyFromPermissions', () => {
		const s = (include: Record<string, boolean> = {}, exclude: Record<string, boolean> = {}, fromPermissions = false) => ({ include, exclude, fromPermissions });
		expect(isReadonly('src/a.ts', '/ws/src/a.ts', s(), true)).toBe(false);
		expect(isReadonly('src/a.ts', '/ws/src/a.ts', s({}, {}, true), true)).toBe(true);
		expect(isReadonly('gen/a.ts', '/ws/gen/a.ts', s({ 'gen/**': true }), false)).toBe(true);
		expect(isReadonly('gen/keep.ts', '/ws/gen/keep.ts', s({ 'gen/**': true }, { '**/keep.ts': true }), false)).toBe(false);
		expect(isReadonly('src/a.ts', '/ws/src/a.ts', s({}, { 'src/**': true }, true), true)).toBe(false);
		expect(isReadonly('a.ts', '/ws/a.ts', s({ '/ws/*.ts': true }), false)).toBe(true);
		expect(isReadonly('a.ts', '/ws/a.ts', s({ 'gen/**': false }), false)).toBe(false);
	});

	test('files.autoSaveWorkspaceFilesOnly / files.autoSaveWhenNoErrors', () => {
		const file = (inWorkspace: boolean, hasErrors: boolean) => ({ inWorkspace, hasErrors });
		expect(autoSaves(getter(), file(false, true))).toBe(true);
		expect(autoSaves(getter({ 'files.autoSaveWorkspaceFilesOnly': true }), file(false, false))).toBe(false);
		expect(autoSaves(getter({ 'files.autoSaveWorkspaceFilesOnly': true }), file(true, false))).toBe(true);
		expect(autoSaves(getter({ 'files.autoSaveWhenNoErrors': true }), file(true, true))).toBe(false);
		expect(autoSaves(getter({ 'files.autoSaveWhenNoErrors': true }), file(true, false))).toBe(true);
	});

	test('files.defaultLanguage', () => {
		expect(defaultLanguage('', 'typescript')).toBeNull();
		expect(defaultLanguage('markdown', 'typescript')).toBe('markdown');
		expect(defaultLanguage('${activeEditorLanguage}', 'typescript')).toBe('typescript');
		expect(defaultLanguage('${activeEditorLanguage}', '')).toBeNull();
	});

	test('files.trimTrailingWhitespaceInRegexAndStrings off keeps whitespace a string holds', () => {
		const lines = ['const a = `x  ', 'y`;  ', 'z  '];
		expect(trimTrailingWhitespaceEdits(lines).map((e) => e.startLineNumber)).toEqual([1, 2, 3]);
		expect(trimTrailingWhitespaceEdits(lines, new Set(), (line) => line === 1).map((e) => e.startLineNumber)).toEqual([2, 3]);
	});

	test('VS Code defaults for files.exclude and files.watcherExclude', () => {
		expect(getter()<unknown>('files.exclude')).toEqual({ '**/.git': true, '**/.svn': true, '**/.hg': true, '**/.jj': true, '**/.DS_Store': true, '**/Thumbs.db': true });
		expect(Object.keys(getter()<unknown>('files.watcherExclude') as object)).toContain('*/.git/objects/**');
		expect(getter()<unknown>('files.enableTrash')).toBe(true);
	});
});

describe('search', () => {
	test('search.maxResults null is no limit; search.ripgrep.maxThreads', () => {
		expect(searchSettingsFrom(getter(), true)).toMatchObject({ max_results: 20000, max_threads: 0 });
		expect(searchSettingsFrom(getter({ 'search.maxResults': null, 'search.ripgrep.maxThreads': 4 }), true)).toMatchObject({ max_results: Number.MAX_SAFE_INTEGER, max_threads: 4 });
	});

	const f = (path: string, count: number, modified = 0): FileMatches => ({
		path,
		modified,
		matches: Array.from({ length: count }, (_, i) => ({ line: i + 1, column: 1, end_column: 2, preview: 'x', preview_start: 0, preview_end: 1, text: 'x' }))
	});
	const files = [f('src/b/z.rs', 1, 30), f('README.md', 5, 10), f('src/a.ts', 3, 20), f('lib/y.ts', 2, 40)];
	const order = (o: Parameters<typeof sortResults>[1]) => sortResults(files, o).map((x) => x.path);

	test('search.sortOrder', () => {
		expect(order('default')).toEqual(['README.md', 'lib/y.ts', 'src/a.ts', 'src/b/z.rs']);
		expect(order('fileNames')).toEqual(['src/a.ts', 'README.md', 'lib/y.ts', 'src/b/z.rs']);
		expect(order('type')).toEqual(['README.md', 'src/b/z.rs', 'src/a.ts', 'lib/y.ts']);
		expect(order('modified')).toEqual(['lib/y.ts', 'src/b/z.rs', 'src/a.ts', 'README.md']);
		expect(order('countDescending')).toEqual(['README.md', 'src/a.ts', 'lib/y.ts', 'src/b/z.rs']);
		expect(order('countAscending')).toEqual(['src/b/z.rs', 'lib/y.ts', 'src/a.ts', 'README.md']);
	});

	test('search.collapseResults', () => {
		expect(startsCollapsed('alwaysExpand', 50)).toBe(false);
		expect(startsCollapsed('alwaysCollapse', 1)).toBe(true);
		expect(startsCollapsed('auto', 10)).toBe(false);
		expect(startsCollapsed('auto', 11)).toBe(true);
	});

	test('search.defaultViewMode tree: folders, then their files', () => {
		const rows = flattenResults(sortResults(files, 'default'), new Set([folderKey('src/b'), 'src/a.ts']), 'tree');
		expect(rows.map((r) => (r.kind === 'folder' ? `${r.depth}:${r.path}/` : r.kind === 'file' ? `${r.depth}:${r.file.path}` : `${r.depth}:m`))).toEqual([
			'0:lib/',
			'1:lib/y.ts',
			'2:m',
			'2:m',
			'0:src/',
			'1:src/b/',
			'1:src/a.ts',
			'0:README.md',
			...Array(5).fill('1:m')
		]);
	});

	test('search.quickOpen.includeHistory / history.filterSortOrder', () => {
		const all = ['src/main.ts', 'src/maintain.ts', 'docs/main.md'];
		const history = ['docs/main.md', 'src/main.ts'];
		expect(rankFiles('main', all, history).filter((r) => r.recent).map((r) => r.path)).toEqual(['src/main.ts', 'docs/main.md']);
		expect(rankFiles('main', all, history, 60, { sortOrder: 'recency' }).filter((r) => r.recent).map((r) => r.path)).toEqual(['docs/main.md', 'src/main.ts']);
		expect(rankFiles('main', all, history, 60, { includeHistory: false }).some((r) => r.recent)).toBe(false);
		expect(rankFiles('', all, history, 60, { includeHistory: false })).toEqual([]);
	});
});
