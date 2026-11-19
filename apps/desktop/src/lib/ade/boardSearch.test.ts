import { expect, test } from 'bun:test';
import { boardMatches, splitIdle } from './boardSearch.ts';

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
