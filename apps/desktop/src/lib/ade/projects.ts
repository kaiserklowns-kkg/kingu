// The added projects of the Agents side bar (Orca's repos list): every project shows its tasks
// and agent status at once, the open folder in full and the others lighter (status, unread,
// notifications; opening one switches the folder). The list itself is Rust's (projects.rs).
// Pure, so `bun test` covers it; the store is projects.svelte.ts.

import type { AgentRow } from './agentPresence';
import { withPaneAgents } from './agentPresence';
import { effectiveStatus, type TaskMeta, type TaskRuntime, type TaskView } from './model';
import type { SidebarTask } from './sidebarView';

/** One entry of Rust's `projects_list`. */
export type Project = { path: string; added_at: number };

/** The folder name: a project's label. */
export const projectName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

export type SidebarProject = { path: string; name: string; open: boolean };

/**
 * The side bar's projects in the order they were added (switching folders never moves them);
 * the open folder is one of them, first when it was never added (`kingu.projects.addOnOpen` off).
 */
export function sidebarProjects(list: readonly Project[], open: string | null): SidebarProject[] {
	const out = list.map((p) => ({ path: p.path, name: projectName(p.path), open: p.path === open }));
	if (open && !out.some((p) => p.open)) out.unshift({ path: open, name: projectName(open), open: true });
	return out;
}

/** The other projects split around the open one, so the side bar keeps the added order. */
export function aroundOpen(items: readonly SidebarProject[]): { before: SidebarProject[]; after: SidebarProject[] } {
	const i = items.findIndex((p) => p.open);
	if (i < 0) return { before: [], after: [...items] };
	return { before: items.slice(0, i), after: items.slice(i + 1) };
}

const PANE_KEY = /^ade:([0-9a-f]{8}):([^:]+):t\d+$/;

/** Terminal panes of root `tag`'s task worktrees among PTY keys: key → task slug (the folder's own panes are left out). */
export function rootPanes(keys: readonly string[], tag: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const key of keys) {
		const m = PANE_KEY.exec(key);
		if (m && m[1] === tag) out.set(key, m[2]);
	}
	return out;
}

/** What polling found of one task of another project: its launched CLI and the agents of its other panes. */
export type TaskEvidence = { cli?: TaskRuntime; rows: AgentRow[] };

/**
 * A task of another project as the side bar sees it: its agent-host run (`run`), else its CLI,
 * raised by the agents of its other terminal panes, the way runtime.svelte.ts does it for the
 * open folder.
 */
export function projectView(meta: TaskMeta, run: TaskRuntime | undefined, ev: TaskEvidence | undefined): TaskView {
	const runtime = withPaneAgents(meta.slug, run ?? ev?.cli, ev?.rows ?? []);
	return { meta, runtime, status: effectiveStatus(meta, runtime) };
}

/** A task of another project for the side bar's filters and sort (no PR state is read for them). */
export function projectSidebarTask(v: TaskView, detached: boolean): SidebarTask {
	return {
		slug: v.meta.slug,
		title: v.meta.title,
		status: v.status,
		updatedAt: Math.max(v.meta.updated_at, v.runtime?.updatedAt ?? 0),
		origin: v.meta.origin ?? null,
		live: !!v.runtime?.live,
		detached,
		prState: null
	};
}

/** Notification state is kept per project and task (two projects can both have a `fix-login`). */
export const noticeKey = (root: string, slug: string) => `${root}\u0000${slug}`;
/** The project of a `noticeKey`. */
export const noticeRoot = (key: string) => key.slice(0, Math.max(0, key.indexOf('\u0000')));

/** Agent-host runs the title bar counts apart: of folders that are neither open nor an added project (those show as views). */
export function strayRuns<R extends { root: string }>(runs: readonly R[], open: string | null, added: ReadonlySet<string>): R[] {
	return runs.filter((r) => r.root !== open && !added.has(r.root));
}

/**
 * The title bar's "needs you" share of other projects' tasks: permission prompts of their CLIs
 * (agent-host prompts are counted by the agents store already) and tasks to review.
 */
export function projectBadge(views: readonly { view: TaskView; hostRun: boolean }[]): number {
	let n = 0;
	for (const { view, hostRun } of views) {
		if (view.status === 'review' || view.status === 'failed') n++;
		else if (view.status === 'waiting' && !hostRun) n += Math.max(1, view.runtime?.pendingPermissions ?? 0);
	}
	return n;
}

/** A folder switch for opening a task is done once the tasks of that folder are loaded. */
export const pendingDue = (pending: { root: string } | null, loadedRoot: string | null) => !!pending && pending.root === loadedRoot;
