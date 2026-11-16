import { describe, expect, test } from 'bun:test';
import { conflictKindOf, fixCommitFailurePrompt, fixPushFailurePrompt, isPushHookFailure, promptEntries, resolveConflictsPrompt, summarizeCommitFailure, summarizePushFailure } from './recoveryPrompts';

describe('Orca recovery prompts', () => {
	test('failure summaries', () => {
		expect(summarizeCommitFailure('\x1b[31mhusky - pre-commit hook exited with code 1\x1b[0m')).toBe('Pre-commit hook failed.');
		expect(summarizeCommitFailure('npm notice x\n✖ eslint found 3 problems')).toBe('Lint failed during commit.');
		expect(summarizeCommitFailure('')).toBe('Commit failed.');
		expect(summarizeCommitFailure('fatal: something\nmore')).toBe('fatal: something');
		expect(summarizePushFailure('error: failed to push some refs\nhusky - pre-push hook failed')).toBe('Pre-push hook failed.');
	});
	test('commit fix prompt carries the data and the rules', () => {
		const p = fixCommitFailurePrompt({ error: 'x'.repeat(13_000), entries: [{ path: 'a.ts', status: 'M', area: 'staged' }], worktreePath: '/w', commitMessage: ' feat: x ' });
		expect(p.startsWith('Fix the failed git commit in this worktree')).toBe(true);
		expect(p).toContain('- Commit message the user attempted: "feat: x"');
		expect(p).toContain('- "a.ts" (M, staged)');
		expect(p).toContain('- Do not bypass hooks with --no-verify.');
		expect(p).toContain('[...1000 characters omitted...]');
		expect(p.endsWith('anything left for the user.')).toBe(true);
	});
	test('push prompt lists at most 40 files', () => {
		const entries = Array.from({ length: 45 }, (_, i) => ({ path: `f${i}`, status: 'M', area: 'unstaged' as const }));
		const p = fixPushFailurePrompt({ error: 'pre-push failed', entries, worktreePath: null, branch: 'kingu/x' });
		expect(p).toContain('- Changed files at failure time (45):');
		expect(p).toContain('- ...5 more changed files omitted...');
		expect(p).toContain('- Worktree: "current terminal working directory"');
	});
	test('conflict prompts: files with kinds, or the paused variant', () => {
		const p = resolveConflictsPrompt({ operation: 'rebase', entries: [{ path: 'a', kind: conflictKindOf('UU') }], worktreePath: '/w' });
		expect(p).toContain('- "a" (Both modified)');
		expect(p).toContain('- Skip command: git rebase --skip');
		expect(p).toContain('git show --stat --patch REBASE_HEAD');
		expect(resolveConflictsPrompt({ operation: 'merge', entries: [], worktreePath: '/w' }).startsWith('Finish the paused merge')).toBe(true);
		expect(resolveConflictsPrompt({ operation: 'merge', entries: [{ path: 'b' }], worktreePath: '/w' })).toContain('there is no skip step');
	});
});

describe('push hook detection and entries', () => {
	test('only local hook failures are fixable by the agent', () => {
		expect(isPushHookFailure('husky - pre-push hook exited with code 1\nerror: failed to push some refs')).toBe(true);
		expect(isPushHookFailure('error: failed to push some refs\nhint: Updates were rejected because the remote contains work')).toBe(false);
		expect(isPushHookFailure('fatal: Authentication failed')).toBe(false);
	});
	test('entries by area', () => {
		const st = [
			{ path: 'a', index: 'M', worktree: 'M', conflict: false },
			{ path: 'b', index: null, worktree: '?', conflict: false }
		];
		expect(promptEntries(st, true)).toEqual([{ path: 'a', status: 'M', area: 'staged' }]);
		expect(promptEntries(st, false).map((e) => e.area)).toEqual(['staged', 'unstaged', 'untracked']);
	});
});
