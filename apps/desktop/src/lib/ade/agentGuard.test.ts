import { describe, expect, test } from 'bun:test';
import { mayPruneSessions, tabsOfTask, touchedTasks, workingTask } from './agentGuard';

const worktrees = [
	{ slug: 'a', branch: 'kingu/a' },
	{ slug: 'b', branch: 'release' },
	{ slug: null, branch: 'main' }
];

describe('agent guard', () => {
	test('a task and the task holding the target branch are touched', () => {
		expect(touchedTasks('a', 'release', worktrees)).toEqual(['a', 'b']);
		expect(touchedTasks('a', 'main', worktrees)).toEqual(['a']);
		expect(touchedTasks(null, 'kingu/a', worktrees)).toEqual(['a']);
		expect(touchedTasks('a', 'kingu/a', worktrees)).toEqual(['a']);
	});

	test('a removed task takes its page, diffs and worktree files', () => {
		const diff = (p: string) => (p.startsWith('taskdiff://') ? p.slice(11).split('/')[0] : null);
		const tabs = ['task://a', 'task://ab', 'taskdiff://a/x.ts', 'taskdiff://b/x.ts', '.kingu/worktrees/a/src/x.ts', '.kingu/worktrees/a/src/x.ts', '.kingu/worktrees/ab/y.ts', 'src/x.ts'];
		expect(tabsOfTask(tabs, 'a', diff)).toEqual(['task://a', 'taskdiff://a/x.ts', '.kingu/worktrees/a/src/x.ts']);
	});

	test('sessions of missing tasks end only after a successful load of this folder', () => {
		expect(mayPruneSessions({ loaded: true, loadedRoot: '/a', root: '/a' })).toBe(true);
		// A failed tasks_load: loaded, but nothing was read.
		expect(mayPruneSessions({ loaded: true, loadedRoot: null, root: '/a' })).toBe(false);
		// The list is still the previous folder's.
		expect(mayPruneSessions({ loaded: true, loadedRoot: '/a', root: '/b' })).toBe(false);
		expect(mayPruneSessions({ loaded: false, loadedRoot: '/a', root: '/a' })).toBe(false);
		expect(mayPruneSessions({ loaded: true, loadedRoot: null, root: null })).toBe(false);
	});

	test('the first working one is reported', () => {
		expect(workingTask(['a', 'b'], (s) => s === 'b')).toBe('b');
		expect(workingTask(['a'], () => false)).toBeNull();
	});
});
