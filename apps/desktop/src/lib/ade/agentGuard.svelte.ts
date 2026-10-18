// Asks before a git action runs in a worktree whose agent is working (pure parts: agentGuard.ts).

import { ask } from '#lib/workbench/messageBox.ts';
import { t } from '#lib/i18n/index.ts';
import { runtime } from './runtime.svelte';
import { workingTask } from './agentGuard';

/**
 * True when none of `slugs` has a working agent (timeline turn or CLI hook status), or the user
 * chose to continue in the native message box. VS Code's Agents window keeps a working session's
 * worktree to the agent; Kingu lets the user override, knowingly.
 */
export async function confirmAgentIdle(slugs: readonly string[], action: string): Promise<boolean> {
	const busy = workingTask(slugs, (s) => runtime.isWorking(s));
	if (!busy) return true;
	return ask(t('adeTasks.tasks.agentWorkingAsk', { slug: busy, action }), {
		title: t('adeTasks.tasks.agentWorkingTitle'),
		kind: 'warning',
		okLabel: t('adeTasks.tasks.continueAnyway'),
		cancelLabel: t('common.cancel')
	});
}
