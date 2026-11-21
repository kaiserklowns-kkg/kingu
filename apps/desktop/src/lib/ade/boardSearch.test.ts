import { describe, expect, test } from 'bun:test';
import { boardMatches, inProjects, projectOptions, splitIdle, toggleFilter } from './boardSearch.ts';

const task = { title: 'Fix login on Safari', slug: 'fix-login', agent: 'codex', branch: 'kingu/fix-login' };

test('every word must appear in the title, worktree, branch or agent', () => {
	expect(boardMatches(task, '')).toBe(true);
	expect(boardMatches(task, '  ')).toBe(true);
	expect(boardMatches(task, 'safari')).toBe(true);
	expect(boardMatches(task, 'Codex login')).toBe(true);
	expect(boardMatches(task, 'kingu/fix')).toBe(true);
	expect(boardMatches(task, 'login claude')).toBe(false);
});

test('a finished task stays in Done while unread, then is Idle', () => {
	const v = (slug: string) => ({ meta: { slug } });
	const out = splitIdle([v('a'), v('b'), v('c')], new Set(['b']));
	expect(out.done.map((x) => x.meta.slug)).toEqual(['b']);
	expect(out.idle.map((x) => x.meta.slug)).toEqual(['a', 'c']);
});

describe("Orca's Project filter", () => {
	test('options count each project; none chosen keeps every project', () => {
		const opts = projectOptions(
			[
				{ id: '/a', label: 'a' },
				{ id: '/b', label: 'b' }
			],
			[{ root: '/a' }, { root: '/a' }, { root: '/c' }]
		);
		expect(opts).toEqual([
			{ id: '/a', label: 'a', count: 2 },
			{ id: '/b', label: 'b', count: 0 }
		]);
		expect(inProjects([], '/x')).toBe(true);
		expect(inProjects(['/a'], '/a')).toBe(true);
		expect(inProjects(['/a'], '/b')).toBe(false);
		expect(toggleFilter(['/a'], '/b')).toEqual(['/a', '/b']);
		expect(toggleFilter(['/a', '/b'], '/a')).toEqual(['/b']);
	});

	test('search covers the project name', () => {
		expect(boardMatches({ title: 'Fix login', slug: 'fix-login', project: 'billing-api' }, 'billing')).toBe(true);
		expect(boardMatches({ title: 'Fix login', slug: 'fix-login' }, 'billing')).toBe(false);
	});
});
