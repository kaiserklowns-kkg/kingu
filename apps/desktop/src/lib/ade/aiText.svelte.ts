// Runs the source-control AI (Orca's commit-message / PR-details generation): Rust reads the
// staged or branch changes, the webview builds the prompt (aiText.ts), and Rust runs the agent
// that the user's settings name (kingu.git.ai.*), read-only and headless, in the worktree.

import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commitMessage, commitPrompt, prFields, prPrompt, type PrIssue, type CommitContext, type PrContext } from './aiText.ts';
import type { IssueLink } from './model';
import { gitlabHost } from './trackerApi';
import { t } from '#lib/i18n/index.ts';

export const aiTextEnabled = () => settings.get<boolean>('kingu.git.ai.enabled') !== false;

/** Which worktree is generating (`''` the folder), so a second click waits. */
class AiTextState {
	busy = $state<Record<string, 'commit' | 'pr'>>({});
}
export const aiText = new AiTextState();

/**
 * A commit message for the staged changes of task `slug` (null: the open folder). Throws a
 * message for the user when nothing is staged or the agent failed.
 */
export async function generateCommitMessage(slug: string | null): Promise<string> {
	const key = slug ?? '';
	if (aiText.busy[key]) throw new Error(t('ade.aiText.busy'));
	aiText.busy[key] = 'commit';
	try {
		const ctx = await invoke<CommitContext>('ai_commit_context', { slug });
		if (!ctx.summary.trim()) throw new Error(t('ade.aiText.nothingStaged'));
		const answer = await invoke<string>('ai_generate', { slug, prompt: commitPrompt(ctx, settings.get<string>('kingu.git.ai.commitInstructions')) });
		const message = commitMessage(answer);
		if (!message) throw new Error(t('ade.aiText.noCommitMessage'));
		return message;
	} finally {
		delete aiText.busy[key];
	}
}

/** The PR title and description for task `slug` merging into `base`, filling `template` when given. */
/** The task's linked issue for the PR prompt (Orca's linked issue), without its description. */
export function prIssueOf(issue: IssueLink | null | undefined, description = ''): PrIssue | null {
	if (!issue) return null;
	return { provider: issue.provider ?? 'github', number: issue.number, key: issue.key && issue.provider !== 'github' ? issue.key : undefined, title: issue.title, description };
}

/**
 * Orca's `linkedIssueDetails.description`: the issue's body from its tracker (the folder's GitHub
 * repository through gh, Linear, Jira, GitLab). '' when it cannot be read; the draft goes on without it.
 */
export async function issueDescription(issue: IssueLink): Promise<string> {
	const p = issue.provider ?? 'github';
	const body = (v: { body?: string; description?: string } | null) => v?.body ?? v?.description ?? '';
	try {
		if (p === 'github' && !issue.key) return body(await invoke('gh_issue_view', { number: issue.number }));
		if (p === 'linear' && issue.key) return body(await invoke('linear_issue_view', { id: issue.key }));
		if (p === 'jira' && issue.key) return body(await invoke('jira_issue_view', { key: issue.key }));
		if (p === 'gitlab' && issue.key) return body(await invoke('gitlab_issue_view', { host: gitlabHost(), key: issue.key }));
	} catch {
		// Not connected, offline or gone: no description.
	}
	return '';
}

/**
 * Orca's PR draft: title, body (Problem / Solution first), base and draft from the branch's
 * changes, keeping what the form already holds and naming the linked issue.
 */
export async function generatePrDetails(
	slug: string,
	base: string,
	template: string | null,
	current: { title?: string; body?: string; draft?: boolean; issue?: IssueLink | null } = {}
): Promise<{ title: string; body: string; base: string; draft: boolean }> {
	if (aiText.busy[slug]) throw new Error(t('ade.aiText.busy'));
	aiText.busy[slug] = 'pr';
	try {
		const [ctx, description] = await Promise.all([invoke<PrContext>('ai_pr_context', { slug, base }), current.issue ? issueDescription(current.issue) : Promise.resolve('')]);
		const prompt = prPrompt(ctx, {
			base,
			currentTitle: current.title ?? '',
			currentBody: current.body ?? '',
			currentDraft: current.draft ?? false,
			issue: prIssueOf(current.issue, description),
			template,
			instructions: settings.get<string>('kingu.git.ai.prInstructions')
		});
		const answer = await invoke<string>('ai_generate', { slug, prompt });
		const details = prFields(answer, base);
		if (!details) throw new Error(t('ade.aiText.noPrTitle'));
		return details;
	} finally {
		delete aiText.busy[slug];
	}
}

/** The repository's pull request template in the task worktree (`kingu.pr.useTemplate`), or null. */
export const prTemplate = (slug: string) => invoke<string | null>('ai_pr_template', { slug }).catch(() => null);
