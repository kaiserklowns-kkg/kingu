// Calls into Rust for a task's issue on any tracker, by its link: comment (the PR comment of
// `kingu.issues.commentOnPr`) and open in the browser. Kept apart from `taskSources.svelte.ts` so
// `tasks.svelte.ts` can use it without an import cycle.

import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import type { IssueLink } from './model.ts';
import { linkSource } from './taskSources.ts';

/** `kingu.gitlab.host`: `gitlab.com` unless set. */
export const gitlabHost = (): string => settings.get<string>('kingu.gitlab.host')?.trim() || 'gitlab.com';

/** Comments on the issue of a GitLab, Jira or GitHub Project link (GitHub and Linear have their own calls). */
export function commentOnLink(link: IssueLink, body: string): Promise<unknown> {
	switch (linkSource(link)) {
		case 'gitlab':
			return invoke('gitlab_issue_comment', { host: gitlabHost(), key: link.key, body });
		case 'jira':
			return invoke('jira_issue_comment', { key: link.key, body });
		case 'project':
			return invoke('gh_project_issue_comment', { url: link.url, body });
		case 'linear':
			return invoke('linear_issue_comment', { id: link.key, body });
		default:
			return invoke('gh_issue_comment', { number: link.number, body });
	}
}

/** Opens the issue in the browser; Rust allows only its tracker's host. */
export function openLink(link: IssueLink): Promise<unknown> {
	switch (linkSource(link)) {
		case 'gitlab':
			return invoke('gitlab_issue_open', { host: gitlabHost(), url: link.url });
		case 'jira':
			return invoke('jira_issue_open', { url: link.url });
		case 'project':
			return invoke('gh_project_issue_open', { url: link.url });
		case 'linear':
			return invoke('linear_issue_open', { url: link.url });
		default:
			return invoke('gh_issue_open', { number: link.number });
	}
}
