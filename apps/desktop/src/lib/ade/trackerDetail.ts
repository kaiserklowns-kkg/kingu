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
		omitted: typeof r.comments_omitted === 'number' ? r.comments_omitted : 0
	};
}
