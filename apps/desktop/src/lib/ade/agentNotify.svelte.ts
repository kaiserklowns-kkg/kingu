// Sends the system notification for agent state changes (agentNotify.ts decides), so you can work
// elsewhere while agents run: kingu.agent.notifications (on/off), .suppressWhenFocused, .events, .sound.
// Clicking one (macOS; Rust notify.rs) brings Kingu to the front and opens its task in Agents,
// like Orca's notification click that activates the worktree pane. Agent chats notify too (a
// permission prompt, a question, a finished or failed turn) as chat.notifyWindowOn* say; a click
// opens the chat in the chat panel. The other added projects' tasks notify too (projects.svelte.ts);
// a click on one switches to its folder and opens the task.

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { listenWindow } from '#lib/workbench/windowEvents.ts';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { settings } from '#lib/settings/settings.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { chatNoticeFor, noticeFor, noticeState, notificationSound, shouldNotify, type NoticeState } from './agentNotify';
import { chats } from '#lib/agent/chats.svelte.ts';
import { openChat } from '#lib/agent/chatCommands.svelte.ts';
import { chatNotifies } from '#lib/agent/chatSettings.ts';
import { requestAttention } from '#lib/agent/chatSettings.svelte.ts';
import { adeTasks } from './tasks.svelte';
import { hiddenInSidebar, sidebarPrefs } from './sidebarState.svelte';
import { projects } from './projects.svelte';
import { noticeKey, noticeRoot, projectName, projectSidebarTask } from './projects';
import { hiddenBy } from './sidebarView';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { t } from '#lib/i18n/index.ts';

let allowed: boolean | null = null;

/** `slug`: the task a click opens; `chatId`: the agent chat it opens instead; `root`: the task's project when it is not the open folder. */
export async function notify(title: string, body: string, slug?: string, chatId?: string, root?: string) {
	try {
		if (allowed === null) allowed = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
		if (allowed)
			await invoke('agent_notify', {
				title,
				body,
				sound: notificationSound(settings.get<string>('kingu.agent.notifications.sound')) ?? null,
				slug: slug ?? null,
				chatId: chatId ?? null,
				root: root ?? null
			});
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
	const unlisten = listenWindow<{ slug: string | null; chat_id?: string | null; root?: string | null }>('agent:notification-clicked', (e) => {
		const { slug, chat_id, root } = e.payload;
		if (chat_id) return openNotifiedChat(chat_id);
		if (root && root !== workspace.root && projects.added.has(root)) {
			if (!appMode.isAgents) appMode.setMode('agents');
			return void projects.open(root, slug ?? undefined);
		}
		openNotifiedTask(slug);
	});
	// Agent chats of the open folder: VS Code's chat.notifyWindowOnConfirmation (approvals,
	// questions) and chat.notifyWindowOnResponseReceived (finished or failed turns) decide, by
	// default while the window is unfocused; kingu.agent.notifications off silences them too. An
	// unfocused window also asks for attention (the Dock icon bounces once).
	const offChats = chats.onEvent((id, ev) => {
		if (ev.kind !== 'permission_request' && ev.kind !== 'result') return;
		const meta = chats.get(id);
		if (!meta || settings.get<boolean>('kingu.agent.notifications') === false) return;
		const focused = document.hasFocus();
		if (!chatNotifies(ev, (k) => settings.get(k), focused)) return;
		const notice = chatNoticeFor(ev, meta.title);
		if (!notice) return;
		void notify(notice.title, notice.body, undefined, id);
		if (!focused) requestAttention();
	});
	const unregister = commands.register({
		id: 'kingu.agents.testNotification',
		title: 'Send Test Notification',
		category: 'Agents',
		run: () => notify(t('ade.notify.testTitle'), t('ade.notify.testBody'))
	});
	const stop = $effect.root(() => {
		// A task starts over when its folder is opened or left: the open folder and the other projects
		// see it through different evidence (a title, output timing), and a state change that is only
		// a change of evidence must not notify.
		let seenRoot: string | null = null;
		$effect(() => {
			const root = workspace.root ?? '';
			const views = adeTasks.views.map((v) => ({ slug: v.meta.slug, state: noticeState(v.status, v.runtime?.question), title: v.meta.title, lastEvent: v.runtime?.lastEvent }));
			untrack(() => {
				if (seenRoot !== root) seen.clear();
				seenRoot = root;
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
		// The other added projects: never on screen, so only "notifications on" decides.
		const seenOther = new Map<string, NoticeState>();
		$effect(() => {
			// A project starts being watched once its tasks and its first poll are in: what it showed before is no change.
			const views = projects.all.filter(({ root }) => projects.ready(root)).map(({ root, view: v }) => ({
				root,
				slug: v.meta.slug,
				state: noticeState(v.status, v.runtime?.question),
				title: t('adeProjects.noticeTask', { task: v.meta.title, project: projectName(root) }),
				lastEvent: v.runtime?.lastEvent,
				task: projectSidebarTask(v, projects.worktrees(root).find((w) => w.slug === v.meta.slug)?.detached ?? false)
			}));
			const others = new Set(projects.others);
			untrack(() => {
				for (const key of seenOther.keys()) if (!others.has(noticeRoot(key))) seenOther.delete(key);
				const events = settings.get<string>('kingu.agent.notifications.events');
				const enabled = settings.get<boolean>('kingu.agent.notifications') !== false;
				const quietHidden = settings.get<boolean>('kingu.agent.notifications.hiddenWorkspaces') === false;
				const prefs = sidebarPrefs();
				for (const v of views) {
					const key = noticeKey(v.root, v.slug);
					const notice = enabled && !(quietHidden && hiddenBy(v.task, prefs)) ? noticeFor(seenOther.get(key), v.state, v, events) : null;
					seenOther.set(key, v.state);
					if (notice) void notify(notice.title, notice.body, v.slug, undefined, v.root);
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
