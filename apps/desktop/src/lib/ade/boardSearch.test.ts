import { expect, test } from 'bun:test';
import { boardMatches } from './boardSearch.ts';

const task = { title: 'Fix login on Safari', slug: 'fix-login', agent: 'codex', branch: 'kingu/fix-login' };

test('every word must appear in the title, worktree, branch or agent', () => {
	expect(boardMatches(task, '')).toBe(true);
	expect(boardMatches(task, '  ')).toBe(true);
	expect(boardMatches(task, 'safari')).toBe(true);
	expect(boardMatches(task, 'Codex login')).toBe(true);
	expect(boardMatches(task, 'kingu/fix')).toBe(true);
	expect(boardMatches(task, 'login claude')).toBe(false);
});
