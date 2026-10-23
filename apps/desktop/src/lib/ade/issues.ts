// GitHub issues as agent tasks: pure helpers (no runes, no Tauri) for the Issues page, the palette
// and `adeTasks.createFromIssue`. Shapes mirror Rust `agent/issues.rs`.

import { slugify } from '#lib/agent/events.ts';
import { t } from '#lib/i18n/index.ts';
import type { IssueLink, TaskMeta } from './model.ts';

export type IssueLabel = { name: string; color: string };

export type Issue = {
	number: number;
	title: string;
	url: string;
	/** `OPEN` or `CLOSED`. */
	state: string;
	labels: IssueLabel[];
	assignees: string[];
	/** ISO 8601. */
	updated_at: string;
	author: string;
	body: string;
	body_truncated: boolean;
};

export type IssueComment = { author: string; body: string; created_at: string };
export type IssueDetail = Issue & { comments: IssueComment[]; comments_omitted: number };

/** Comments beyond this many bytes stay out of the prompt (tasks.json caps prompts at 64 KB). */
const MAX_PROMPT_COMMENTS = 24 * 1024;
const SLUG_WORDS = 6;

export function issueLink(issue: Pick<Issue, 'number' | 'url' | 'title'>): IssueLink {
	return { number: issue.number, url: issue.url, title: issue.title };
}

/** Branch name base for an issue's task: `issue-<n>-<first title words>` (just `issue-<n>` for a non-Latin title). */
export function issueSlug(issue: Pick<Issue, 'number' | 'title'>): string {
	const words = slugify(issue.title).split('-').filter(Boolean);
	// slugify falls back to `task-<time>` for a title with no Latin letters.
	const latin = /[a-z0-9]/i.test(issue.title) ? words.slice(0, SLUG_WORDS) : [];
	return slugify(['issue', String(issue.number), ...latin].join(' '));
}

/** Task title shown on cards: `#<n> <title>`. */
export function issueTaskTitle(issue: Pick<Issue, 'number' | 'title'>): string {
	return `#${issue.number} ${issue.title.trim()}`.slice(0, 200).trim();
}

/** The agent's instructions: the issue (title, link, body, latest comments) and how to reference it. */
export function issuePrompt(issue: Issue | IssueDetail): string {
	const parts = [t('legacyAde.issues.prompt.title', { number: issue.number, title: issue.title.trim() }), t('legacyAde.issues.prompt.link', { url: issue.url })];
	if (issue.labels.length) parts.push(`labels: ${issue.labels.map((l) => l.name).join(', ')}`);
	const body = issue.body.trim();
	const detail = `${body || t('legacyAde.issues.prompt.emptyBody')}${issue.body_truncated ? t('legacyAde.issues.prompt.truncated') : ''}`;
	parts.push(t('legacyAde.issues.prompt.details', { body: detail }));
	if ('comments' in issue && issue.comments.length) {
		let size = 0;
		const kept: string[] = [];
		for (const c of [...issue.comments].reverse()) {
			const text = `@${c.author || 'ghost'} (${c.created_at.slice(0, 10)}):\n${c.body.trim()}`;
			if (size + text.length > MAX_PROMPT_COMMENTS) break;
			size += text.length;
			kept.unshift(text);
		}
		const omitted = issue.comments_omitted + issue.comments.length - kept.length;
		const latest = omitted ? t('legacyAde.issues.prompt.commentsLatest', { kept: kept.length, total: kept.length + omitted }) : '';
		if (kept.length) parts.push(t('legacyAde.issues.prompt.commentsSection', { latest, comments: kept.join('\n\n') }));
	}
	parts.push(t('legacyAde.issues.prompt.todo', { number: issue.number }));
	return parts.join('\n\n');
}

/** A GitHub link (no provider) or a Linear one. */
export const isLinear = (link: IssueLink): boolean => link.provider === 'linear';

/** An issue of the open folder's own GitHub repository (links saved before other trackers have no provider). */
export const isFolderGithub = (link: IssueLink): boolean => (link.provider ?? 'github') === 'github' && !link.key;

/** How a task names its issue: `#42` on GitHub and GitLab, `ENG-123` on Linear and Jira, `acme/app#42` from a GitHub Project. */
export function issueRef(link: IssueLink): string {
	return link.key && link.provider !== 'gitlab' ? link.key : `#${link.number}`;
}

/** PR body of a task: its prompt, plus `Fixes #N` (or `Fixes ENG-123`) when it came from an issue; GitHub and Linear close it on merge. */
export function prBody(meta: Pick<TaskMeta, 'slug' | 'prompt' | 'issue'>): string {
	const fixes = meta.issue ? `Fixes ${issueRef(meta.issue)}\n\n` : '';
	return `${fixes}${meta.prompt}${t('legacyAde.issues.prBody', { slug: meta.slug })}`;
}

/** The issue comment posted when the task's PR opens (`kingu.issues.commentOnPr`). */
export function prComment(url: string): string {
	return t('legacyAde.issues.prComment', { url });
}

/** The task already started from GitHub issue `number`, if any (the newest when there are several). */
export function taskForIssue<T extends Pick<TaskMeta, 'issue' | 'created_at'>>(list: T[], number: number): T | undefined {
	return list.filter((t) => t.issue && isFolderGithub(t.issue) && t.issue.number === number).sort((a, b) => b.created_at - a.created_at)[0];
}

/** GitHub issue number → its task's slug, for the Issues page's "has a task" links. */
export function tasksByIssue(list: Pick<TaskMeta, 'issue' | 'slug' | 'created_at'>[]): Map<number, string> {
	const map = new Map<number, string>();
	for (const t of [...list].sort((a, b) => a.created_at - b.created_at)) if (t.issue && isFolderGithub(t.issue)) map.set(t.issue.number, t.slug);
	return map;
}

/** Issues assigned to me first, then the other open ones, without repeats (the palette's list). */
export function mergeIssueLists(mine: Issue[], all: Issue[]): { issue: Issue; mine: boolean }[] {
	const seen = new Set(mine.map((i) => i.number));
	return [...mine.map((issue) => ({ issue, mine: true })), ...all.filter((i) => !seen.has(i.number)).map((issue) => ({ issue, mine: false }))];
}
