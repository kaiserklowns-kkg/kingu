import { describe, expect, test } from 'bun:test';
import { jumpItems, worktreeActions, JUMP_CREATE, JUMP_FOLDER, type JumpTask } from './worktreeActions';

const ids = (rows: ReturnType<typeof worktreeActions>) => rows.map((r) => (r === 'separator' ? '-' : r.id));

describe('worktree actions', () => {
	test('the folder itself has no task actions', () => {
		expect(ids(worktreeActions({ slug: null }))).toEqual(['open', 'openInEditor', 'newTerminal', 'quickOpen', '-', 'reveal', 'copyPath']);
	});
	test('a task can be closed and removed, but not while its agent works', () => {
		const rows = worktreeActions({ slug: 'fix', status: 'review', running: true });
		expect(ids(rows).slice(-12)).toEqual(['copyBranch', 'rename', 'editDetails', '-', 'markDone', 'moveStatus', 'continueSession', 'handOff', '-', 'newFromTask', '-', 'remove']);
		const blocked = rows.filter((r) => r !== 'separator' && (r.id === 'markDone' || r.id === 'remove'));
		expect(blocked.map((r) => r !== 'separator' && r.enabled)).toEqual([false, false]);
	});
	test('sessions can be continued or handed off once the task has one and its agent is idle', () => {
		const enabled = (w: Parameters<typeof worktreeActions>[0]) =>
			worktreeActions(w)
				.filter((r) => r !== 'separator' && (r.id === 'continueSession' || r.id === 'handOff' || r.id === 'moveStatus'))
				.map((r) => r !== 'separator' && r.enabled !== false);
		expect(enabled({ slug: 'fix', status: 'review', sessions: 2 })).toEqual([true, true, true]);
		expect(enabled({ slug: 'fix', status: 'review', sessions: 0 })).toEqual([true, false, false]);
		expect(enabled({ slug: 'fix', status: 'running', sessions: 2, running: true })).toEqual([true, false, false]);
	});
	test('a task opens in a new IDE agent chat once it has a worktree (AI-SURFACES §9)', () => {
		const chat = (w: Parameters<typeof worktreeActions>[0]) => worktreeActions(w).find((r) => r !== 'separator' && r.id === 'openInChat');
		expect(chat({ slug: null })).toBeUndefined();
		expect(chat({ slug: 'fix' })).toMatchObject({ enabled: true });
		expect(chat({ slug: 'gone', hasWorktree: false })).toMatchObject({ enabled: false });
	});
	test('a claude session continues in agent chat only while the task agent is stopped', () => {
		const cont = (w: Parameters<typeof worktreeActions>[0]) => worktreeActions(w).find((r) => r !== 'separator' && r.id === 'continueInChat');
		expect(cont({ slug: null })).toBeUndefined();
		expect(cont({ slug: 'fix', chatSessions: 1 })).toMatchObject({ enabled: true });
		expect(cont({ slug: 'fix', chatSessions: 0 })).toMatchObject({ enabled: false });
		expect(cont({ slug: 'fix', chatSessions: 1, running: true })).toMatchObject({ enabled: false });
		expect(cont({ slug: 'fix', chatSessions: 1, hasWorktree: false })).toMatchObject({ enabled: false });
	});
	test('any task can have a task stacked on it; only an attempt compares', () => {
		expect(ids(worktreeActions({ slug: 'fix', status: 'review' }))).not.toContain('compareAttempts');
		expect(ids(worktreeActions({ slug: 'fix-a', status: 'review', attempts: true })).slice(-4)).toEqual(['newFromTask', 'compareAttempts', '-', 'remove']);
		const orphan = worktreeActions({ slug: 'gone', hasWorktree: false }).find((r) => r !== 'separator' && r.id === 'newFromTask');
		expect(orphan !== 'separator' && orphan?.enabled).toBe(false);
	});
	test('a done task offers to reopen', () => {
		expect(ids(worktreeActions({ slug: 'fix', status: 'done' }))).toContain('reopen');
	});
});

describe('jump palette (Orca worktree-jump)', () => {
	const L = { needsYou: 'Needs you', recent: 'Recent', folder: 'Folder', matches: 'Worktrees', create: (q: string) => `Create "${q}"`, createHint: 'new' };
	const task = (slug: string, status: JumpTask['status'], updated: number, extra: Partial<JumpTask> = {}): JumpTask => ({ slug, title: slug.replace('-', ' '), status, statusLabel: status, branch: `kingu/${slug}`, updated, ...extra });
	const tasks = [task('fix-login', 'review', 5, { pr: 42 }), task('add-tests', 'waiting', 1), task('old-docs', 'done', 2, { seen: 9 })];
	const fuzzy = (q: string, s: string) => (s.toLowerCase().includes(q.toLowerCase()) ? { score: 10 - s.toLowerCase().indexOf(q.toLowerCase()), positions: [] } : null);
	test('nothing typed: needs you, then recent by use, then the folder', () => {
		const items = jumpItems('', { name: 'repo', branch: 'main' }, tasks, fuzzy, L);
		expect(items.map((i) => i.id)).toEqual(['add-tests', 'old-docs', 'fix-login', JUMP_FOLDER]);
		expect(items.map((i) => i.separator)).toEqual(['Needs you', 'Recent', undefined, 'Folder']);
	});
	test('PR numbers, title then branch matches, and a create row last', () => {
		expect(jumpItems('#42', { name: 'repo', branch: 'main' }, tasks, fuzzy, L)[0].id).toBe('fix-login');
		const items = jumpItems('docs', { name: 'repo', branch: 'main' }, tasks, fuzzy, L);
		expect(items.map((i) => i.id)).toEqual(['old-docs', `${JUMP_CREATE}docs`]);
		expect(items.at(-1)?.label).toBe('Create "docs"');
		expect(jumpItems('zzz', { name: 'repo', branch: 'main' }, tasks, fuzzy, L).map((i) => i.id)).toEqual([`${JUMP_CREATE}zzz`]);
	});
});
