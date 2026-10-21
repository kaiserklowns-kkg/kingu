import { describe, expect, test } from 'bun:test';
import { issueRef, prBody, taskForIssue, tasksByIssue, type Issue } from './issues';
import type { LinearIssue } from './linear';
import { newTask } from './model';
import { issueBranchLeaf } from './issueBranch';
import {
	filterItems,
	fromGithub,
	fromGitlab,
	fromJira,
	fromLinear,
	fromProject,
	gitlabPrompt,
	isoTime,
	jiraPrompt,
	linkId,
	linkSource,
	projectPrompt,
	sortItems,
	sourceName,
	sourceSlug,
	sourceTaskTitle,
	taskForLink,
	tasksByLink,
	type JiraIssue,
	type ProjectItem
} from './taskSources';

const issue = (over: Partial<Issue> = {}): Issue => ({
	number: 12,
	title: 'Fix login on Safari when cookies are blocked',
	url: 'https://gitlab.com/acme/app/-/issues/12',
	state: 'OPEN',
	labels: [{ name: 'bug', color: 'd9534f' }],
	assignees: ['kawin'],
	updated_at: '2026-10-01T08:30:00Z',
	author: 'hubot',
	body: 'Steps',
	body_truncated: false,
	...over
});

const jira = (over: Partial<JiraIssue> = {}): JiraIssue => ({
	key: 'ENG-123',
	number: 123,
	title: 'Fix login',
	url: 'https://acme.atlassian.net/browse/ENG-123',
	state: 'In Progress',
	state_category: 'indeterminate',
	priority: 'High',
	issue_type: 'Bug',
	project: 'ENG',
	labels: [],
	assignees: ['Kawin T'],
	updated_at: '2026-10-02T08:30:00.000+0700',
	author: 'Hubot',
	body: 'Steps',
	body_truncated: false,
	...over
});

const item = (over: Partial<ProjectItem> = {}): ProjectItem => ({
	item_id: 'PVTI_1',
	repo: 'acme/api',
	number: 42,
	title: 'Rate limit the login endpoint',
	url: 'https://github.com/acme/api/issues/42',
	state: 'OPEN',
	labels: [],
	assignees: ['kawin'],
	updated_at: '2026-09-30T00:00:00Z',
	author: 'hubot',
	body: 'Body',
	body_truncated: false,
	status: 'Todo',
	...over
});

const linear: LinearIssue = {
	id: 'u',
	identifier: 'OPS-7',
	number: 7,
	title: 'Rotate keys',
	url: 'https://linear.app/acme/issue/OPS-7/x',
	state: 'Todo',
	state_type: 'unstarted',
	state_color: '',
	priority: 2,
	priority_label: 'High',
	team: 'OPS',
	assignee: null,
	labels: [],
	updated_at: '2026-10-03T00:00:00Z',
	branch_name: '',
	description: '',
	description_truncated: false
};

describe('rows from every tracker', () => {
	test('keys, refs and links per source', () => {
		const gl = fromGitlab(issue(), 'acme/app');
		expect([gl.id, gl.ref, gl.link.key, gl.link.provider]).toEqual(['gitlab:acme/app#12', '#12', 'acme/app#12', 'gitlab']);
		const j = fromJira(jira());
		expect([j.id, j.ref, j.facts]).toEqual(['jira:ENG-123', 'ENG-123', ['In Progress', 'Bug', 'High']]);
		const p = fromProject(item());
		expect([p.id, p.ref, p.link.provider, p.facts]).toEqual(['project:acme/api#42', 'acme/api#42', 'github', ['Todo']]);
		const gh = fromGithub(issue({ number: 42, url: 'https://github.com/acme/app/issues/42' }));
		expect([gh.id, gh.ref, gh.link.provider]).toEqual(['github:42', '#42', undefined]);
		expect(fromLinear(linear).id).toBe('linear:OPS-7');
	});

	test('names the source of a saved link', () => {
		expect(linkSource({})).toBe('github');
		expect(linkSource({ provider: 'github', key: 'acme/api#42' })).toBe('project');
		expect(sourceName({ provider: 'github', key: 'acme/api#42' })).toBe('GitHub');
		expect(sourceName({ provider: 'jira', key: 'ENG-1' })).toBe('Jira');
		expect(linkId({ number: 3 })).toBe('github:3');
	});

	test('sorts newest first across time formats and filters by source', () => {
		const rows = [fromGitlab(issue(), 'acme/app'), fromJira(jira()), fromProject(item()), fromLinear(linear)];
		expect(sortItems(rows).map((r) => r.source)).toEqual(['linear', 'jira', 'gitlab', 'project']);
		expect(isoTime('2026-10-02T08:30:00.000+0700')).toBe(Date.parse('2026-10-02T01:30:00Z'));
		expect(isoTime('nope')).toBe(0);
		expect(filterItems(rows, 'jira').map((r) => r.ref)).toEqual(['ENG-123']);
		expect(filterItems(rows, null)).toHaveLength(4);
	});
});

