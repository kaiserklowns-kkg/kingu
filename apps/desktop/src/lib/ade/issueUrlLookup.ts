// Reads the issue an `IssueUrl` names from its tracker, for the New Task form: the link the task
// keeps and the prompt its agent starts with. The pure half is issueUrl.ts.

import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import type { IssueLink } from './model';
import type { IssueDetail } from './issues';
import { linearLink, linearPrompt, type LinearIssueDetail } from './linear';
import { linear } from './linear.svelte.ts';
import { gitlabLink, gitlabPrompt, jiraLink, jiraPrompt, projectLink, projectPrompt, type JiraIssueDetail, type JiraViewer, type ProjectItem } from './taskSources';
import { sources } from './taskSources.svelte';
import { gitlabHost } from './trackerApi';
import { siteHost, type IssueUrl } from './issueUrl';

export type LinkedIssue = { link: IssueLink; prompt: string };

/** Rejects with a message the form shows: not connected, another site, or the tracker's own error. */
export async function lookupIssueUrl(u: IssueUrl): Promise<LinkedIssue> {
	switch (u.provider) {
		case 'github': {
			const detail = await invoke<IssueDetail>('gh_project_issue_view', { url: u.url });
			const item: ProjectItem = { ...detail, item_id: '', repo: u.repo, url: u.url, status: '' };
			return { link: projectLink(item), prompt: projectPrompt(item, detail) };
		}
		case 'gitlab': {
			const host = gitlabHost();
			if (siteHost(host) !== u.host) throw new Error(t('adeWorktrees.link.otherSite', { service: 'GitLab', host: u.host }));
			const detail = await invoke<IssueDetail>('gitlab_issue_view', { host, key: `${u.project}#${u.number}` });
			return { link: gitlabLink({ ...detail, url: u.url }, u.project), prompt: gitlabPrompt(detail, u.project) };
		}
		case 'jira': {
			// The Issues page may not have asked yet: read the connection once here.
			sources.jira ??= await invoke<JiraViewer | null>('jira_status').catch(() => null);
			const site = sources.jira?.site;
			if (!site) throw new Error(t('adeWorktrees.link.notConnected', { service: 'Jira' }));
			if (siteHost(site) !== u.host) throw new Error(t('adeWorktrees.link.otherSite', { service: 'Jira', host: u.host }));
			const detail = await invoke<JiraIssueDetail>('jira_issue_view', { key: u.key });
			return { link: jiraLink(detail), prompt: jiraPrompt(detail) };
		}
		case 'linear': {
			if (!linear.viewer) await linear.refresh();
			if (!linear.viewer) throw new Error(t('adeWorktrees.link.notConnected', { service: 'Linear' }));
			const detail = await invoke<LinearIssueDetail>('linear_issue_view', { id: u.key });
			return { link: linearLink(detail), prompt: linearPrompt(detail) };
		}
	}
}
