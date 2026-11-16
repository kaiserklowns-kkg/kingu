// Orca's Edit Worktree Details (docs model/worktrees.mdx): the display name, a comment and one
// linked issue, GitHub or Linear, recognised from a pasted URL. Pure.

import type { IssueLink } from './model';

/** Rust `MAX_COMMENT` (agent/tasks.rs). */
export const MAX_COMMENT = 2000;

/**
 * The issue a pasted URL names: `github.com/<owner>/<repo>/issues/<n>` (or `/pull/<n>`) and
 * `linear.app/<team>/issue/<KEY-123>/…`. Null for anything else. `title` is the short reference
 * until the tracker gives a real one.
 */
export function issueFromUrl(text: string): IssueLink | null {
	let u: URL;
	try {
		u = new URL(text.trim());
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
	const parts = u.pathname.split('/').filter(Boolean);
	const host = u.hostname.replace(/^www\./, '');
	if (host === 'github.com' && parts.length >= 4 && (parts[2] === 'issues' || parts[2] === 'pull') && /^\d+$/.test(parts[3])) {
		const number = Number(parts[3]);
		const url = `https://github.com/${parts[0]}/${parts[1]}/${parts[2]}/${number}`;
		return { number, url, title: `#${number}`, provider: 'github', key: `${parts[0]}/${parts[1]}#${number}` };
	}
	if (host === 'linear.app' && parts.length >= 3 && parts[1] === 'issue' && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(parts[2])) {
		const key = parts[2].toUpperCase();
		return { number: Number(key.split('-')[1]), url: `https://linear.app/${parts[0]}/issue/${key}`, title: key, provider: 'linear', key };
	}
	return null;
}

/** What the dialog saves: the comment trimmed (empty: none), the issue kept when its URL did not change. */
export function detailsPatch(old: { comment?: string | null; issue: IssueLink | null }, input: { comment: string; issueUrl: string }): { comment: string | null; issue: IssueLink | null } | { error: 'badIssue' | 'longComment' } {
	const comment = input.comment.trim();
	if (comment.length > MAX_COMMENT) return { error: 'longComment' };
	const url = input.issueUrl.trim();
	let issue: IssueLink | null = null;
	if (url) {
		if (old.issue && old.issue.url === url) issue = old.issue;
		else {
			issue = issueFromUrl(url);
			if (!issue) return { error: 'badIssue' };
		}
	}
	return { comment: comment || null, issue };
}
