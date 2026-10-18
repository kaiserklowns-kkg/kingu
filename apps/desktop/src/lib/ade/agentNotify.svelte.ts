// Sends the system notification for agent state changes (agentNotify.ts decides) while the window
// is not focused, so you can work elsewhere while agents run. Off with kingu.agent.notifications.

import { untrack } from 'svelte';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { settings } from '#lib/settings/settings.svelte.ts';
import type { TaskStatus } from './model';
import { noticeFor } from './agentNotify';
import { adeTasks } from './tasks.svelte';

let allowed: boolean | null = null;

export async function notify(title: string, body: string) {
	try {
		if (allowed === null) allowed = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
		if (allowed) sendNotification({ title, body });
	} catch {
		allowed = false;
	}
}

export function installAgentNotifications(): () => void {
	const seen = new Map<string, TaskStatus>();
	return $effect.root(() => {
		$effect(() => {
			const views = adeTasks.views.map((v) => ({ slug: v.meta.slug, status: v.status, title: v.meta.title, lastEvent: v.runtime?.lastEvent }));
			untrack(() => {
				const quiet = document.hasFocus() || settings.get<boolean>('kingu.agent.notifications') === false;
				for (const v of views) {
					const notice = quiet ? null : noticeFor(seen.get(v.slug), v.status, v);
					seen.set(v.slug, v.status);
					if (notice) void notify(notice.title, notice.body);
				}
			});
		});
	});
}
