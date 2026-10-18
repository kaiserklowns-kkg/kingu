import { describe, expect, test } from 'bun:test';
import { fileDecorations } from '#lib/workbench/scm.ts';
import type { FileMatches } from '#lib/workbench/searchResults.ts';
import { contentRows, contentSummary, filesOf, fold, isRightTab, nameMatches, RIGHT_TABS, rowLook, toggleTab, touchesWorktree, treeRows } from './rightSidebar.ts';

describe('watcher batches per worktree', () => {
	test('task worktree: its files and its git metadata', () => {
		expect(touchesWorktree(['.kingu/worktrees/fix/src/a.ts'], 'fix')).toBe(true);
		expect(touchesWorktree(['.git/worktrees/fix/index'], 'fix')).toBe(true);
		expect(touchesWorktree(['.kingu/worktrees/other/a.ts', 'src/a.ts'], 'fix')).toBe(false);
		expect(touchesWorktree([''], 'fix')).toBe(true);
	});

	test('the folder itself ignores task worktrees', () => {
		expect(touchesWorktree(['.kingu/worktrees/fix/a.ts', '.git/worktrees/fix/index'], '')).toBe(false);
		expect(touchesWorktree(['.git/index'], '')).toBe(true);
		expect(filesOf(['.git/index', 'src/a.ts', '.kingu/worktrees/x/a'], '')).toEqual(['src/a.ts']);
		expect(filesOf(['.kingu/worktrees/x/a', '.kingu/worktrees/xy/a', 'b'], 'x')).toEqual(['.kingu/worktrees/x/a']);
	});
});

describe('tabs', () => {
	test('Orca order and ids', () => {
		expect(RIGHT_TABS.map((t) => t.id)).toEqual(['files', 'search', 'changes', 'checks']);
		expect(isRightTab('checks')).toBe(true);
		expect(isRightTab('nope')).toBe(false);
	});

	test('a tab shortcut shows the tab, pressed again on it hides the side bar', () => {
		expect(toggleTab({ visible: false, tab: 'files' }, 'files')).toEqual({ visible: true, tab: 'files' });
		expect(toggleTab({ visible: true, tab: 'files' }, 'changes')).toEqual({ visible: true, tab: 'changes' });
		expect(toggleTab({ visible: true, tab: 'changes' }, 'changes')).toEqual({ visible: false, tab: 'changes' });
	});
});

describe('Names filter', () => {
	const files = ['src/lib/App.svelte', 'src/lib/app.ts', 'src/main.ts', 'README.md', 'docs/คู่มือ.md', 'docs/อ่านก่อน.txt'];

	test('matches file names case-insensitively, with their folders as context', () => {
		const { rows, total } = nameMatches(files, 'APP');
		expect(total).toBe(2);
		expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.name}${r.is_dir ? '/' : ''}`)).toEqual(['src/', '  lib/', '    App.svelte', '    app.ts']);
	});

	test('only the name matches, not the folder path', () => {
		expect(nameMatches(files, 'lib').total).toBe(0);
	});

	test('Thai names, also when typed decomposed', () => {
		expect(nameMatches(files, 'คู่มือ').rows.map((r) => r.rel)).toEqual(['docs', 'docs/คู่มือ.md']);
		const nfd = 'คู่มือ'.normalize('NFD');
		expect(nameMatches(files, nfd).total).toBe(1);
		expect(fold('ÉCOLE')).toBe('école');
	});

	test('empty query and limit', () => {
		expect(nameMatches(files, '  ')).toEqual({ rows: [], total: 0 });
		const r = nameMatches(files, '.', 2);
		expect(r.total).toBe(6);
		expect(r.rows.filter((x) => !x.is_dir)).toHaveLength(2);
	});

	test('tree rows: folders first, then files, by name', () => {
		expect(treeRows(['b.txt', 'a/z.ts', 'A.md', 'a/b/c.ts']).map((r) => r.rel)).toEqual(['a', 'a/b', 'a/b/c.ts', 'a/z.ts', 'A.md', 'b.txt']);
	});
});

describe('Contents results', () => {
	const m = (line: number) => ({ line, column: 1, end_column: 3, preview: 'ab', preview_start: 0, preview_end: 2, text: 'ab' });
	const files: FileMatches[] = [
		{ path: 'src/a.ts', matches: [m(1), m(4)] },
		{ path: 'b.md', matches: [m(2)] }
	];

	test('file rows with counts, then matches, unless collapsed', () => {
		const rows = contentRows(files, new Set(['b.md']));
		expect(rows.map((r) => (r.kind === 'file' ? `${r.name}|${r.dir}|${r.count}|${r.collapsed}` : `  ${r.match.line}`))).toEqual(['a.ts|src|2|false', '  1', '  4', 'b.md||1|true']);
	});

	test('summary', () => {
		expect(contentSummary(files, false)).toBe('3 ผลใน 2 ไฟล์');
		expect(contentSummary(files, true)).toContain('แสดงเฉพาะส่วนแรก');
		expect(contentSummary([], false)).toBe('ไม่พบ');
	});
});

describe('row look', () => {
	const decos = fileDecorations([
		{ path: 'docs/new.md', code: '?' },
		{ path: 'src/a.ts', code: 'M' }
	]);

	test('ignored wins over git; ignored folders make their children ignored', () => {
		expect(rowLook('target', true, decos)).toEqual({ ignored: true });
		expect(rowLook('target/debug/x', false, decos, new Set(['target']))).toEqual({ ignored: true });
	});

	test('untracked is green U, folders get the colour only', () => {
		expect(rowLook('docs/new.md', false, decos)).toEqual({ ignored: false, deco: { letter: 'U', color: '#73C991' } });
		expect(rowLook('docs', false, decos)).toEqual({ ignored: false, deco: { letter: '', color: '#73C991' } });
		expect(rowLook('README.md', false, decos)).toEqual({ ignored: false, deco: undefined });
	});
});
