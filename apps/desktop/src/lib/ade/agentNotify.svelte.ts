// Sends the system notification for agent state changes (agentNotify.ts decides), so you can work
// elsewhere while agents run: kingu.agent.notifications (on/off), .suppressWhenFocused, .events, .sound.

import { untrack } from 'svelte';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { settings } from '#lib/settings/settings.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import type { TaskStatus } from './model';
import { noticeFor, notificationSound, shouldNotify } from './agentNotify';
import { adeTasks } from './tasks.svelte';

let allowed: boolean | null = null;

export async function notify(title: string, body: string) {
	try {
		if (allowed === null) allowed = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
		if (allowed) sendNotification({ title, body, sound: notificationSound(settings.get<string>('kingu.agent.notifications.sound')) });
	} catch {
		allowed = false;
	}
}

/** Notifications on, and not suppressed for the task you are looking at. */
export function agentNotifyAllowed(slug?: string): boolean {
	const viewing = slug !== undefined && appMode.isAgents && appMode.activeSession === slug;
	return shouldNotify(
		{ enabled: settings.get<boolean>('kingu.agent.notifications') !== false, suppressWhenFocused: settings.get<boolean>('kingu.agent.notifications.suppressWhenFocused') !== false },
		document.hasFocus(),
		viewing
	);
}

export function installAgentNotifications(): () => void {
	const seen = new Map<string, TaskStatus>();
	const unregister = commands.register({
		id: 'kingu.agents.testNotification',
		title: 'ส่งการแจ้งเตือนทดสอบ (Send Test Notification)',
		category: 'Agents',
		run: () => notify('Kingu: ทดสอบการแจ้งเตือน', 'การแจ้งเตือนของ agent จะหน้าตาและเสียงแบบนี้')
	});
	const stop = $effect.root(() => {
		$effect(() => {
			const views = adeTasks.views.map((v) => ({ slug: v.meta.slug, status: v.status, title: v.meta.title, lastEvent: v.runtime?.lastEvent }));
			untrack(() => {
				const events = settings.get<string>('kingu.agent.notifications.events');
				for (const v of views) {
					const notice = agentNotifyAllowed(v.slug) ? noticeFor(seen.get(v.slug), v.status, v, events) : null;
					seen.set(v.slug, v.status);
					if (notice) void notify(notice.title, notice.body);
				}
			});
		});
	});
	return () => {
		stop();
		unregister();
	};
}
