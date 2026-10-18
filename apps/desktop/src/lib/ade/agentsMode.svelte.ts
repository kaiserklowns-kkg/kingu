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
import { adeLayout, PRIMARY } from './adeLayout.svelte';
import { installRightSidebar } from './rightSidebar.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';

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
	if (slug) adeLayout.show(slug);
}

/**
 * Open in Editor: back to the workbench, showing the active session's task page and the file (or
 * task diff) of the ADE's active tab, else the task's first changed worktree file.
 */
export function openEditor() {
	const file = adeLayout.activeFile();
	appMode.setMode('workbench');
	const slug = appMode.activeSession;
	const view = slug ? adeTasks.find(slug) : undefined;
	if (slug && view) editors.open(taskKey(slug), { preview: false });
	if (file) {
		editors.open(file, { preview: false });
		return;
	}
	const first = slug && view ? view.stat?.files.find((f) => f.status !== 'D') : undefined;
	if (slug && first) editors.open(`${worktreeDir(slug)}/${first.path}`, { preview: true });
}

export function toggleAgentsMode() {
	systemSettings.close();
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
		onAccept: (item) => adeLayout.show(item.id)
	});
}

/** New Session: clears the active session so the Agents layout shows its centred composer. */
export function newSession() {
	adeLayout.show(PRIMARY);
	adeLayout.select(PRIMARY, 'main');
	adeTasks.composing = false;
	appMode.composeRequest++;
}

/** Registers the mode commands and follows editor opens out of the Agents layout. */
export function installAgentsMode(): () => void {
	let lastActive = untrack(() => editors.active);
	const stop = $effect.root(() => {
		// Opening a file or diff in the IDE (Quick Open, Go to Definition) while in the Agents layout
		// shows the workbench. Files opened from the Agents layout itself stay there as its tabs.
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
		commands.register({ id: 'kingu.agents.sessionBack', title: 'Previous Session', category: 'Agents', when: () => appMode.isAgents && appMode.canGoBack, run: () => appMode.back() }),
		commands.register({ id: 'kingu.agents.sessionForward', title: 'Next Session', category: 'Agents', when: () => appMode.isAgents && appMode.canGoForward, run: () => appMode.forward() })
	];
	const uninstallRight = installRightSidebar();
	return () => {
		stop();
		unregister.forEach((u) => u());
		uninstallRight();
	};
}

function openAgentsNew() {
	openAgents();
	newSession();
}
