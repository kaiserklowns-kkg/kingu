// Every issue tracker the Issues page lists, as one row shape (old Kingu's unified Tasks page):
// the folder's GitHub issues, a GitHub Project's issues, Linear, GitLab and Jira. Pure helpers (no
// runes, no Tauri) for the page, the palette and `sources.start`. Shapes mirror Rust `gitlab.rs`,
// `jira.rs` and `agent/gh_projects.rs`; GitHub and Linear keep their own modules.

import { slugify } from '#lib/agent/events.ts';
import { t } from '#lib/i18n/index.ts';
import { issueLink, type Issue, type IssueComment, type IssueDetail, type IssueLabel } from './issues.ts';
import { linearLink, type LinearIssue } from './linear.ts';
import type { IssueLink, TaskMeta } from './model.ts';

export type SourceId = 'github' | 'project' | 'linear' | 'gitlab' | 'jira';
export const SOURCES: readonly SourceId[] = ['github', 'project', 'linear', 'gitlab', 'jira'];
export const SOURCE_NAMES: Record<SourceId, string> = { github: 'GitHub', project: 'GitHub Projects', linear: 'Linear', gitlab: 'GitLab', jira: 'Jira' };

export type GitlabViewer = { username: string; name: string; host: string };
/** A project's open issues (GitHub's issue shape, `number` is the `iid`). */
export type GitlabList = { project: string; issues: Issue[] };

export type JiraViewer = { name: string; email: string; site: string };
export type JiraIssue = {
	/** `ENG-123`. */
	key: string;
	number: number;
	title: string;
	url: string;
	state: string;
	/** `new`, `indeterminate` (done ones are never listed). */
	state_category: string;
	priority: string;
	issue_type: string;
	project: string;
	labels: IssueLabel[];
	assignees: string[];
	updated_at: string;
	author: string;
	body: string;
	body_truncated: boolean;
};
export type JiraIssueDetail = JiraIssue & { comments: IssueComment[]; comments_omitted: number };
/** `assigned`/`reported` are mine; `open` is everyone's unfinished issues. */
export type JiraFilter = 'assigned' | 'reported' | 'open';

export type ProjectSummary = { id: string; owner: string; number: number; title: string; url: string; closed: boolean };
export type ProjectItem = {
	item_id: string;
	/** `acme/app`. */
	repo: string;
	number: number;
	title: string;
	url: string;
	state: string;
	labels: IssueLabel[];
	assignees: string[];
	updated_at: string;
	author: string;
	body: string;
	body_truncated: boolean;
	/** The project's Status column; empty when unset. */
	status: string;
};
export type ProjectItems = { title: string; url: string; items: ProjectItem[] };

/** What a row came from, for starting its task. */
export type RawItem =
	| { source: 'github'; issue: Issue }
	| { source: 'linear'; issue: LinearIssue }
	| { source: 'gitlab'; issue: Issue; project: string }
	| { source: 'jira'; issue: JiraIssue }
	| { source: 'project'; item: ProjectItem };

/** One row of the Issues page. */
export type SourceItem = {
	source: SourceId;
	/** Unique across sources: `github:42`, `jira:ENG-1` (`linkId` of its link). */
	id: string;
	/** How the row names it: `#42`, `ENG-123`, `acme/app#42`. */
	ref: string;
	title: string;
	url: string;
	labels: IssueLabel[];
	assignees: string[];
	updated_at: string;
	/** Status, priority, type: shown after the labels. */
	facts: string[];
	link: IssueLink;
	raw: RawItem;
};

/** Comments beyond this many bytes stay out of the prompt (tasks.json caps prompts at 64 KB). */
const MAX_PROMPT_COMMENTS = 24 * 1024;
const SLUG_WORDS = 6;

/** Which tracker a task's link points to (links without a provider are GitHub's). */
export function linkSource(link: Pick<IssueLink, 'provider' | 'key'>): SourceId {
	const p = link.provider ?? 'github';
	return p === 'github' ? (link.key ? 'project' : 'github') : p;
}

/** The tracker's name for tooltips: `GitHub`, `Jira`. */
export function sourceName(link: Pick<IssueLink, 'provider' | 'key'>): string {
	const s = linkSource(link);
	return s === 'project' ? 'GitHub' : SOURCE_NAMES[s];
}

/** `github:42`, `project:acme/app#42`, `linear:ENG-1`, `gitlab:acme/app#12`, `jira:ENG-1`. */
export function linkId(link: Pick<IssueLink, 'provider' | 'key' | 'number'>): string {
	return `${linkSource(link)}:${link.key ?? link.number}`;
}

