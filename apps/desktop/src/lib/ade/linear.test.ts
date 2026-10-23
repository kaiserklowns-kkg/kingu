import { describe, expect, test } from 'bun:test';
import { issueRef, prBody, taskForIssue, tasksByIssue } from './issues';
import { linearLink, linearPrompt, linearSlug, linearTaskTitle, mergeLinearLists, taskForLinearIssue, type LinearIssue, type LinearIssueDetail } from './linear';
import { newTask } from './model';

const issue = (over: Partial<LinearIssue> = {}): LinearIssue => ({
	id: '0b7c5e0e-1111-4222-8333-944455556666',
	identifier: 'ENG-123',
	number: 123,
	title: 'Fix login on Safari when cookies are blocked',
	url: 'https://linear.app/acme/issue/ENG-123/fix-login',
	state: 'In Progress',
	state_type: 'started',
	state_color: 'f2c94c',
	priority: 2,
	priority_label: 'High',
	team: 'ENG',
	assignee: 'kawin',
	labels: [{ name: 'bug', color: 'eb5757' }],
	updated_at: '2026-10-01T08:30:00.000Z',
	branch_name: 'kawin/eng-123-fix-login',
	description: 'Steps:\n1. open Safari',
	description_truncated: false,
	...over
});

describe('Linear slugs, titles and links', () => {
	test('eng-<n>-<first title words>', () => {
		expect(linearSlug(issue())).toBe('eng-123-fix-login-on-safari-when-cookies');
		expect(linearSlug(issue({ title: 'แก้หน้าเข้าสู่ระบบ' }))).toBe('eng-123');
		expect(linearTaskTitle(issue())).toBe('ENG-123 Fix login on Safari when cookies are blocked');
	});

	test('a Linear link names its identifier; PR bodies say Fixes ENG-123', () => {
		const link = linearLink(issue());
		expect(link).toEqual({ number: 123, url: issue().url, title: issue().title, provider: 'linear', key: 'ENG-123' });
		expect(issueRef(link)).toBe('ENG-123');
		expect(issueRef({ number: 42, url: 'u', title: 't' })).toBe('#42');
		expect(prBody({ slug: 'eng-123-x', prompt: 'p', issue: link }).startsWith('Fixes ENG-123\n\n')).toBe(true);
	});
});

describe('Linear prompts', () => {
	test('carry the issue, its facts and the Fixes line', () => {
		const p = linearPrompt(issue());
		expect(p).toContain('Fix Linear issue ENG-123: Fix login');
		expect(p).toContain('State: In Progress · priority: High · labels: bug');
		expect(p).toContain('Steps:\n1. open Safari');
		expect(p).toContain('"Fixes ENG-123"');
		expect(linearPrompt(issue({ description: '', priority: 0, labels: [] }))).toContain('(no details)');
	});

	test('keep the latest comments within the budget', () => {
		const big = 'x'.repeat(10 * 1024);
		const detail: LinearIssueDetail = {
			...issue(),
			comments: ['a', 'b', 'c', 'd'].map((n, i) => ({ author: n, body: `${n}${big}`, created_at: `2026-10-0${i + 1}T00:00:00Z` })),
			comments_omitted: 1
		};
		const p = linearPrompt(detail);
		expect(p).toContain('latest 2 of 5');
		expect(p).not.toContain('a (2026-10-01)');
		expect(p).toContain('d (2026-10-04)');
	});
});

describe('tasks per provider', () => {
	const gh = { ...newTask({ slug: 'issue-123', title: 't', prompt: 'p', base: 'main', issue: { number: 123, url: 'https://github.com/a/b/issues/123', title: 't' } }, 1) };
	const lin = { ...newTask({ slug: 'eng-123', title: 't', prompt: 'p', base: 'main', issue: linearLink(issue()) }, 2) };

	test('GitHub #123 and ENG-123 never stand for each other', () => {
		expect(taskForIssue([gh, lin], 123)?.slug).toBe('issue-123');
		expect(taskForIssue([lin], 123)).toBeUndefined();
		expect([...tasksByIssue([gh, lin])]).toEqual([[123, 'issue-123']]);
		expect(taskForLinearIssue([gh, lin], 'ENG-123')?.slug).toBe('eng-123');
		expect(taskForLinearIssue([gh], 'ENG-123')).toBeUndefined();
	});

	test('mine first, then the rest without repeats', () => {
		const other = issue({ id: 'other', identifier: 'ENG-7' });
		expect(mergeLinearLists([issue()], [issue(), other]).map((r) => [r.issue.identifier, r.mine])).toEqual([
			['ENG-123', true],
			['ENG-7', false]
		]);
	});
});
