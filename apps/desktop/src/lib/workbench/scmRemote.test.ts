import { describe, expect, test } from 'bun:test';
import type { GitStatus } from '#lib/workbench/scm.ts';
import {
	AUTH_FAILED,
	CREATE_BRANCH,
	CREATE_BRANCH_FROM,
	branchLabel,
	checkoutItems,
	checkoutTarget,
	cleanBranchName,
	deletableBranches,
	isAuthError,
	stashItems,
	syncItem,
	terminalCommand,
	type BranchRef
} from '#lib/workbench/scmRemote.ts';

const repo = (over: Partial<GitStatus> = {}): GitStatus => ({
	branch: 'main',
	head: 'abc12345',
	upstream: 'origin/main',
	ahead: 0,
	behind: 0,
	detached: false,
	upstream_gone: false,
	remotes: ['origin'],
	entries: [],
	...over
});

const ref = (name: string, over: Partial<BranchRef> = {}): BranchRef => ({
	name,
	remote: name.startsWith('origin/'),
	current: false,
	upstream: null,
	worktree: null,
	commit: 'abc1234',
	subject: 'msg',
	...over
});

describe('syncItem', () => {
	test('shows behind and ahead counts like VS Code', () => {
		expect(syncItem(repo({ ahead: 2, behind: 3 }))).toMatchObject({ label: '↓3 ↑2', command: 'git.sync' });
		expect(syncItem(repo())?.label).toBe('↓0 ↑0');
		expect(syncItem(repo({ ahead: 1 }))?.title).toContain('origin/main');
	});

	test('offers Publish without an upstream or when it is gone, only with a remote', () => {
		expect(syncItem(repo({ upstream: null }))?.command).toBe('git.publish');
		expect(syncItem(repo({ upstream_gone: true }))?.title).toContain('was deleted');
		expect(syncItem(repo({ upstream: null, remotes: [] }))).toBeNull();
	});

	test('nothing when detached or outside a repository', () => {
		expect(syncItem(repo({ branch: null, detached: true }))).toBeNull();
		expect(syncItem(null)).toBeNull();
	});
});

test('branchLabel falls back to the commit when detached', () => {
	expect(branchLabel(repo())).toBe('main');
	expect(branchLabel(repo({ branch: null, detached: true }))).toBe('abc12345');
	expect(branchLabel(null)).toBeNull();
});

describe('checkout items', () => {
	const refs = [
		ref('main', { current: true }),
		ref('dev'),
		ref('kingu/t1', { worktree: '/r/.kingu/worktrees/t1' }),
		ref('origin/main'),
		ref('origin/feature')
	];

	test('create actions, local, remote, then worktree-held branches marked', () => {
		const items = checkoutItems(refs);
		expect(items.map((i) => i.id)).toEqual([CREATE_BRANCH, CREATE_BRANCH_FROM, 'dev', 'origin/feature', 'origin/main', 'worktree:kingu/t1']);
		expect(items.find((i) => i.id === 'dev')?.separator).toBe('branches');
		expect(items.find((i) => i.id === 'origin/feature')?.separator).toBe('remote branches');
		expect(items.at(-1)?.description).toContain('.kingu/worktrees/t1');
		expect(checkoutItems(refs, { create: false })[0].id).toBe('dev');
	});

	test('git.checkoutType, git.branchSortOrder and git.showReferenceDetails', () => {
		const all = [...refs, ref('v1', { tag: true, date: 5 }), ref('old', { date: 1 }), ref('new', { date: 9 })];
		const ids = (o: Parameters<typeof checkoutItems>[1]) => checkoutItems(all, { create: false, ...o }).map((i) => i.id);
		expect(ids({ types: ['tags', 'local'] })).toEqual(['tag:v1', 'dev', 'new', 'old', 'worktree:kingu/t1']);
		expect(ids({ types: ['local'], sort: 'committerdate' })).toEqual(['new', 'old', 'dev', 'worktree:kingu/t1']);
		expect(ids({ types: ['remote'] })).toEqual(['origin/feature', 'origin/main', 'worktree:kingu/t1']);
		expect(checkoutItems(all, { create: false, details: false })[0].description).toBeUndefined();
		expect(checkoutTarget('tag:v1', all)).toMatchObject({ kind: 'ref', ref: { name: 'v1', tag: true } });
		expect(deletableBranches(all).map((i) => i.id)).not.toContain('v1');
	});

	test('targets', () => {
		expect(checkoutTarget(CREATE_BRANCH, refs)).toEqual({ kind: 'create' });
		expect(checkoutTarget('origin/feature', refs)).toMatchObject({ kind: 'ref', ref: { name: 'origin/feature', remote: true } });
		expect(checkoutTarget('worktree:kingu/t1', refs)).toMatchObject({ kind: 'worktree' });
		expect(checkoutTarget('nope', refs)).toBeNull();
	});

	test('delete candidates exclude current, remote and worktree branches', () => {
		expect(deletableBranches(refs).map((i) => i.id)).toEqual(['dev']);
	});
});

test('stash items', () => {
	const items = stashItems([{ index: 1, message: 'wip', branch: 'main', when: '2 hours ago' }]);
	expect(items).toEqual([{ id: '1', label: 'stash@{1}: wip', description: 'main · 2 hours ago' }]);
});

test('auth errors are recognised by the Rust message prefix', () => {
	expect(isAuthError(`${AUTH_FAILED}: ...\nfatal: Authentication failed`)).toBe(true);
	expect(isAuthError('git fetch ไม่สำเร็จ')).toBe(false);
});

test('terminal commands rerun the same git operation', () => {
	expect(terminalCommand('fetch')).toEqual(['git', 'fetch', '--prune']);
	expect(terminalCommand('pull')).toEqual(['git', 'pull', '--no-rebase', '--ff-only']);
	expect(terminalCommand('sync', { rebase: true })).toEqual(['git', 'pull', '--rebase']);
	expect(terminalCommand('publish', { remote: 'origin', branch: 'feat/x' })).toEqual(['git', 'push', '-u', 'origin', 'feat/x']);
	expect(terminalCommand('fetch', { prune: false })).toEqual(['git', 'fetch']);
	expect(terminalCommand('pull', { pull: ['git', 'pull', '--tags', '--rebase'] })).toEqual(['git', 'pull', '--tags', '--rebase']);
});

test('cleanBranchName turns spaces into dashes', () => {
	expect(cleanBranchName('  my new  branch ')).toBe('my-new-branch');
});
