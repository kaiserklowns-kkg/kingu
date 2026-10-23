// Linear issues as agent tasks: pure helpers (no runes, no Tauri) for the palette and
// `adeTasks.createFromLinearIssue`. Shapes mirror Rust `linear.rs`.

import { slugify } from '#lib/agent/events.ts';
import { t } from '#lib/i18n/index.ts';
import type { IssueComment, IssueLabel } from './issues.ts';
import type { IssueLink, TaskMeta } from './model.ts';

export type LinearViewer = { name: string; email: string; organization: string };

export type LinearIssue = {
	id: string;
	/** `ENG-123`. */
	identifier: string;
	number: number;
	title: string;
	url: string;
	state: string;
	/** `backlog`, `unstarted`, `started`, `triage` (finished ones are never listed). */
	state_type: string;
	state_color: string;
	/** 0 none, 1 urgent … 4 low. */
	priority: number;
	priority_label: string;
	team: string;
	assignee: string | null;
	labels: IssueLabel[];
	updated_at: string;
	branch_name: string;
	description: string;
	description_truncated: boolean;
};

export type LinearIssueDetail = LinearIssue & { comments: IssueComment[]; comments_omitted: number };

/** `assigned`/`created` are the viewer's; `open` is every unfinished issue. */
export type LinearFilter = 'assigned' | 'created' | 'open';

/** Comments beyond this many bytes stay out of the prompt (tasks.json caps prompts at 64 KB). */
const MAX_PROMPT_COMMENTS = 24 * 1024;
const SLUG_WORDS = 6;

export function linearLink(issue: Pick<LinearIssue, 'number' | 'url' | 'title' | 'identifier'>): IssueLink {
	return { number: issue.number, url: issue.url, title: issue.title, provider: 'linear', key: issue.identifier };
}

/** Branch name base: `eng-123-<first title words>`. Linear links a PR whose branch holds the identifier. */
export function linearSlug(issue: Pick<LinearIssue, 'identifier' | 'title'>): string {
	const words = slugify(issue.title).split('-').filter(Boolean);
	// slugify falls back to `task-<time>` for a title with no Latin letters.
	const latin = /[a-z0-9]/i.test(issue.title) ? words.slice(0, SLUG_WORDS) : [];
	return slugify([issue.identifier.toLowerCase(), ...latin].join(' '));
}

/** Task title shown on cards: `ENG-123 <title>`. */
export function linearTaskTitle(issue: Pick<LinearIssue, 'identifier' | 'title'>): string {
	return `${issue.identifier} ${issue.title.trim()}`.slice(0, 200).trim();
}

/** The agent's instructions: the issue (title, link, state, description, latest comments) and how to reference it. */
export function linearPrompt(issue: LinearIssue | LinearIssueDetail): string {
	const parts = [t('legacyAde.linear.title', { identifier: issue.identifier, title: issue.title.trim() }), t('legacyAde.issues.prompt.link', { url: issue.url })];
	const facts = [issue.state && t('legacyAde.linear.state', { state: issue.state }), issue.priority ? `priority: ${issue.priority_label}` : '', issue.labels.length ? `labels: ${issue.labels.map((l) => l.name).join(', ')}` : '']
		.filter(Boolean)
		.join(' · ');
	if (facts) parts.push(facts);
	const body = issue.description.trim();
	parts.push(t('legacyAde.issues.prompt.details', { body: `${body || t('legacyAde.issues.prompt.emptyBody')}${issue.description_truncated ? t('legacyAde.issues.prompt.truncated') : ''}` }));
	if ('comments' in issue && issue.comments.length) {
		let size = 0;
		const kept: string[] = [];
		for (const c of [...issue.comments].reverse()) {
			const text = `${c.author} (${c.created_at.slice(0, 10)}):\n${c.body.trim()}`;
			if (size + text.length > MAX_PROMPT_COMMENTS) break;
			size += text.length;
			kept.unshift(text);
		}
		const omitted = issue.comments_omitted + issue.comments.length - kept.length;
		const latest = omitted ? t('legacyAde.issues.prompt.commentsLatest', { kept: kept.length, total: kept.length + omitted }) : '';
		if (kept.length) parts.push(t('legacyAde.issues.prompt.commentsSection', { latest, comments: kept.join('\n\n') }));
	}
	parts.push(t('legacyAde.linear.todo', { identifier: issue.identifier }));
	return parts.join('\n\n');
}

/** The task already started from Linear issue `identifier`, if any (the newest when there are several). */
export function taskForLinearIssue<T extends Pick<TaskMeta, 'issue' | 'created_at'>>(list: T[], identifier: string): T | undefined {
	return list.filter((t) => t.issue?.provider === 'linear' && t.issue.key === identifier).sort((a, b) => b.created_at - a.created_at)[0];
}

/** Assigned to me first, then the other open ones, without repeats (the palette's list). */
export function mergeLinearLists(mine: LinearIssue[], all: LinearIssue[]): { issue: LinearIssue; mine: boolean }[] {
	const seen = new Set(mine.map((i) => i.id));
	return [...mine.map((issue) => ({ issue, mine: true })), ...all.filter((i) => !seen.has(i.id)).map((issue) => ({ issue, mine: false }))];
}
