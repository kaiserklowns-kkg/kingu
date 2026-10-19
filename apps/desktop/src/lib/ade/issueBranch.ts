// A Jira task's branch keeps the issue key as Jira writes it (`ENG-123-fix-login`): Jira's
// development panel links a branch only when the key in its name is uppercase. The worktree folder
// (the slug) stays lowercase; only the branch name differs.

import { slugify } from '#lib/agent/events.ts';
import type { IssueLink } from './model.ts';

/** The branch name's part after the prefix for a task with slug `slug`, or null for the slug itself. */
export function issueBranchLeaf(slug: string, issue: IssueLink | undefined): string | null {
	const key = issue?.provider === 'jira' ? issue.key?.trim() : undefined;
	if (!key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return null;
	const lower = slugify(key);
	if (slug !== lower && !slug.startsWith(`${lower}-`)) return null;
	return key + slug.slice(lower.length);
}
