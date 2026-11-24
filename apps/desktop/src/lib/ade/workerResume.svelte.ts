// Resume workers after a restart (Orca 1.4.272's terminal-worker restart offers,
// src/renderer/src/components/native-chat-recovery/offers/native-chat-resume-on-restart-store.ts
// `noteTerminalWorkerRestartOffers`): a task agent CLI whose terminal did not survive Kingu's exit
// (a reboot, or the terminal daemon gone) is offered back — Reopen starts it again in its worktree,
// continuing its session (attempts.resume). With kingu.chat.resumeWorkOnRestart on it is reopened
// at once. cliSessions.load reports the sessions it found gone.

import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workersToReopen } from './workerResume.ts';

/** Waits (bounded) for the folder's tasks, then reopens or offers the lost workers. */
export async function offerLostWorkers(gone: readonly string[]) {
	if (!gone.length) return;
	const { adeTasks } = await import('./tasks.svelte.ts');
	const { cliSessions } = await import('./cliSessions.svelte.ts');
	const { attempts } = await import('./attempts.svelte.ts');
	for (let i = 0; i < 100 && !adeTasks.loaded; i++) await new Promise((r) => setTimeout(r, 100));
	const slugs = workersToReopen(
		gone.filter((s) => !cliSessions.has(s)),
		adeTasks.list.map((m) => ({ slug: m.slug, status: m.status }))
	);
	if (!slugs.length) return;
	const reopen = async () => {
		let n = 0;
		for (const slug of slugs) if (!cliSessions.has(slug) && (await attempts.resume(slug))) n++;
		if (n) status.flash(t('chatResume.reopened', { count: n }));
	};
	if (settings.get<boolean>('kingu.chat.resumeWorkOnRestart') === true) return reopen();
	const handle = notifications.info(t('chatResume.workers', { count: slugs.length }), {
		sticky: true,
		actions: [{ label: t('chatResume.reopen'), run: () => (handle.close(), void reopen()) }]
	});
}
