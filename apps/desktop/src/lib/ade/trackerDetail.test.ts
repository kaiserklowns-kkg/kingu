import { describe, expect, test } from 'bun:test';
import { gitlabChoices, matchPeople, stateCalls, trackerDetail, viewCall } from './trackerDetail.ts';

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
		const d = trackerDetail({ title: 'Fix', state: 'In Progress', description: 'Body', description_truncated: true, assignee: 'Kawin', labels: [{ name: 'bug', color: 'ff0000' }], comments: [{ author: 'a', body: 'c', created_at: 'x' }], comments_omitted: 2, priority: 2, estimate: 3, due_date: '2026-12-01' });
		expect(d).toEqual({ title: 'Fix', state: 'In Progress', body: 'Body', truncated: true, labels: [{ name: 'bug', color: 'ff0000' }], assignees: ['Kawin'], comments: [{ author: 'a', body: 'c', created_at: 'x' }], omitted: 2, priority: 2, priorityName: '', estimate: 3, dueDate: '2026-12-01' });
	});
	test("Jira / GitLab's body and assignees; junk is empty", () => {
		expect(trackerDetail({ title: 'T', body: 'B', assignees: ['x', 'y'] }).assignees).toEqual(['x', 'y']);
		expect(trackerDetail(null)).toEqual({ title: '', state: '', body: '', truncated: false, labels: [], assignees: [], comments: [], omitted: 0, priority: null, priorityName: '', estimate: null, dueDate: '' });
	});
});

describe('status changes', () => {
	const base = { number: 1, url: 'https://x', title: 't' };
	test('each tracker lists and applies its own way', () => {
		const lin = stateCalls({ ...base, provider: 'linear', key: 'ENG-1' }, 'gitlab.com')!;
		expect(lin.list).toEqual({ cmd: 'linear_issue_states', args: { id: 'ENG-1' } });
		expect(lin.set('s1')).toEqual({ cmd: 'linear_issue_set_state', args: { id: 'ENG-1', stateId: 's1' } });
		const jira = stateCalls({ ...base, provider: 'jira', key: 'OPS-7' }, 'gitlab.com')!;
		expect(jira.set('21')).toEqual({ cmd: 'jira_issue_transition', args: { key: 'OPS-7', id: '21' } });
		const gl = stateCalls({ ...base, provider: 'gitlab', key: 'g/p#3' }, 'git.acme.io')!;
		expect(gl.list).toBeNull();
		expect(gl.set('reopen')).toEqual({ cmd: 'gitlab_issue_set_state', args: { host: 'git.acme.io', key: 'g/p#3', open: true } });
		expect(gl.set('close').args.open).toBe(false);
		expect(lin.assign(true)).toEqual({ cmd: 'linear_issue_assign', args: { id: 'ENG-1', me: true } });
		expect(lin.priority?.(1)).toEqual({ cmd: 'linear_issue_set_priority', args: { id: 'ENG-1', priority: 1 } });
		expect(jira.assign(false)).toEqual({ cmd: 'jira_issue_assign', args: { key: 'OPS-7', me: false } });
		expect(jira.priority).toBeNull();
		expect(gl.assign(true)).toEqual({ cmd: 'gitlab_issue_assign', args: { host: 'git.acme.io', key: 'g/p#3', me: true } });
		expect(lin.labels.byName).toBe(false);
		expect(lin.labels.edit({ add: [], remove: [], ids: ['u1'] })).toEqual({ cmd: 'linear_issue_set_labels', args: { id: 'ENG-1', labelIds: ['u1'] } });
		expect(jira.labels.edit({ add: ['ux'], remove: ['old'] })).toEqual({ cmd: 'jira_issue_labels', args: { key: 'OPS-7', add: ['ux'], remove: ['old'] } });
		expect(gl.labels.edit({ add: ['bug'], remove: [] }).cmd).toBe('gitlab_issue_labels');
		expect(lin.estimate?.(null)).toEqual({ cmd: 'linear_issue_set_estimate', args: { id: 'ENG-1', estimate: null } });
		expect(lin.dueDate?.('2026-12-01')).toEqual({ cmd: 'linear_issue_set_due_date', args: { id: 'ENG-1', date: '2026-12-01' } });
		expect(jira.jiraPriority?.set('3')).toEqual({ cmd: 'jira_issue_set_priority', args: { key: 'OPS-7', id: '3' } });
		expect(trackerDetail({ priority: 'High' }).priorityName).toBe('High');
		expect(stateCalls({ ...base, provider: 'github', key: 'a/b#1' }, 'gitlab.com')).toBeNull();
	});
	test('assigning anyone: each tracker lists its people and assigns or takes off one', () => {
		const lin = stateCalls({ ...base, provider: 'linear', key: 'ENG-1' }, 'gitlab.com')!.people;
		const jira = stateCalls({ ...base, provider: 'jira', key: 'OPS-7' }, 'gitlab.com')!.people;
		const gl = stateCalls({ ...base, provider: 'gitlab', key: 'g/p#3' }, 'git.acme.io')!.people;
		const ann = { id: 'u1', name: 'Ann', current: false, needs_fields: false };
		expect([lin.searches, jira.searches, gl.searches]).toEqual([false, true, false]);
		expect(lin.list('x')).toEqual({ cmd: 'linear_issue_members', args: { id: 'ENG-1' } });
		expect(lin.choose(ann)).toEqual({ cmd: 'linear_issue_set_assignee', args: { id: 'ENG-1', userId: 'u1' } });
		expect(lin.choose({ ...ann, current: true }).args.userId).toBeNull();
		expect(jira.list('ann')).toEqual({ cmd: 'jira_assignable_users', args: { key: 'OPS-7', query: 'ann' } });
		expect(jira.choose({ ...ann, id: '5b10:a' })).toEqual({ cmd: 'jira_issue_set_assignee', args: { key: 'OPS-7', accountId: '5b10:a' } });
		expect(gl.list('')).toEqual({ cmd: 'gitlab_issue_members', args: { host: 'git.acme.io', key: 'g/p#3' } });
		expect(gl.choose({ ...ann, id: '9' })).toEqual({ cmd: 'gitlab_issue_set_assignee', args: { host: 'git.acme.io', key: 'g/p#3', userId: 9, add: true } });
		expect(gl.choose({ ...ann, id: '9', current: true }).args.add).toBe(false);
	});
	test('matchPeople finds every typed word in any case, the assigned first', () => {
		const p = (id: string, name: string, current = false) => ({ id, name, current, needs_fields: false });
		const all = [p('1', 'Ann Lee (@ann)'), p('2', 'Bo Lee (@bo)', true), p('3', 'Cy')];
		expect(matchPeople(all, '').map((x) => x.id)).toEqual(['2', '1', '3']);
		expect(matchPeople(all, '  lee ').map((x) => x.id)).toEqual(['2', '1']);
		expect(matchPeople(all, 'LEE @ann').map((x) => x.id)).toEqual(['1']);
		expect(matchPeople(all, 'zz')).toEqual([]);
		expect(matchPeople(all, '', 1).map((x) => x.id)).toEqual(['2']);
	});
	test("GitLab's one move follows the state shown", () => {
		const names = { close: 'Close', reopen: 'Reopen' };
		expect(gitlabChoices('OPEN', names).map((c) => c.id)).toEqual(['close']);
		expect(gitlabChoices('CLOSED', names).map((c) => c.id)).toEqual(['reopen']);
		expect(gitlabChoices('', names)).toEqual([]);
	});
});