/** Row id → the slug of the newest task started from it. */
export function tasksByLink(list: Pick<TaskMeta, 'issue' | 'slug' | 'created_at'>[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const t of [...list].sort((a, b) => a.created_at - b.created_at)) if (t.issue) map.set(linkId(t.issue), t.slug);
	return map;
}

/** The task already started from `link`'s issue, if any (the newest when there are several). */
export function taskForLink<T extends Pick<TaskMeta, 'issue' | 'created_at'>>(list: T[], link: IssueLink): T | undefined {
	const id = linkId(link);
	return list.filter((t) => t.issue && linkId(t.issue) === id).sort((a, b) => b.created_at - a.created_at)[0];
}

/** Unix ms of an ISO 8601 time, Jira's `+0700` offsets included; 0 when unreadable. */
export function isoTime(s: string): number {
	const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
	return Number.isNaN(t) ? 0 : t;
}

/** Newest first. */
export function sortItems(items: SourceItem[]): SourceItem[] {
	return [...items].sort((a, b) => isoTime(b.updated_at) - isoTime(a.updated_at));
}

export function fromGithub(issue: Issue): SourceItem {
	const link = issueLink(issue);
	return { source: 'github', id: linkId(link), ref: `#${issue.number}`, title: issue.title, url: issue.url, labels: issue.labels, assignees: issue.assignees, updated_at: issue.updated_at, facts: [], link, raw: { source: 'github', issue } };
}

export function fromLinear(issue: LinearIssue): SourceItem {
	const link = linearLink(issue);
	return {
		source: 'linear',
		id: linkId(link),
		ref: issue.identifier,
		title: issue.title,
		url: issue.url,
		labels: issue.labels,
		assignees: issue.assignee ? [issue.assignee] : [],
		updated_at: issue.updated_at,
		facts: [issue.state, issue.priority ? issue.priority_label : ''].filter(Boolean),
		link,
		raw: { source: 'linear', issue }
	};
}

export function gitlabLink(issue: Pick<Issue, 'number' | 'url' | 'title'>, project: string): IssueLink {
	return { number: issue.number, url: issue.url, title: issue.title, provider: 'gitlab', key: `${project}#${issue.number}` };
}

export function fromGitlab(issue: Issue, project: string): SourceItem {
	const link = gitlabLink(issue, project);
	return { source: 'gitlab', id: linkId(link), ref: `#${issue.number}`, title: issue.title, url: issue.url, labels: issue.labels, assignees: issue.assignees, updated_at: issue.updated_at, facts: [project], link, raw: { source: 'gitlab', issue, project } };
}

export function jiraLink(issue: Pick<JiraIssue, 'number' | 'url' | 'title' | 'key'>): IssueLink {
	return { number: issue.number, url: issue.url, title: issue.title, provider: 'jira', key: issue.key };
}

export function fromJira(issue: JiraIssue): SourceItem {
	const link = jiraLink(issue);
	return {
		source: 'jira',
		id: linkId(link),
		ref: issue.key,
		title: issue.title,
		url: issue.url,
		labels: issue.labels,
		assignees: issue.assignees,
		updated_at: issue.updated_at,
		facts: [issue.state, issue.issue_type, issue.priority].filter(Boolean),
		link,
		raw: { source: 'jira', issue }
	};
}

export function projectLink(item: Pick<ProjectItem, 'number' | 'url' | 'title' | 'repo'>): IssueLink {
	return { number: item.number, url: item.url, title: item.title, provider: 'github', key: `${item.repo}#${item.number}` };
}

export function fromProject(item: ProjectItem): SourceItem {
	const link = projectLink(item);
	return {
		source: 'project',
		id: linkId(link),
		ref: `${item.repo}#${item.number}`,
		title: item.title,
		url: item.url,
		labels: item.labels,
		assignees: item.assignees,
		updated_at: item.updated_at,
		facts: [item.status].filter(Boolean),
		link,
		raw: { source: 'project', item }
	};
}

/** Branch name base: the issue's key and the first Latin title words (`eng-123-fix-login`, `issue-12-fix-login`). */
export function sourceSlug(item: Pick<SourceItem, 'source' | 'link' | 'title'>): string {
	const words = slugify(item.title).split('-').filter(Boolean);
	// slugify falls back to `task-<time>` for a title with no Latin letters.
	const latin = /[a-z0-9]/i.test(item.title) ? words.slice(0, SLUG_WORDS) : [];
	const head = item.source === 'jira' || item.source === 'linear' ? (item.link.key ?? '').toLowerCase() : `issue ${item.link.number}`;
	return slugify([head, ...latin].join(' '));
}

