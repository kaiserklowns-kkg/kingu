// One issue of Linear, Jira or GitLab for the Issues page drawer (Orca's linear-item-drawer /
// jira-issue / GitLab item views): which Rust command reads it, and its answer in one shape. The
// folder's GitHub issues have their own drawer with editing (IssueDrawer.svelte). Pure.
import type { IssueLink } from './model.ts';
import type { IssueLabel } from './issues.ts';
import { linkSource } from './taskSources.ts';

export type TrackerComment = { author: string; body: string; created_at: string };
export type TrackerDetail = {
	title: string;
	state: string;
	body: string;
	truncated: boolean;
	labels: IssueLabel[];
	assignees: string[];
	comments: TrackerComment[];
	omitted: number;
	/** Linear's priority (0 none, 1 urgent … 4 low); null for Jira and GitLab. */
	priority: number | null;
	/** Jira's priority by name (its ids come from the site's list). */
	priorityName: string;
	/** Linear's estimate points and due date (`YYYY-MM-DD`). */
	estimate: number | null;
	dueDate: string;
};

/** The view command and its arguments, or null for a link this drawer does not read. */
export function viewCall(link: IssueLink, gitlabHost: string): { cmd: string; args: Record<string, unknown> } | null {
	if (!link.key) return null;
	switch (linkSource(link)) {
		case 'linear':
			return { cmd: 'linear_issue_view', args: { id: link.key } };
		case 'jira':
			return { cmd: 'jira_issue_view', args: { key: link.key } };
		case 'gitlab':
			return { cmd: 'gitlab_issue_view', args: { host: gitlabHost, key: link.key } };
		default:
			return null;
	}
}

type Raw = {
	title?: string;
	state?: string;
	body?: string;
	body_truncated?: boolean;
	description?: string;
	description_truncated?: boolean;
	labels?: IssueLabel[];
	assignees?: string[];
	assignee?: string | null;
	comments?: TrackerComment[];
	comments_omitted?: number;
	priority?: number | string;
	estimate?: number | null;
	due_date?: string | null;
};

/** Linear says `description` and one `assignee`; Jira and GitLab say `body` and `assignees`. */
export function trackerDetail(raw: unknown): TrackerDetail {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Raw;
	return {
		title: r.title ?? '',
		state: r.state ?? '',
		body: r.body ?? r.description ?? '',
		truncated: !!(r.body_truncated ?? r.description_truncated),
		labels: Array.isArray(r.labels) ? r.labels : [],
		assignees: Array.isArray(r.assignees) ? r.assignees : r.assignee ? [r.assignee] : [],
		comments: Array.isArray(r.comments) ? r.comments : [],
		omitted: typeof r.comments_omitted === 'number' ? r.comments_omitted : 0,
		priority: typeof r.priority === 'number' && r.priority >= 0 && r.priority <= 4 ? r.priority : null,
		priorityName: typeof r.priority === 'string' ? r.priority : '',
		estimate: typeof r.estimate === 'number' ? r.estimate : null,
		dueDate: typeof r.due_date === 'string' ? r.due_date : ''
	};
}

type Call = { cmd: string; args: Record<string, unknown> };

/** A status an issue can move to (Rust `StateChoice`): Linear's workflow states, Jira's transitions, GitLab's close / reopen. */
export type StateChoice = { id: string; name: string; current: boolean; needs_fields: boolean };

/**
 * Assigning anyone (Orca's assignee pickers): Linear lists the issue's team members
 * (`team.members`), Jira searches the users who may be assigned it (`user/assignable/search`, so
 * `searches` and the list call takes the typed text), GitLab lists the project's members
 * (`members/all`). Choosing someone marked `current` takes them off (Linear and Jira: unassign;
 * GitLab: `removeAssignees`); anyone else is assigned (GitLab adds them, `addAssignees`).
 */
export type PeopleCalls = { list: (query: string) => Call; searches: boolean; choose: (person: StateChoice) => Call };

/** The people whose name contains every word typed (any case), the assigned first, at most `limit`. */
export function matchPeople(people: StateChoice[], query: string, limit = 20): StateChoice[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const hits = people.filter((p) => words.every((w) => p.name.toLowerCase().includes(w)));
	return [...hits.filter((p) => p.current), ...hits.filter((p) => !p.current)].slice(0, limit);
}

/**
 * How the drawer changes an issue's status (Orca's status controls: Linear `stateId`, Jira
 * transitions, GitLab `state`): the command listing the choices (none for GitLab, whose two follow
 * from the state shown) and the command that applies one.
 */
