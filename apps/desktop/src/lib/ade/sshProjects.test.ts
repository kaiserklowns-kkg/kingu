import { describe, expect, test } from 'bun:test';
import { gitSummary, hostPath, remoteKey, remoteSlug, remoteWorktreePath, sortWorktrees, type RemoteWorktree } from './sshProjects';

const row = (path: string, extra: Partial<RemoteWorktree> = {}): RemoteWorktree => ({
	path,
	head: 'abcdef1234',
	branch: null,
	slug: null,
	bare: false,
	detached: false,
	locked: false,
	prunable: false,
	changes: 0,
	upstream: null,
	ahead: 0,
	behind: 0,
	...extra
});

describe('ssh projects', () => {
	test('the same path on two hosts is two projects', () => {
		expect(remoteKey({ host: 'a', path: '/srv/app' })).not.toBe(remoteKey({ host: 'b', path: '/srv/app' }));
	});

	test('main checkout first, then tasks by slug, then other worktrees', () => {
		const rows = [row('/srv/other'), row('/srv/app/.kingu/worktrees/zed', { slug: 'zed' }), row('/srv/app'), row('/srv/app/.kingu/worktrees/abc', { slug: 'abc' })];
		expect(sortWorktrees(rows, '/srv/app').map((r) => r.path)).toEqual(['/srv/app', '/srv/app/.kingu/worktrees/abc', '/srv/app/.kingu/worktrees/zed', '/srv/other']);
	});

	test('git summary falls back to the short commit when detached', () => {
		expect(gitSummary(row('/x', { branch: 'kingu/a', changes: 3, ahead: 1 }))).toEqual({ branch: 'kingu/a', changes: 3, ahead: 1, behind: 0 });
		expect(gitSummary(row('/x', { detached: true })).branch).toBe('abcdef1');
	});

	test('slugs and worktree paths follow the local rule', () => {
		expect(remoteSlug('Fix the login page!')).toBe('fix-the-login-page');
		expect(remoteWorktreePath('/srv/app/', 'fix')).toBe('/srv/app/.kingu/worktrees/fix');
	});

	test('host paths: ~, ~/x or absolute', () => {
		expect(hostPath(' ~ ')).toBe('~');
		expect(hostPath('~/code/app')).toBe('~/code/app');
		expect(hostPath('/srv/app')).toBe('/srv/app');
		expect(hostPath('code/app')).toBeNull();
		expect(hostPath('/a\nb')).toBeNull();
		expect(hostPath('')).toBeNull();
	});
});
