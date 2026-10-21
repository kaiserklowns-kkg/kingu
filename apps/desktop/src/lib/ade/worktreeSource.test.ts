import { describe, expect, test } from 'bun:test';
import { resolveSettings } from '#lib/settings/registry.ts';
import type { BranchRef } from '#lib/workbench/scmRemote.ts';
import { branchChoices, branchNamePrompt, branchSlug, branchTitle, looksLikePr, prTitle } from './worktreeSource';
import { newTask } from './model';

const ref = (name: string, more: Partial<BranchRef> = {}): BranchRef => ({ name, remote: false, current: false, upstream: null, worktree: null, commit: 'abc', subject: 's', ...more });

describe('task from an existing branch or a pull request (Orca new-workspace composer)', () => {
	test('local branches first, remote ones only without a local branch of their name, tags left out', () => {
		const refs = [ref('main', { current: true }), ref('kingu/t', { worktree: '/r/.kingu/worktrees/t' }), ref('feat'), ref('origin/main', { remote: true }), ref('origin/feat', { remote: true }), ref('origin/other/x', { remote: true }), ref('v1', { tag: true })];
		expect(branchChoices(refs)).toEqual([
			{ name: 'main', remote: false, busy: '.' },
			{ name: 'kingu/t', remote: false, busy: '/r/.kingu/worktrees/t' },
			{ name: 'feat', remote: false, busy: null },
			{ name: 'origin/other/x', remote: true, busy: null }
		]);
	});

	test('titles and PR input', () => {
		expect(branchTitle('kingu/fix-login_page')).toBe('fix login page');
		expect(branchTitle('main')).toBe('main');
		expect(prTitle({ number: 12, title: 'Fix login' })).toBe('#12 Fix login');
		for (const yes of ['12', '#12', ' 7 ', 'https://github.com/acme/app/pull/12/files']) expect([yes, looksLikePr(yes)]).toEqual([yes, true]);
		for (const no of ['', '0', '#', 'fix', 'https://github.com/acme/app/issues/3', '12a']) expect([no, looksLikePr(no)]).toEqual([no, false]);
	});

	test('a PR task links its PR at once; a branch name chosen by hand is never renamed', () => {
		const t = newTask({ slug: 'pr-12', title: '#12 Fix', prompt: '', base: 'main', prUrl: 'https://github.com/a/b/pull/12', status: 'review' }, 5);
		expect([t.pr_url, t.status, t.auto_name]).toEqual(['https://github.com/a/b/pull/12', 'review', undefined]);
		expect(newTask({ slug: 'x', title: 'X', prompt: 'p', base: 'main', autoName: true }, 5).auto_name).toBe(true);
	});
});

describe('branch name from the first work (Orca autoRenameBranchFromWork)', () => {
	test('defaults on, like Orca', () => {
		const m = resolveSettings({}, {});
		expect(m.get('kingu.worktree.autoRenameBranch')?.value).toBe(true);
		expect(m.get('kingu.git.ai.branchNameInstructions')?.value).toBe('');
	});

	test("the prompt carries the user's guidance first, then the request", () => {
		const p = branchNamePrompt('  please look at the failing login test  ');
		expect(p.startsWith('Generate a short git branch name')).toBe(true);
		expect(p.endsWith('User request:\nplease look at the failing login test')).toBe(true);
		const custom = branchNamePrompt('x', 'Use the ticket id first');
		expect(custom.split('\n').slice(0, 3)).toEqual(['Use the ticket id first', '', 'Generate a git branch name that summarizes the coding task described below.']);
	});

	test('answers become at most four kebab words without the configured prefix', () => {
		expect(branchSlug('fix-login-test', 'kingu/')).toBe('fix-login-test');
		expect(branchSlug('Branch name: Fix Login Test On Safari Today\nbecause…', 'kingu/')).toBe('fix-login-test-on');
		expect(branchSlug('```\nkingu/fix-login\n```', 'kingu/')).toBe('fix-login');
		expect(branchSlug('kingu', 'kingu/')).toBe('');
		expect(branchSlug('feature/add-dark-mode', '')).toBe('feature-add-dark-mode');
		expect(branchSlug('แก้บั๊ก', 'kingu/')).toBe('');
		expect(branchSlug('`refactor_api`', 'bright-')).toBe('refactor-api');
	});
});