export function stateCalls(
	link: IssueLink,
	gitlabHost: string
): {
	list: Call | null;
	gitlab: boolean;
	set: (id: string) => Call;
	/** Assign to me (`true`) or unassign (Orca's assignee controls). */
	assign: (me: boolean) => Call;
	/** Assign anyone: the people who can be assigned, then a change for one of them. */
	people: PeopleCalls;
	/** Linear only: its fixed priorities. */
	priority: ((p: number) => Call) | null;
	/** Jira only: the site's priorities, then one by id. */
	jiraPriority: { list: Call; set: (id: string) => Call } | null;
	/** Linear only: estimate points and due date (null clears). */
	estimate: ((e: number | null) => Call) | null;
	dueDate: ((d: string | null) => Call) | null;
	/** Labels: Linear picks from its team's (`list`, then the whole set by id); Jira and GitLab take typed names to add or remove. */
	labels: { list: Call | null; byName: boolean; edit: (change: { add: string[]; remove: string[]; ids?: string[] }) => Call };
} | null {
	const key = link.key;
	if (!key) return null;
	switch (linkSource(link)) {
		case 'linear':
			return {
				list: { cmd: 'linear_issue_states', args: { id: key } },
				gitlab: false,
				set: (stateId) => ({ cmd: 'linear_issue_set_state', args: { id: key, stateId } }),
				assign: (me) => ({ cmd: 'linear_issue_assign', args: { id: key, me } }),
				people: { list: () => ({ cmd: 'linear_issue_members', args: { id: key } }), searches: false, choose: (p) => ({ cmd: 'linear_issue_set_assignee', args: { id: key, userId: p.current ? null : p.id } }) },
				priority: (priority) => ({ cmd: 'linear_issue_set_priority', args: { id: key, priority } }),
				labels: { list: { cmd: 'linear_issue_labels', args: { id: key } }, byName: false, edit: ({ ids }) => ({ cmd: 'linear_issue_set_labels', args: { id: key, labelIds: ids ?? [] } }) },
				jiraPriority: null,
				estimate: (estimate) => ({ cmd: 'linear_issue_set_estimate', args: { id: key, estimate } }),
				dueDate: (date) => ({ cmd: 'linear_issue_set_due_date', args: { id: key, date } })
			};
		case 'jira':
			return { list: { cmd: 'jira_issue_transitions', args: { key } }, gitlab: false, set: (id) => ({ cmd: 'jira_issue_transition', args: { key, id } }), assign: (me) => ({ cmd: 'jira_issue_assign', args: { key, me } }), people: { list: (query) => ({ cmd: 'jira_assignable_users', args: { key, query } }), searches: true, choose: (p) => ({ cmd: 'jira_issue_set_assignee', args: { key, accountId: p.current ? null : p.id } }) }, priority: null, labels: { list: null, byName: true, edit: ({ add, remove }) => ({ cmd: 'jira_issue_labels', args: { key, add, remove } }) }, jiraPriority: { list: { cmd: 'jira_priorities', args: {} }, set: (id) => ({ cmd: 'jira_issue_set_priority', args: { key, id } }) }, estimate: null, dueDate: null };
		case 'gitlab':
			return {
				list: null,
				gitlab: true,
				set: (id) => ({ cmd: 'gitlab_issue_set_state', args: { host: gitlabHost, key, open: id === 'reopen' } }),
				assign: (me) => ({ cmd: 'gitlab_issue_assign', args: { host: gitlabHost, key, me } }),
				people: { list: () => ({ cmd: 'gitlab_issue_members', args: { host: gitlabHost, key } }), searches: false, choose: (p) => ({ cmd: 'gitlab_issue_set_assignee', args: { host: gitlabHost, key, userId: Number(p.id), add: !p.current } }) },
				priority: null,
				labels: { list: null, byName: true, edit: ({ add, remove }) => ({ cmd: 'gitlab_issue_labels', args: { host: gitlabHost, key, add, remove } }) },
				jiraPriority: null,
				estimate: null,
				dueDate: null
			};
		default:
			return null;
	}
}

/** GitLab's one move from the state the drawer shows (`OPEN` → close, `CLOSED` → reopen). */
export function gitlabChoices(state: string, names: { close: string; reopen: string }): StateChoice[] {
	return state === 'OPEN' ? [{ id: 'close', name: names.close, current: false, needs_fields: false }] : state === 'CLOSED' ? [{ id: 'reopen', name: names.reopen, current: false, needs_fields: false }] : [];
}
