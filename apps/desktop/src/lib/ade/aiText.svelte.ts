// Runs the source-control AI (Orca's commit-message / PR-details generation): Rust reads the
// staged or branch changes, the webview builds the prompt (aiText.ts), and Rust runs the agent
// that the user's settings name (kingu.git.ai.*), read-only and headless, in the worktree.

import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commitMessage, commitPrompt, prDetails, prPrompt, type CommitContext, type PrContext } from './aiText.ts';
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
export async function generatePrDetails(slug: string, base: string, template: string | null): Promise<{ title: string; body: string }> {
	if (aiText.busy[slug]) throw new Error(t('ade.aiText.busy'));
	aiText.busy[slug] = 'pr';
	try {
		const ctx = await invoke<PrContext>('ai_pr_context', { slug, base });
		const answer = await invoke<string>('ai_generate', { slug, prompt: prPrompt(ctx, base, template, settings.get<string>('kingu.git.ai.prInstructions')) });
		const details = prDetails(answer);
		if (!details) throw new Error(t('ade.aiText.noPrTitle'));
		return details;
	} finally {
		delete aiText.busy[slug];
	}
}

/** The repository's pull request template in the task worktree (`kingu.pr.useTemplate`), or null. */
export const prTemplate = (slug: string) => invoke<string | null>('ai_pr_template', { slug }).catch(() => null);
