import { describe, expect, test } from 'bun:test';
import { touchedTasks, workingTask } from './agentGuard';

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

	test('the first working one is reported', () => {
		expect(workingTask(['a', 'b'], (s) => s === 'b')).toBe('b');
		expect(workingTask(['a'], () => false)).toBeNull();
	});
});
