import { describe, expect, test } from 'bun:test';
import { trackerDetail, viewCall } from './trackerDetail.ts';

describe('viewCall', () => {
	const base = { number: 1, url: 'https://x', title: 't' };
	test('reads Linear, Jira and GitLab issues by key', () => {
		expect(viewCall({ ...base, provider: 'linear', key: 'ENG-1' }, 'gitlab.com')).toEqual({ cmd: 'linear_issue_view', args: { id: 'ENG-1' } });
		expect(viewCall({ ...base, provider: 'jira', key: 'OPS-7' }, 'gitlab.com')).toEqual({ cmd: 'jira_issue_view', args: { key: 'OPS-7' } });
		expect(viewCall({ ...base, provider: 'gitlab', key: 'g/p#3' }, 'git.acme.io')).toEqual({ cmd: 'gitlab_issue_view', args: { host: 'git.acme.io', key: 'g/p#3' } });
	});
	test('leaves GitHub (its own drawer) and keyless links out', () => {
		expect(viewCall(base, 'gitlab.com')).toBeNull();
		expect(viewCall({ ...base, provider: 'github', key: 'acme/app#1' }, 'gitlab.com')).toBeNull();
		expect(viewCall({ ...base, provider: 'linear' }, 'gitlab.com')).toBeNull();
	});
});

describe('trackerDetail', () => {
	test("Linear's description and single assignee", () => {
		const d = trackerDetail({ title: 'Fix', state: 'In Progress', description: 'Body', description_truncated: true, assignee: 'Kawin', labels: [{ name: 'bug', color: 'ff0000' }], comments: [{ author: 'a', body: 'c', created_at: 'x' }], comments_omitted: 2 });
		expect(d).toEqual({ title: 'Fix', state: 'In Progress', body: 'Body', truncated: true, labels: [{ name: 'bug', color: 'ff0000' }], assignees: ['Kawin'], comments: [{ author: 'a', body: 'c', created_at: 'x' }], omitted: 2 });
	});
	test("Jira / GitLab's body and assignees; junk is empty", () => {
		expect(trackerDetail({ title: 'T', body: 'B', assignees: ['x', 'y'] }).assignees).toEqual(['x', 'y']);
		expect(trackerDetail(null)).toEqual({ title: '', state: '', body: '', truncated: false, labels: [], assignees: [], comments: [], omitted: 0 });
	});
});
