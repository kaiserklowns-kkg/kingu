import { describe, expect, test } from 'bun:test';
import { resolveSettings } from '#lib/settings/registry.ts';
import { cardProperties, externalKind, externalWorktrees, hiddenBy, prGroupOf, sidebarGroups, sidebarTint, sortTasks, switcherOrder, type SidebarPrefs, type SidebarTask } from './sidebarView';
import { MAX_OPEN_IN, openInLabels, worktreeActions } from './worktreeActions';

const task = (slug: string, o: Partial<SidebarTask> = {}): SidebarTask => ({ slug, title: slug, status: 'review', updatedAt: 0, live: false, detached: false, prState: null, ...o });
const prefs = (o: Partial<SidebarPrefs> = {}): SidebarPrefs => ({ groupBy: 'none', sortBy: 'smart', showActiveOnly: false, hideAutomation: false, hideSleeping: false, hideDetached: false, ...o });

describe('ADE side bar (Orca sidebar preferences)', () => {
	test("Orca's defaults", () => {
		const m = resolveSettings({}, {});
		expect([
			m.get('kingu.sidebar.groupBy')?.value,
			m.get('kingu.sidebar.sortBy')?.value,
			m.get('kingu.sidebar.showActiveOnly')?.value,
			m.get('kingu.board.columnWidth')?.value,
			m.get('kingu.board.opacity')?.value,
			m.get('kingu.worktree.externalVisibility')?.value,
			m.get('kingu.tabs.ctrlTabOrder')?.value
		]).toEqual(['repo', 'recent', false, 308, 1, 'hide', 'mru']);
		expect(resolveSettings({ 'kingu.board.columnWidth': 50 }, {}).get('kingu.board.columnWidth')?.source).toBe('default');
	});

	test('filters', () => {
		expect(hiddenBy(task('a', { status: 'review' }), prefs({ showActiveOnly: true }))).toBe(true);
		expect(hiddenBy(task('a', { status: 'running' }), prefs({ showActiveOnly: true }))).toBe(false);
		expect(hiddenBy(task('a', { origin: 'automation' }), prefs({ hideAutomation: true }))).toBe(true);
		expect(hiddenBy(task('a'), prefs({ hideSleeping: true }))).toBe(true);
		expect(hiddenBy(task('a', { live: true }), prefs({ hideSleeping: true }))).toBe(false);
		expect(hiddenBy(task('a', { detached: true }), prefs({ hideDetached: true }))).toBe(true);
		expect(hiddenBy(task('a'), prefs())).toBe(false);
	});

	test('sort and group', () => {
		const list = [task('b', { status: 'done', updatedAt: 9 }), task('a', { status: 'running', updatedAt: 1 }), task('c', { status: 'waiting', updatedAt: 2 })];
		expect(sortTasks(list, 'smart').map((t) => t.slug)).toEqual(['c', 'a', 'b']);
		expect(sortTasks(list, 'recent').map((t) => t.slug)).toEqual(['b', 'c', 'a']);
		expect(sortTasks(list, 'name').map((t) => t.slug)).toEqual(['a', 'b', 'c']);
		expect(sidebarGroups(list, prefs({ groupBy: 'workspace-status' })).map((g) => [g.id, g.tasks.map((t) => t.slug)])).toEqual([
			['attention', ['c']],
			['active', ['a']],
			['done', ['b']]
		]);
		expect(prGroupOf({ prState: 'OPEN', prDraft: true })).toBe('draft');
		expect(prGroupOf({ prState: null })).toBe('none');
		expect(sidebarGroups([task('x', { prState: 'MERGED' })], prefs({ groupBy: 'pr-status' }))[0].id).toBe('merged');
		// One project: `repo` lists like `none`; `manual` (the dragged order) sorts like `recent` here.
		expect(sidebarGroups([task('x')], prefs({ groupBy: 'repo' })).map((g) => g.id)).toEqual(['all']);
		expect(sidebarGroups([], prefs())).toEqual([]);
	});

	test('card properties', () => {
		expect([...cardProperties(['branch', 'nope'], false)]).toEqual(['branch']);
		expect([...cardProperties(undefined, false)].length).toBe(8);
		expect([...cardProperties(['branch'], true)]).toEqual(['status']);
	});

	test('external and agent worktrees', () => {
		const list = [
			{ path: '/r', branch: 'main', slug: null, bare: false, detached: false, prunable: false },
			{ path: '/r/.kingu/worktrees/t', branch: 'kingu/t', slug: 't', bare: false, detached: false, prunable: false },
			{ path: '/r/.claude/worktrees/x', branch: 'x', slug: null, bare: false, detached: false, prunable: false },
			{ path: '/other/y', branch: 'y', slug: null, bare: false, detached: false, prunable: false },
			{ path: '/gone', branch: 'g', slug: null, bare: false, detached: false, prunable: true }
		];
		expect(externalKind('/r/.claude/worktrees/x')).toBe('agent');
		expect(externalWorktrees(list, '/r', { external: 'hide', agent: 'hide' })).toEqual([]);
		expect(externalWorktrees(list, '/r', { external: 'show', agent: 'hide' }).map((w) => w.path)).toEqual(['/other/y']);
		expect(externalWorktrees(list, '/r', { external: 'hide', agent: 'show' }).map((w) => w.path)).toEqual(['/r/.claude/worktrees/x']);
		expect(externalWorktrees(list, '/r/', { external: 'hide', agent: 'hide', custom: ['/other/'] }).map((w) => w.path)).toEqual(['/other/y']);
	});

	test('appearance and Ctrl+Tab order', () => {
		expect(sidebarTint('default', '#fff', 0.1)).toBeNull();
		expect(sidebarTint('tinted', '#ff0000', 0.9)?.backgroundImage).toContain('#ff0000 35%');
		expect(sidebarTint('tinted', 'nope', undefined)?.backgroundImage).toContain('#18181b 8%');
		expect(sidebarTint('match-terminal', '', 0)?.backgroundColor).toContain('--vscode-terminal-background');
		expect(switcherOrder('mru', ['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
		expect(switcherOrder('sequential', ['b', 'a', 'c'], ['a', 'b', 'c'])).toEqual(['b', 'c', 'a']);
	});

	test('Open In apps', () => {
		expect(openInLabels({ Cursor: 'cursor', Empty: '', Bad: 3 })).toEqual(['Cursor']);
		expect(openInLabels(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`a${i}`, 'x']))).length).toBe(MAX_OPEN_IN);
		const rows = worktreeActions({ slug: 't', openIn: ['Cursor'] }).map((r) => (r === 'separator' ? '-' : r.id));
		expect(rows).toContain('openIn:Cursor');
		expect(resolveSettings({}, { 'kingu.worktree.openIn': { X: 'evil' } }).get('kingu.worktree.openIn')?.source).toBe('default');
	});
});
