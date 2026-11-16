// Orca's "Send to…" menu (editor/review-note-delivery/ReviewNotesSendMenuContent.tsx): a prompt
// made from review notes, a failed commit or push, or conflicts goes to an agent the user picks —
// the task's own agent CLI, another agent running in one of its terminal panes, its agent's
// composer without sending (Orca's add-to-chat), a new task, or the clipboard. With only the
// task's agent to choose, it goes straight there.

import { invoke } from '@tauri-apps/api/core';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { pasteText } from './agentProfiles';
import { cliName, cliOf } from './agentCli';
import { cliSessions } from './cliSessions.svelte';
import { paneAgents } from './paneAgents.svelte';
import { adeTasks } from './tasks.svelte';
import { targetChoices, type TargetChoice } from './agentTargets';

async function typeInto(key: string, prompt: string, submit: boolean): Promise<boolean> {
	try {
		await invoke('pty_write', { key, data: pasteText(prompt) });
		if (submit) {
			await new Promise((r) => setTimeout(r, 300));
			await invoke('pty_write', { key, data: '\r' });
		}
		return true;
	} catch (e) {
		status.flash(t('ade.cli.sendFailed', { error: String(e) }), 8000);
		return false;
	}
}

async function copy(prompt: string, what: string): Promise<boolean> {
	const ok = await navigator.clipboard.writeText(prompt).then(
		() => true,
		() => false
	);
	status.flash(ok ? t('adeTasks.tasks.promptCopied', { what }) : t('adeTasks.tasks.promptCopyFailed', { what }), 8000);
	return ok;
}

/**
 * Sends `prompt` (described as `what`) to the agent the user picks for task `slug` ('' = the
 * folder). Returns how it went out, or null when it was cancelled or failed.
 */
export async function sendPrompt(slug: string, prompt: string, what: string): Promise<TargetChoice['kind'] | null> {
	const meta = slug ? adeTasks.find(slug)?.meta : undefined;
	const cli = meta ? cliOf(meta.agent) : null;
	const choices = targetChoices({
		task: meta ? { agent: cli ? cliName(cli) : 'agent', running: cliSessions.has(slug) } : null,
		panes: slug ? paneAgents.rows(slug).map((r) => ({ id: r.id, agent: r.agent, state: r.state, message: r.message })) : []
	});
	let pick: TargetChoice | undefined = choices.length === 1 ? choices[0] : undefined;
	if (!pick) {
		const item = await quick.choose({
			placeholder: t('ade.target.placeholder', { what }),
			items: choices.map((c) => ({ id: c.id, label: label(c), description: description(c), agent: c.kind === 'pane' ? (c.agent ?? undefined) : undefined }))
		});
		pick = choices.find((c) => c.id === item?.id);
	}
	if (!pick) return null;
	const ok = await (async () => {
		switch (pick.kind) {
			case 'task':
				return adeTasks.sendToAgent(slug, prompt, what);
			case 'taskDraft': {
				const key = cliSessions.key(slug);
				const done = !!key && (await typeInto(key, prompt, false));
				if (done) {
					adeTasks.openTask(slug);
					status.flash(t('ade.target.drafted', { what }));
				}
				return done;
			}
			case 'pane': {
				const done = await typeInto(pick.id.slice('pane:'.length), prompt, true);
				if (done) status.flash(t('adeTasks.tasks.sentToAgent', { what }));
				return done;
			}
			case 'newTask':
				adeTasks.startCreate({ title: what, prompt, base: '' });
				return true;
			case 'copy':
				return copy(prompt, what);
		}
	})();
	return ok ? pick.kind : null;
}

/**
 * Orca's Design Mode hand-off: into the task agent's composer without sending, so the user adds
 * what to change; with no agent running there, the usual "Send to…" choices.
 */
export async function draftPrompt(slug: string, prompt: string, what: string): Promise<boolean> {
	const key = slug ? cliSessions.key(slug) : null;
	if (key && (await typeInto(key, prompt, false))) {
		adeTasks.openTask(slug);
		status.flash(t('ade.target.drafted', { what }));
		return true;
	}
	return (await sendPrompt(slug, prompt, what)) !== null;
}

function label(c: TargetChoice): string {
	switch (c.kind) {
		case 'task':
			return t('ade.target.task', { agent: c.agent ?? 'agent' });
		case 'taskDraft':
			return t('ade.target.taskDraft', { agent: c.agent ?? 'agent' });
		case 'pane':
			return t('ade.target.pane', { agent: c.agent ?? 'agent' });
		case 'newTask':
			return t('ade.target.newTask');
		case 'copy':
			return t('ade.target.copy');
	}
}

function description(c: TargetChoice): string {
	if (c.kind === 'task') return c.running ? t('ade.target.running') : t('ade.target.starts');
	if (c.kind === 'pane') return [c.state, c.message].filter(Boolean).join(' · ');
	return '';
}
