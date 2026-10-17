// Agents mode: switching the window between the workbench (IDE) and the Agents layout (ADE), the
// session picker of the Agents title bar, and the commands of both title bars. VS Code binds
// Cmd/Ctrl+Shift+A to "Open Agents Window" / "Open VS Code Window"; here one command toggles.

import { untrack } from 'svelte';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import type { AgentsFilter } from '#lib/workbench/titlebar.ts';
import { COLUMNS, STATUS_LABEL } from './model';
import { BOARD_KEY, slugOfTaskKey, taskKey, worktreeDir } from './keys';
import { adeTasks } from './tasks.svelte';

/** The session to show when entering the Agents layout: the task tab in front, else the last one, else the first needing attention. */
function initialSession(): string | null {
	const fromTab = editors.active ? slugOfTaskKey(editors.active) : null;
	if (fromTab && adeTasks.find(fromTab)) return fromTab;
	if (appMode.activeSession && adeTasks.find(appMode.activeSession)) return appMode.activeSession;
	return adeTasks.groups.attention[0]?.meta.slug ?? adeTasks.groups.active[0]?.meta.slug ?? adeTasks.views[0]?.meta.slug ?? null;
}

/** Open in Agents: the Agents layout, optionally filtered to one status group. */
export function openAgents(filter: AgentsFilter = 'all') {
	appMode.filter = filter;
	if (filter !== 'all') appMode.sessionsVisible = true;
	const slug = filter === 'all' ? initialSession() : (adeTasks.filtered(filter)[0]?.meta.slug ?? initialSession());
	appMode.setMode('agents');
	if (slug) appMode.openSession(slug);
}

/** Open in Editor: back to the workbench, showing the active session's task page and its first changed worktree file. */
export function openEditor() {
	appMode.setMode('workbench');
	const slug = appMode.activeSession;
	const view = slug ? adeTasks.find(slug) : undefined;
	if (!slug || !view) return;
	const first = view.stat?.files.find((f) => f.status !== 'D');
	editors.open(taskKey(slug), { preview: false });
	if (first) editors.open(`${worktreeDir(slug)}/${first.path}`, { preview: true });
}

export function toggleAgentsMode() {
	if (appMode.isAgents) openEditor();
	else openAgents();
}

/** The session pill: every task of the folder, grouped รอคุณ / กำลังทำ / เสร็จแล้ว. */
export function pickSession() {
	const items = COLUMNS.flatMap((col) =>
		adeTasks.groups[col.id].map((v, i) => ({
			id: v.meta.slug,
			label: v.meta.title,
			description: `${STATUS_LABEL[v.status]} · kingu/${v.meta.slug}`,
			separator: i === 0 ? col.label : undefined
		}))
	);
	if (!items.length) {
		status.flash(workspace.root ? 'ยังไม่มีงาน: กด "งานใหม่" เพื่อเริ่ม session' : 'เปิดโฟลเดอร์ก่อน');
		return;
	}
	quick.pick({
		placeholder: 'เลือก session (งานของ agent)',
		items,
		activeId: appMode.activeSession ?? undefined,
		onAccept: (item) => appMode.openSession(item.id)
	});
}

/** New Session: the sessions side bar with the New Task form open. */
export function newSession() {
	appMode.sessionsVisible = true;
	adeTasks.composing = true;
}

/** Registers the mode commands and follows editor opens out of the Agents layout. */
export function installAgentsMode(): () => void {
	let lastActive = untrack(() => editors.active);
	const stop = $effect.root(() => {
		// Opening a file or diff (Quick Open, a review file) while in the Agents layout shows the workbench.
		$effect(() => {
			const active = editors.active;
			untrack(() => {
				if (active !== lastActive && active && appMode.isAgents && !slugOfTaskKey(active) && active !== BOARD_KEY) appMode.setMode('workbench');
				lastActive = active;
			});
		});
		// A removed task is no longer the active session.
		$effect(() => {
			const slug = appMode.activeSession;
			if (slug && adeTasks.loaded && !adeTasks.find(slug)) untrack(() => appMode.forget(slug));
		});
	});
	const hasRoot = () => workspace.root !== null;
	const unregister = [
		commands.register({
			id: 'workbench.action.toggleAgentsMode',
			title: 'Toggle Agents / Editor (Open in Agents)',
			category: 'View',
			key: 'cmd+shift+a',
			run: toggleAgentsMode
		}),
		commands.register({ id: 'kingu.agents.openInAgents', title: 'Open in Agents', category: 'Agents', when: () => !appMode.isAgents, run: () => openAgents() }),
		commands.register({ id: 'kingu.agents.openInEditor', title: 'Open in Editor', category: 'Agents', when: () => appMode.isAgents, run: openEditor }),
		commands.register({ id: 'kingu.agents.pickSession', title: 'Switch Session...', category: 'Agents', when: hasRoot, run: pickSession }),
		commands.register({ id: 'kingu.agents.newSession', title: 'New Session', category: 'Agents', when: hasRoot, run: () => (appMode.isAgents ? newSession() : openAgentsNew()) }),
		commands.register({ id: 'kingu.agents.toggleSessions', title: 'Toggle Sessions Side Bar', category: 'Agents', when: () => appMode.isAgents, run: () => (appMode.sessionsVisible = !appMode.sessionsVisible) }),
		commands.register({ id: 'kingu.agents.toggleChangesPanel', title: 'Toggle Changes Panel', category: 'Agents', when: () => appMode.isAgents, run: () => (appMode.panelVisible = !appMode.panelVisible) }),
		commands.register({ id: 'kingu.agents.sessionBack', title: 'Previous Session', category: 'Agents', when: () => appMode.isAgents && appMode.canGoBack, run: () => appMode.back() }),
		commands.register({ id: 'kingu.agents.sessionForward', title: 'Next Session', category: 'Agents', when: () => appMode.isAgents && appMode.canGoForward, run: () => appMode.forward() })
	];
	return () => {
		stop();
		unregister.forEach((u) => u());
	};
}

function openAgentsNew() {
	openAgents();
	newSession();
}
