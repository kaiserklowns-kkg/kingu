import { describe, expect, test } from 'bun:test';
import { issueLink, issuePrompt, issueSlug, issueTaskTitle, mergeIssueLists, prBody, prComment, taskForIssue, tasksByIssue, type Issue, type IssueDetail } from './issues';
import { newTask, uniqueSlug } from './model';

const issue = (over: Partial<Issue> = {}): Issue => ({
	number: 42,
	title: 'Fix login on Safari when cookies are blocked',
	url: 'https://github.com/acme/app/issues/42',
	state: 'OPEN',
	labels: [{ name: 'bug', color: 'd73a4a' }],
	assignees: ['octocat'],
	updated_at: '2026-10-01T08:30:00Z',
	author: 'hubot',
	body: 'Steps:\n1. open Safari',
	body_truncated: false,
	...over
});

describe('issue slugs and titles', () => {
	test('issue-<n>-<first title words>', () => {
		expect(issueSlug(issue())).toBe('issue-42-fix-login-on-safari-when-cookies');
		expect(issueSlug(issue({ number: 7, title: 'แก้ login บน Safari' }))).toBe('issue-7-login-safari');
		expect(issueSlug(issue({ number: 7, title: 'แก้หน้าเข้าสู่ระบบ' }))).toBe('issue-7');
	});

	test('stays unique next to existing branches', () => {
		const taken = new Set(['issue-42-fix-login-on-safari-when-cookies']);
		expect(uniqueSlug(issueSlug(issue()), taken)).toBe('issue-42-fix-login-on-safari-when-cookies-2');
	});

	test('task title carries the number', () => {
		expect(issueTaskTitle(issue({ title: '  Crash  ' }))).toBe('#42 Crash');
	});
});

describe('issuePrompt', () => {
	test('has the title, link, body and asks for Fixes #N', () => {
		const p = issuePrompt(issue());
		expect(p).toContain('#42: Fix login on Safari');
		expect(p).toContain('https://github.com/acme/app/issues/42');
		expect(p).toContain('Steps:\n1. open Safari');
		expect(p).toContain('labels: bug');
		expect(p).toContain('"Fixes #42"');
	});

	test('an empty or truncated body says so', () => {
		expect(issuePrompt(issue({ body: '', labels: [] }))).toContain('(ไม่มีรายละเอียด)');
		expect(issuePrompt(issue({ labels: [] }))).not.toContain('labels:');
		expect(issuePrompt(issue({ body_truncated: true }))).toContain('ตัดเนื้อหาที่เหลือออก');
	});

	test('includes the latest comments within the budget', () => {
		const detail: IssueDetail = {
			...issue(),
			comments: [
				{ author: 'a', body: 'x'.repeat(20_000), created_at: '2026-10-01T00:00:00Z' },
				{ author: 'b', body: 'second', created_at: '2026-10-02T00:00:00Z' },
				{ author: 'c', body: 'y'.repeat(20_000), created_at: '2026-10-03T00:00:00Z' }
			],
			comments_omitted: 1
		};
		const p = issuePrompt(detail);
		expect(p).toContain('@b (2026-10-02):\nsecond');
		expect(p).toContain('@c (2026-10-03)');
		expect(p).not.toContain('@a ');
		expect(p).toContain('ล่าสุด 2 จาก 4');
		expect(p.length).toBeLessThan(64 * 1024);
	});
});

describe('PR body and comment', () => {
	test('Fixes #N first for an issue task, plain otherwise', () => {
		const meta = { ...newTask({ slug: 'issue-42-fix', title: '#42 Fix', prompt: 'do it', base: 'main', issue: issueLink(issue()) }, 1) };
		expect(prBody(meta)).toBe('Fixes #42\n\ndo it\n\n---\nสร้างจากงาน Kingu `issue-42-fix`');
		expect(prBody({ ...meta, issue: null })).toBe('do it\n\n---\nสร้างจากงาน Kingu `issue-42-fix`');
		expect(prComment('https://github.com/acme/app/pull/9')).toBe('Kingu เริ่มงานนี้ใน PR https://github.com/acme/app/pull/9');
	});
});

describe('duplicate detection', () => {
	const tasks = [
		newTask({ slug: 'a', title: 'A', prompt: '', base: 'main' }, 1),
		newTask({ slug: 'issue-42', title: '#42', prompt: '', base: 'main', issue: issueLink(issue()) }, 2),
		newTask({ slug: 'issue-42-2', title: '#42 again', prompt: '', base: 'main', issue: issueLink(issue()) }, 3),
		// An older tasks.json row has no `issue` at all.
		{ ...newTask({ slug: 'old', title: 'Old', prompt: '', base: 'main' }, 0), issue: undefined as unknown as null }
	];

	test('finds the newest task of an issue', () => {
		expect(taskForIssue(tasks, 42)?.slug).toBe('issue-42-2');
		expect(taskForIssue(tasks, 7)).toBeUndefined();
		expect(tasksByIssue(tasks)).toEqual(new Map([[42, 'issue-42-2']]));
	});

	test('new tasks have no issue unless given', () => {
		expect(newTask({ slug: 'x', title: 'X', prompt: '', base: 'main' }, 1).issue).toBeNull();
	});
});

test('palette list: mine first, the rest without repeats', () => {
	const rows = mergeIssueLists([issue({ number: 1 })], [issue({ number: 2 }), issue({ number: 1 })]);
	expect(rows.map((r) => [r.issue.number, r.mine])).toEqual([
		[1, true],
		[2, false]
	]);
});
