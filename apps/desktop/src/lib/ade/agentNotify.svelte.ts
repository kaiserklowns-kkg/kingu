// Sends the system notification for agent state changes (agentNotify.ts decides), so you can work
// elsewhere while agents run: kingu.agent.notifications (on/off), .suppressWhenFocused, .events, .sound.
// Clicking one (macOS; Rust notify.rs) brings Kingu to the front and opens its task in Agents,
// like Orca's notification click that activates the worktree pane.

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { settings } from '#lib/settings/settings.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { noticeFor, noticeState, notificationSound, shouldNotify, type NoticeState } from './agentNotify';
import { adeTasks } from './tasks.svelte';

let allowed: boolean | null = null;

/** `slug`: the task a click opens. */
export async function notify(title: string, body: string, slug?: string) {
	try {
		if (allowed === null) allowed = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
		if (allowed) await invoke('agent_notify', { title, body, sound: notificationSound(settings.get<string>('kingu.agent.notifications.sound')) ?? null, slug: slug ?? null });
	} catch {
		allowed = false;
	}
}

/** A clicked notification: Agents mode with its task selected (the window is already in front). */
export function openNotifiedTask(slug: string | null) {
	if (!appMode.isAgents) appMode.setMode('agents');
	if (slug && adeTasks.list.some((t) => t.slug === slug)) adeTasks.openTask(slug);
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
	const seen = new Map<string, NoticeState>();
	const unlisten = listen<{ slug: string | null }>('agent:notification-clicked', (e) => openNotifiedTask(e.payload.slug));
	const unregister = commands.register({
		id: 'kingu.agents.testNotification',
		title: 'ส่งการแจ้งเตือนทดสอบ (Send Test Notification)',
		category: 'Agents',
		run: () => notify('Kingu: ทดสอบการแจ้งเตือน', 'การแจ้งเตือนของ agent จะหน้าตาและเสียงแบบนี้')
	});
	const stop = $effect.root(() => {
		$effect(() => {
			const views = adeTasks.views.map((v) => ({ slug: v.meta.slug, state: noticeState(v.status, v.runtime?.question), title: v.meta.title, lastEvent: v.runtime?.lastEvent }));
			untrack(() => {
				const events = settings.get<string>('kingu.agent.notifications.events');
				for (const v of views) {
					const notice = agentNotifyAllowed(v.slug) ? noticeFor(seen.get(v.slug), v.state, v, events) : null;
					seen.set(v.slug, v.state);
					if (notice) void notify(notice.title, notice.body, v.slug);
				}
			});
		});
	});
	return () => {
		stop();
		unregister();
		void unlisten.then((f) => f());
	};
}
