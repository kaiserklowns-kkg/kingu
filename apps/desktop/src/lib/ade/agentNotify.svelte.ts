// Sends the system notification for agent state changes (agentNotify.ts decides), so you can work
// elsewhere while agents run: kingu.agent.notifications (on/off), .suppressWhenFocused, .events, .sound.
// Clicking one (macOS; Rust notify.rs) brings Kingu to the front and opens its task in Agents,
// like Orca's notification click that activates the worktree pane. Agent chats notify too (a
// permission prompt, a question, a finished or failed turn) while the window is unfocused; a click
// opens the chat in the chat panel.

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { settings } from '#lib/settings/settings.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { chatNoticeFor, noticeFor, noticeState, notificationSound, shouldNotify, type NoticeState } from './agentNotify';
import { chats } from '#lib/agent/chats.svelte.ts';
import { openChat } from '#lib/agent/chatCommands.svelte.ts';
import { adeTasks } from './tasks.svelte';
import { hiddenInSidebar } from './sidebarState.svelte';
import { t } from '#lib/i18n/index.ts';

let allowed: boolean | null = null;

/** `slug`: the task a click opens; `chatId`: the agent chat it opens instead. */
export async function notify(title: string, body: string, slug?: string, chatId?: string) {
	try {
		if (allowed === null) allowed = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
		if (allowed)
			await invoke('agent_notify', { title, body, sound: notificationSound(settings.get<string>('kingu.agent.notifications.sound')) ?? null, slug: slug ?? null, chatId: chatId ?? null });
	} catch {
		allowed = false;
	}
}

/** A clicked notification: Agents mode with its task selected (the window is already in front). */
export function openNotifiedTask(slug: string | null) {
	if (!appMode.isAgents) appMode.setMode('agents');
	if (slug && adeTasks.list.some((t) => t.slug === slug)) adeTasks.openTask(slug);
}

/** A clicked chat notification: the workbench's chat panel showing that chat. */
export function openNotifiedChat(id: string) {
	openChat(id);
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
	const unlisten = listen<{ slug: string | null; chat_id?: string | null }>('agent:notification-clicked', (e) =>
		e.payload.chat_id ? openNotifiedChat(e.payload.chat_id) : openNotifiedTask(e.payload.slug)
	);
	// Agent chats of the open folder: only while the window is unfocused (with Suppress While Focused on, the default).
	const offChats = chats.onEvent((id, ev) => {
		if (ev.kind !== 'permission_request' && ev.kind !== 'result') return;
		const meta = chats.get(id);
		if (!meta) return;
		const enabled = settings.get<boolean>('kingu.agent.notifications') !== false;
		const suppressWhenFocused = settings.get<boolean>('kingu.agent.notifications.suppressWhenFocused') !== false;
		if (!shouldNotify({ enabled, suppressWhenFocused }, document.hasFocus(), true)) return;
		const notice = chatNoticeFor(ev, meta.title, settings.get<string>('kingu.agent.notifications.events'));
		if (notice) void notify(notice.title, notice.body, undefined, id);
	});
	const unregister = commands.register({
		id: 'kingu.agents.testNotification',
		title: 'Send Test Notification',
		category: 'Agents',
		run: () => notify(t('ade.notify.testTitle'), t('ade.notify.testBody'))
	});
	const stop = $effect.root(() => {
		$effect(() => {
			const views = adeTasks.views.map((v) => ({ slug: v.meta.slug, state: noticeState(v.status, v.runtime?.question), title: v.meta.title, lastEvent: v.runtime?.lastEvent }));
			untrack(() => {
				const events = settings.get<string>('kingu.agent.notifications.events');
				// kingu.agent.notifications.hiddenWorkspaces off: tasks the side bar's filters hide stay quiet (Orca's notifyHiddenWorkspaces).
				const quietHidden = settings.get<boolean>('kingu.agent.notifications.hiddenWorkspaces') === false;
				for (const v of views) {
					const notice = agentNotifyAllowed(v.slug) && !(quietHidden && hiddenInSidebar(v.slug)) ? noticeFor(seen.get(v.slug), v.state, v, events) : null;
					seen.set(v.slug, v.state);
					if (notice) void notify(notice.title, notice.body, v.slug);
				}
			});
		});
	});
	return () => {
		stop();
		offChats();
		unregister();
		void unlisten.then((f) => f());
	};
}
