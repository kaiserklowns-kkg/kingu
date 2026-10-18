import { describe, expect, test } from 'bun:test';
import { COLORS, fileDecorations } from '#lib/workbench/scm.ts';
import type { FileMatches } from '#lib/workbench/searchResults.ts';
import { portOwner, cleanTabs, SAVED_TABS_MAX, contentRows, contentSummary, filesOf, fold, isRightTab, nameMatches, RIGHT_TABS, rowLook, toggleTab, touchesWorktree, treeRows, visibleTabs, shellJoin, sortSessions } from './rightSidebar.ts';

describe('Agents tab', () => {
	const v = (slug: string, created_at: number, updated_at: number) => ({ meta: { slug, created_at, updated_at } });

	test('sessions newest first by update or creation', () => {
		const views = [v('a', 1, 5), v('b', 3, 4), v('c', 2, 9)];
		expect(sortSessions(views, 'updated').map((x) => x.meta.slug)).toEqual(['c', 'a', 'b']);
		expect(sortSessions(views, 'created').map((x) => x.meta.slug)).toEqual(['b', 'c', 'a']);
	});

	test('resume command quoted for a shell', () => {
		expect(shellJoin(['claude', '--resume', 'abc-123'])).toBe('claude --resume abc-123');
		expect(shellJoin(['env', 'A=b c', "it's"])).toBe(`env 'A=b c' 'it'\\''s'`);
	});
});

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
		expect(RIGHT_TABS.map((t) => t.id)).toEqual(['files', 'agents', 'changes', 'checks', 'ports', 'review']);
		expect(isRightTab('checks')).toBe(true);
		expect(isRightTab('nope')).toBe(false);
	});

	test('Source Control and Checks only in a git repository', () => {
		expect(visibleTabs(false, 'changes')).toEqual({ tabs: RIGHT_TABS.filter((t) => ['files', 'agents', 'ports'].includes(t.id)), active: 'files' });
		expect(visibleTabs(true, 'checks').active).toBe('checks');
		expect(visibleTabs(false, 'agents').active).toBe('agents');
	});

	test('Review only for a task', () => {
		expect(visibleTabs(true, 'review').active).toBe('files');
		expect(visibleTabs(true, 'review', true).active).toBe('review');
		expect(visibleTabs(true, 'files', true).tabs.map((t) => t.id)).toEqual(['files', 'agents', 'changes', 'checks', 'ports', 'review']);
	});

	test('a tab shortcut shows the tab, pressed again on it hides the side bar', () => {
		expect(toggleTab({ visible: false, tab: 'files' }, 'files')).toEqual({ visible: true, tab: 'files' });
		expect(toggleTab({ visible: true, tab: 'files' }, 'changes')).toEqual({ visible: true, tab: 'changes' });
		expect(toggleTab({ visible: true, tab: 'changes' }, 'changes')).toEqual({ visible: false, tab: 'changes' });
	});
});

describe('Names filter', () => {
	const files = ['src/lib/App.svelte', 'src/lib/app.ts', 'src/main.ts', 'README.md', 'docs/คู่มือ.md', 'docs/อ่านก่อน.txt'];

	test('matches paths case-insensitively, with their folders as context', () => {
		const { rows, total } = nameMatches(files, 'APP');
		expect(total).toBe(2);
		expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.name}${r.is_dir ? '/' : ''}`)).toEqual(['src/', '  lib/', '    App.svelte', '    app.ts']);
	});

	test('every space-separated part must be in the path (Orca: substring, not fuzzy)', () => {
		expect(nameMatches(files, 'lib ts').rows.filter((r) => !r.is_dir).map((r) => r.rel)).toEqual(['src/lib/app.ts']);
		expect(nameMatches(files, 'src').total).toBe(3);
		expect(nameMatches(files, 'apts').total).toBe(0);
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
		expect(rowLook('docs', false, decos, new Set(), true)).toEqual({ ignored: false, deco: { letter: 'U', color: COLORS.added } });
	});

	test('untracked is green U, folders get the colour only', () => {
		expect(rowLook('docs/new.md', false, decos)).toEqual({ ignored: false, deco: { letter: 'U', color: '#73C991' } });
		expect(rowLook('docs', false, decos)).toEqual({ ignored: false, deco: { letter: '', color: '#73C991' } });
		expect(rowLook('README.md', false, decos)).toEqual({ ignored: false, deco: undefined });
	});
});

test('saved tabs are read back safely', () => {
	expect(cleanTabs(null)).toEqual({});
	expect(cleanTabs(['files'])).toEqual({});
	expect(cleanTabs({ a: 'checks', b: 'bogus', '': 'agents' })).toEqual({ a: 'checks', '': 'agents' });
	const many = Object.fromEntries(Array.from({ length: SAVED_TABS_MAX + 5 }, (_, i) => [`w${i}`, 'files']));
	const kept = Object.keys(cleanTabs(many));
	expect(kept.length).toBe(SAVED_TABS_MAX);
	expect(kept[0]).toBe('w5');
});

test('ports belong to the worktree their process runs in', () => {
	const root = '/Users/me/app';
	expect(portOwner('/Users/me/app/.kingu/worktrees/fix-login/web', root)).toBe('fix-login');
	expect(portOwner('/Users/me/app/.kingu/worktrees/fix-login', root)).toBe('fix-login');
	expect(portOwner('/Users/me/app/packages/web', root)).toBe('');
	expect(portOwner('/Users/me/app/', root)).toBe('');
	expect(portOwner('/Users/me/app/.kingu', root)).toBeNull();
	expect(portOwner('/Users/me/application', root)).toBeNull();
	expect(portOwner('/', root)).toBeNull();
	expect(portOwner(null, root)).toBeNull();
	expect(portOwner('/Users/me/app', null)).toBeNull();
});