/** Task title shown on cards: `<ref> <title>`. */
export function sourceTaskTitle(item: Pick<SourceItem, 'ref' | 'title'>): string {
	return `${item.ref} ${item.title.trim()}`.slice(0, 200).trim();
}

type PromptParts = {
	/** `GitLab issue acme/app#12`. */
	what: string;
	title: string;
	url: string;
	facts: string[];
	body: string;
	truncated: boolean;
	comments?: IssueComment[];
	omitted?: number;
	/** Comment authors are logins (`@kawin`) rather than names. */
	logins?: boolean;
	/** What the commit should say so the tracker links or closes the issue. */
	closing: string;
};

/** The agent's instructions: the issue, its latest comments that fit, and how to reference it. */
export function trackerPrompt(p: PromptParts): string {
	const parts = [t('legacyAde.taskSources.title', { what: p.what, title: p.title.trim() }), t('legacyAde.issues.prompt.link', { url: p.url })];
	const facts = p.facts.filter(Boolean).join(' · ');
	if (facts) parts.push(facts);
	const body = p.body.trim();
	parts.push(t('legacyAde.issues.prompt.details', { body: `${body || t('legacyAde.issues.prompt.emptyBody')}${p.truncated ? t('legacyAde.issues.prompt.truncated') : ''}` }));
	if (p.comments?.length) {
		let size = 0;
		const kept: string[] = [];
		for (const c of [...p.comments].reverse()) {
			const text = `${p.logins ? `@${c.author || 'ghost'}` : c.author} (${c.created_at.slice(0, 10)}):\n${c.body.trim()}`;
			if (size + text.length > MAX_PROMPT_COMMENTS) break;
			size += text.length;
			kept.unshift(text);
		}
		const omitted = (p.omitted ?? 0) + p.comments.length - kept.length;
		const latest = omitted ? t('legacyAde.issues.prompt.commentsLatest', { kept: kept.length, total: kept.length + omitted }) : '';
		if (kept.length) parts.push(t('legacyAde.issues.prompt.commentsSection', { latest, comments: kept.join('\n\n') }));
	}
	parts.push(t('legacyAde.taskSources.todo', { closing: p.closing }));
	return parts.join('\n\n');
}

const labelsFact = (labels: IssueLabel[]) => (labels.length ? `labels: ${labels.map((l) => l.name).join(', ')}` : '');

export function gitlabPrompt(issue: Issue | IssueDetail, project: string): string {
	const key = `${project}#${issue.number}`;
	return trackerPrompt({
		what: `GitLab issue ${key}`,
		title: issue.title,
		url: issue.url,
		facts: [labelsFact(issue.labels)],
		body: issue.body,
		truncated: issue.body_truncated,
		comments: 'comments' in issue ? issue.comments : undefined,
		omitted: 'comments' in issue ? issue.comments_omitted : 0,
		logins: true,
		closing: t('legacyAde.taskSources.gitlab.closing', { key })
	});
}

export function jiraPrompt(issue: JiraIssue | JiraIssueDetail): string {
	return trackerPrompt({
		what: `Jira issue ${issue.key}`,
		title: issue.title,
		url: issue.url,
		facts: [issue.state && t('legacyAde.taskSources.jira.state', { state: issue.state }), issue.issue_type && t('legacyAde.taskSources.jira.type', { type: issue.issue_type }), issue.priority && `priority: ${issue.priority}`, labelsFact(issue.labels)],
		body: issue.body,
		truncated: issue.body_truncated,
		comments: 'comments' in issue ? issue.comments : undefined,
		omitted: 'comments' in issue ? issue.comments_omitted : 0,
		closing: t('legacyAde.taskSources.jira.closing', { key: issue.key })
	});
}

/** A GitHub Project's issue; `detail` (from `gh issue view`) adds the latest comments. */
export function projectPrompt(item: ProjectItem, detail?: IssueDetail): string {
	const key = `${item.repo}#${item.number}`;
	return trackerPrompt({
		what: `GitHub issue ${key}`,
		title: item.title,
		url: item.url,
		facts: [item.status && t('legacyAde.taskSources.sources.github.status', { status: item.status }), labelsFact(item.labels)],
		body: detail?.body ?? item.body,
		truncated: detail?.body_truncated ?? item.body_truncated,
		comments: detail?.comments,
		omitted: detail?.comments_omitted,
		logins: true,
		closing: t('legacyAde.taskSources.sources.github.closing', { key })
	});
}

/** Rows of the chosen sources (all when `only` is null). */
export function filterItems(items: SourceItem[], only: SourceId | null): SourceItem[] {
	return only ? items.filter((i) => i.source === only) : items;
}
