import { describe, expect, test } from 'bun:test';
import { attemptLetter, attemptSlugs, compareColumns, isStackedBase, losersOf, nestTasks, resizeModels, validModel, withModel } from './attempts';
import { newTask, type DiffStat, type TaskView } from './model';

describe('best-of-N attempts', () => {
	test('slugs share a group base none of whose attempts is taken', () => {
		expect(attemptSlugs('Fix the login page', 3, new Set())).toEqual({ group: 'fix-the-login-page', slugs: ['fix-the-login-page-a', 'fix-the-login-page-b', 'fix-the-login-page-c'] });
		expect(attemptSlugs('Fix login', 2, new Set(['fix-login-b']))).toEqual({ group: 'fix-login-2', slugs: ['fix-login-2-a', 'fix-login-2-b'] });
		expect(attemptSlugs('Fix login', 2, new Set(['fix-login'])).group).toBe('fix-login-2');
		expect(attemptSlugs('x', 9, new Set()).slugs).toHaveLength(4);
		const long = attemptSlugs('a'.repeat(80), 4, new Set(['a'.repeat(46) + '-a']));
		expect(long.slugs.every((s) => s.length <= 48 && /^[a-z0-9-]+$/.test(s) && !s.includes('--'))).toBe(true);
	});

	test('an attempt letter comes from a slug of its group only', () => {
		expect(attemptLetter({ slug: 'fix-login-b', group: 'fix-login' })).toBe('B');
		expect(attemptLetter({ slug: 'fix-login-b', group: null })).toBeNull();
		expect(attemptLetter({ slug: 'other-b', group: 'fix-login' })).toBeNull();
	});

	test('models are plain argument words and replace the CLI flag', () => {
		expect(['opus', 'gpt-5.1-codex', 'anthropic/claude-sonnet-4', 'm@1'].every(validModel)).toBe(true);
		expect(['', '--yolo', 'a b', 'x;rm', 'x'.repeat(129)].some(validModel)).toBe(false);
		expect(withModel(['claude'], 'opus')).toEqual(['claude', '--model', 'opus']);
		expect(withModel(['codex', '-m', 'o3', '--full-auto'], 'gpt-5')).toEqual(['codex', '-m', 'gpt-5', '--full-auto']);
		expect(withModel(['claude', '--model=sonnet'], 'opus')).toEqual(['claude', '--model=opus']);
		expect(withModel(['claude'], '')).toEqual(['claude']);
		expect(resizeModels(['opus', 'sonnet'], 3)).toEqual(['opus', 'sonnet', '']);
		expect(resizeModels(['opus', 'sonnet'], 1)).toEqual(['opus']);
	});

	const stat = (files: [string, number, number][]): DiffStat => ({
		base: 'main',
		merge_base: 'm',
		head: 'h',
		ahead: 1,
		behind: 0,
		dirty: false,
		files: files.map(([path, added, deleted]) => ({ path, orig_path: null, status: 'M', added, deleted }))
	});
	const view = (slug: string, group: string | undefined, files?: [string, number, number][], model?: string): TaskView => {
		const meta = newTask({ slug, title: slug, prompt: 'p', base: 'main', group, model }, 1);
		return { meta, status: 'review', stat: files ? stat(files) : undefined };
	};

	test('compare columns: the group A first, totals, biggest files first and what only it changed', () => {
		const views = [view('x-b', 'x', [['a.ts', 1, 0], ['b.ts', 10, 2]], 'sonnet'), view('other', undefined, []), view('x-a', 'x', [['a.ts', 3, 3]], 'opus'), view('x-c', 'x')];
		const cols = compareColumns(views, 'x');
		expect(cols.map((c) => [c.letter, c.model])).toEqual([
			['A', 'opus'],
			['B', 'sonnet'],
			['C', null]
		]);
		expect(cols[1].totals).toEqual({ files: 2, added: 11, deleted: 2, binary: 0 });
		expect(cols[1].files.map((f) => f.path)).toEqual(['b.ts', 'a.ts']);
		expect(cols.map((c) => c.only)).toEqual([0, 1, 0]);
		expect(cols[2].totals).toBeNull();
	});

	test('Pick winner offers the rest of its group', () => {
		const list = [{ slug: 'x-a', group: 'x' }, { slug: 'x-b', group: 'x' }, { slug: 'y', group: null }, { slug: 'x-c', group: 'x' }];
		expect(losersOf(list, 'x-b')).toEqual(['x-a', 'x-c']);
		expect(losersOf(list, 'y')).toEqual([]);
	});
});

describe('side bar order', () => {
	const ids = (list: { slug: string; parent?: string | null; group?: string | null }[]) => nestTasks(list).map((n) => `${'>'.repeat(n.depth)}${n.item.slug}`);

	test('stacked tasks follow their parent, a level deeper', () => {
		expect(ids([{ slug: 'child', parent: 'base' }, { slug: 'other' }, { slug: 'base' }, { slug: 'grand', parent: 'child' }])).toEqual(['other', 'base', '>child', '>>grand']);
	});

	test('attempts sit together where the first of them sorted, A first', () => {
		expect(ids([{ slug: 'x-c', group: 'x' }, { slug: 'y' }, { slug: 'x-a', group: 'x' }, { slug: 'x-b', group: 'x' }])).toEqual(['x-a', 'x-b', 'x-c', 'y']);
	});

	test('a missing parent or a cycle never hides a task', () => {
		expect(ids([{ slug: 'a', parent: 'gone' }, { slug: 'b' }])).toEqual(['a', 'b']);
		expect(ids([{ slug: 'a', parent: 'b' }, { slug: 'b', parent: 'a' }, { slug: 'self', parent: 'self' }])).toEqual(['self', 'a', '>b']);
	});

	test('a PR into the parent branch is a stacked one', () => {
		const branchOf = (s: string) => (s === 'base' ? 'kingu/base-renamed' : null);
		expect(isStackedBase({ parent: 'base', base: 'kingu/base' }, 'kingu/base', branchOf)).toBe(true);
		expect(isStackedBase({ parent: 'base', base: 'kingu/base' }, 'kingu/base-renamed', branchOf)).toBe(true);
		expect(isStackedBase({ parent: 'base', base: 'kingu/base' }, 'main', branchOf)).toBe(false);
		expect(isStackedBase({ parent: null, base: 'main' }, 'main', branchOf)).toBe(false);
	});
});
