import { describe, expect, test } from 'bun:test';
import type { BranchRef } from '#lib/workbench/scmRemote.ts';
import { defaultRemote, defaultWorktreePath, refItems, remoteItems, suggestedRemoteName, summarize, tagItems, worktreeItems, type Worktree } from './gitPicks';

const ref = (name: string, extra: Partial<BranchRef> = {}): BranchRef => ({ name, remote: false, current: false, upstream: null, worktree: null, commit: 'abc1234', subject: 'msg', ...extra });
const labels = { branches: 'B', remotes: 'R', tags: 'T' };

describe('git pickers', () => {
	test('refs grouped as branches, remote branches and tags', () => {
		const refs = [ref('main', { current: true }), ref('dev'), ref('origin/main', { remote: true }), ref('v1', { tag: true })];
		const items = refItems(refs, labels);
		expect(items.map((i) => [i.id, i.separator])).toEqual([
			['dev', 'B'],
			['origin/main', 'R'],
			['v1', 'T']
		]);
		expect(refItems(refs, labels, { skipCurrent: false, tags: false }).map((i) => i.id)).toEqual(['main', 'dev', 'origin/main']);
		expect(items[0].description).toBe('abc1234 msg');
		expect(tagItems(refs).map((i) => i.id)).toEqual(['v1']);
	});

	test('remotes', () => {
		const one = [{ name: 'upstream', fetch_url: 'u', push_url: 'u' }];
		expect(defaultRemote(one)).toBe('upstream');
		expect(defaultRemote([...one, { name: 'origin', fetch_url: 'o', push_url: 'o' }])).toBeUndefined();
		expect(remoteItems(one)).toEqual([{ id: 'upstream', label: 'upstream', description: 'u' }]);
		expect(suggestedRemoteName([])).toBe('origin');
		expect(suggestedRemoteName([{ name: 'origin', fetch_url: '', push_url: '' }])).toBe('');
	});

	test('worktrees: not the main one, not a task, not this window', () => {
		const w = (path: string, extra: Partial<Worktree> = {}): Worktree => ({ path, head: 'abcdef123', branch: null, slug: null, bare: false, detached: false, locked: false, prunable: false, ...extra });
		const list = [w('/repo', { branch: 'main' }), w('/repo/.kingu/worktrees/t', { slug: 't' }), w('/wt/a', { branch: 'a' }), w('/wt/b')];
		expect(worktreeItems(list).map((i) => i.id)).toEqual(['/wt/a', '/wt/b']);
		expect(worktreeItems(list, '/wt/a').map((i) => [i.label, i.description])).toEqual([['b', 'abcdef1 · /wt/b']]);
	});

	test('suggested worktree folder and summaries', () => {
		expect(defaultWorktreePath('/src/app', 'feature/x y')).toBe('/src/app.worktrees/feature-x-y');
		expect(defaultWorktreePath('/src/app/', 'main')).toBe('/src/app.worktrees/main');
		expect(summarize(['a.txt'], (n) => `${n} files`)).toBe('a.txt');
		expect(summarize(['a', 'b'], (n) => `${n} files`)).toBe('2 files');
	});
});
