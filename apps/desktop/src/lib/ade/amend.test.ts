import { describe, expect, test } from 'bun:test';
import { amendBlock, amendPlan } from './amend.ts';

const ready = { busy: false, head: 'abc1234', detached: false, operation: null, conflicts: 0, staged: 1, message: '' };

describe('amendBlock', () => {
	test('runs with a staged change or a typed message', () => {
		expect(amendBlock(ready)).toBeNull();
		expect(amendBlock({ ...ready, staged: 0, message: 'reword' })).toBeNull();
	});

	test('is off when the amended commit would be the same commit', () => {
		expect(amendBlock({ ...ready, staged: 0 })).toBe('nothing');
		expect(amendBlock({ ...ready, staged: 0, message: '  \n' })).toBe('nothing');
	});

	test('is off before the first commit, while busy, on conflicts, mid-operation and detached', () => {
		expect(amendBlock({ ...ready, head: null })).toBe('noCommit');
		expect(amendBlock({ ...ready, busy: true })).toBe('busy');
		expect(amendBlock({ ...ready, conflicts: 2 })).toBe('conflicts');
		expect(amendBlock({ ...ready, operation: 'rebase' })).toBe('operation');
		expect(amendBlock({ ...ready, detached: true })).toBe('detached');
	});
});

describe('amendPlan', () => {
	const local = { message: 'fix: last\n', pushed: [] };

	test('keeps the last message when the box is empty, takes the typed one otherwise', () => {
		expect(amendPlan(local, { message: '', staged: 1, upstream: null })).toEqual({ kind: 'amend', message: 'fix: last', confirm: [], forcePush: false });
		expect(amendPlan(local, { message: ' fix: better ', staged: 0, upstream: 'origin/feat' })).toEqual({ kind: 'amend', message: 'fix: better', confirm: [], forcePush: false });
	});

	test('nothing staged and the same message rewrites nothing', () => {
		expect(amendPlan(local, { message: 'fix: last', staged: 0, upstream: null })).toEqual({ kind: 'unchanged' });
		expect(amendPlan(local, { message: '', staged: 0, upstream: null })).toEqual({ kind: 'unchanged' });
	});

	test('a commit already on the upstream needs the confirmation, then a force push', () => {
		const pushed = { message: 'fix: last', pushed: ['origin/feat'] };
		expect(amendPlan(pushed, { message: '', staged: 1, upstream: 'origin/feat' })).toEqual({ kind: 'amend', message: 'fix: last', confirm: ['origin/feat'], forcePush: true });
	});

	test('a commit only on another remote branch needs the confirmation, with no force push to offer', () => {
		// A task branch with no commit of its own yet: HEAD is the base commit, on origin/main.
		const base = { message: 'chore: base', pushed: ['origin/main'] };
		expect(amendPlan(base, { message: 'mine', staged: 0, upstream: null })).toEqual({ kind: 'amend', message: 'mine', confirm: ['origin/main'], forcePush: false });
		expect(amendPlan(base, { message: 'mine', staged: 0, upstream: 'origin/feat' })).toEqual({ kind: 'amend', message: 'mine', confirm: ['origin/main'], forcePush: false });
	});
});
