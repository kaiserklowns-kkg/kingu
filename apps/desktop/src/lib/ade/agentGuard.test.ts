import { describe, expect, test } from 'bun:test';
import { tabsOfTask, touchedTasks, workingTask } from './agentGuard';

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

	test('the first working one is reported', () => {
		expect(workingTask(['a', 'b'], (s) => s === 'b')).toBe('b');
		expect(workingTask(['a'], () => false)).toBeNull();
	});
});