describe('tasks from rows', () => {
	test('branch carries the issue key', () => {
		expect(sourceSlug(fromJira(jira()))).toBe('eng-123-fix-login');
		// The folder is lowercase; Jira's branch keeps the key as Jira writes it.
		expect(issueBranchLeaf(sourceSlug(fromJira(jira())), fromJira(jira()).link)).toBe('ENG-123-fix-login');
		expect(issueBranchLeaf(sourceSlug(fromGitlab(issue(), 'acme/app')), fromGitlab(issue(), 'acme/app').link)).toBeNull();
		expect(sourceSlug(fromGitlab(issue(), 'acme/app'))).toBe('issue-12-fix-login-on-safari-when-cookies');
		expect(sourceSlug(fromProject(item({ title: 'แก้ login' })))).toBe('issue-42-login');
		expect(sourceTaskTitle(fromJira(jira({ title: '  Crash ' })))).toBe('ENG-123 Crash');
	});

	test('prompts ask for the closing reference each tracker understands', () => {
		const gl = gitlabPrompt({ ...issue(), comments: [{ author: 'kawin', body: 'repro on 17.2', created_at: '2026-10-01T00:00:00Z' }], comments_omitted: 1 }, 'acme/app');
		expect(gl).toContain('GitLab issue acme/app#12');
		expect(gl).toContain('"Closes acme/app#12"');
		expect(gl).toContain('@kawin (2026-10-01)');
		expect(gl).toContain('(ล่าสุด 1 จาก 2)');
		const j = jiraPrompt(jira({ body: '', body_truncated: false }));
		expect(j).toContain('Jira issue ENG-123');
		expect(j).toContain('(ไม่มีรายละเอียด)');
		expect(j).toContain('ขึ้นต้นข้อความ commit ด้วย ENG-123');
		const p = projectPrompt(item(), { ...issue({ number: 42, body: 'from gh', body_truncated: true }), comments: [], comments_omitted: 0 });
		expect(p).toContain('"Fixes acme/api#42"');
		expect(p).toContain('from gh');
		expect(p).toContain('สถานะใน project: Todo');
	});

	test('finds tasks per tracker without mixing numbers', () => {
		const gh = newTask({ slug: 'issue-12', title: '#12', prompt: 'p', base: 'main', issue: { number: 12, url: 'https://github.com/acme/app/issues/12', title: 't' } }, 1);
		const gl = newTask({ slug: 'issue-12-2', title: '#12', prompt: 'p', base: 'main', issue: fromGitlab(issue(), 'acme/app').link }, 2);
		const pj = newTask({ slug: 'issue-42', title: 'x', prompt: 'p', base: 'main', issue: fromProject(item({ number: 12 })).link }, 3);
		const list = [gh, gl, pj];
		expect(taskForIssue(list, 12)?.slug).toBe('issue-12');
		expect([...tasksByIssue(list)]).toEqual([[12, 'issue-12']]);
		expect(taskForLink(list, fromGitlab(issue(), 'acme/app').link)?.slug).toBe('issue-12-2');
		expect(tasksByLink(list)).toEqual(new Map([['github:12', 'issue-12'], ['gitlab:acme/app#12', 'issue-12-2'], ['project:acme/api#12', 'issue-42']]));
	});

	test('PR bodies reference the issue', () => {
		expect(issueRef(fromJira(jira()).link)).toBe('ENG-123');
		expect(issueRef(fromProject(item()).link)).toBe('acme/api#42');
		expect(issueRef(fromGitlab(issue(), 'acme/app').link)).toBe('#12');
		expect(prBody({ slug: 's', prompt: 'p', issue: fromProject(item()).link })).toStartWith('Fixes acme/api#42\n\n');
	});
});
