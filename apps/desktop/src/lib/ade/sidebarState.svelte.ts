// The ADE side bar's live inputs for sidebarView.ts: each task as a SidebarTask (agent session,
// open terminals, detached HEAD, PR state) and the ADE Sidebar settings as SidebarPrefs. Shared by
// AdeSidebar.svelte and the notifications (kingu.agent.notifications.hiddenWorkspaces).

import { settings } from '#lib/settings/settings.svelte.ts';
import { adeLayout } from './adeLayout.svelte';
import { cliSessions } from './cliSessions.svelte';
import { prStatuses } from './prStatus.svelte';
import { hiddenBy, type GroupBy, type SidebarPrefs, type SidebarTask, type SortBy } from './sidebarView';
import type { TaskView } from './model';
import { adeTasks } from './tasks.svelte';

export function sidebarPrefs(): SidebarPrefs {
	return {
		groupBy: settings.get<GroupBy>('kingu.sidebar.groupBy'),
		sortBy: settings.get<SortBy>('kingu.sidebar.sortBy'),
		showActiveOnly: settings.get<boolean>('kingu.sidebar.showActiveOnly') === true,
		hideAutomation: settings.get<boolean>('kingu.sidebar.hideAutomationTasks') === true,
		hideSleeping: settings.get<boolean>('kingu.sidebar.hideSleeping') === true,
		hideDetached: settings.get<boolean>('kingu.sidebar.hideDetachedHead') === true
	};
}

export function sidebarTask(v: TaskView): SidebarTask & { view: TaskView } {
	const slug = v.meta.slug;
	const pr = prStatuses.bySlug[slug]?.pr ?? null;
	return {
		view: v,
		slug,
		title: v.meta.title,
		status: v.status,
		updatedAt: Math.max(v.meta.updated_at, v.runtime?.updatedAt ?? 0),
		origin: v.meta.origin ?? null,
		live: !!v.runtime?.live || !!cliSessions.sessions[slug] || (adeLayout.terminals[slug]?.length ?? 0) > 0,
		detached: adeTasks.worktrees.find((w) => w.slug === slug)?.detached ?? false,
		prState: pr?.state ?? null,
		prDraft: pr?.draft
	};
}

/** Whether the side bar's filters hide this task right now. */
export function hiddenInSidebar(slug: string): boolean {
	const v = adeTasks.find(slug);
	return !!v && hiddenBy(sidebarTask(v), sidebarPrefs());
}
