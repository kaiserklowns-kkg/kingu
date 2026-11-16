// The added projects of the Agents side bar (Orca's repos list): every project shows its tasks
// and agent status at once, the open folder in full and the others lighter (status, unread,
// notifications; opening one switches the folder). The list itself is Rust's (projects.rs).
// Pure, so `bun test` covers it; the store is projects.svelte.ts.

import type { AgentRow } from './agentPresence';
import { withPaneAgents } from './agentPresence';
import { effectiveStatus, type TaskMeta, type TaskRuntime, type TaskView } from './model';
import type { SidebarTask } from './sidebarView';

/** One entry of Rust's `projects_list`. */
export type Project = { path: string; added_at: number; group?: string | null; group_order?: number | null };

/** Orca's ProjectGroup (projects.rs): a named set of projects in the side bar. */
export type ProjectGroup = {
	id: string;
	name: string;
	parent_path: string | null;
	parent_group_id: string | null;
	created_from: string;
	tab_order: number;
	is_collapsed: boolean;
	color: string | null;
};

/** One group in the side bar: its projects and how deep it sits (sub-groups are indented). */
export type GroupSection = { group: ProjectGroup; depth: number; projects: SidebarProject[] };

/**
 * The side bar's project groups (Orca's project-groups.ts order): groups by `tab_order` then name,
 * each followed by its sub-groups; inside one, projects by `group_order`, then their place in the
 * list (Orca's `getEffectiveProjectGroupManualRank`). The open folder is left out (it keeps its
 * own place at the top), as is any project whose group is gone.
 */
export function groupSections(items: readonly SidebarProject[], list: readonly Project[], groups: readonly ProjectGroup[]): GroupSection[] {
	const byPath = new Map(list.map((p, i) => [p.path, { p, i }]));
	const known = new Set(groups.map((g) => g.id));
	const sorted = [...groups].sort((a, b) => a.tab_order - b.tab_order || a.name.localeCompare(b.name));
	const out: GroupSection[] = [];
	const seen = new Set<string>();
	const walk = (parent: string | null, depth: number) => {
		for (const g of sorted) {
			const p = g.parent_group_id && known.has(g.parent_group_id) && g.parent_group_id !== g.id ? g.parent_group_id : null;
			if (p !== parent || seen.has(g.id)) continue;
			seen.add(g.id);
			const rank = (path: string) => {
				const e = byPath.get(path);
				const o = e?.p.group_order;
				return typeof o === 'number' && Number.isFinite(o) ? o : (e?.i ?? 0) * 1000;
			};
			const projects = items.filter((it) => !it.open && byPath.get(it.path)?.p.group === g.id).sort((a, b) => rank(a.path) - rank(b.path));
			out.push({ group: g, depth, projects });
			walk(g.id, depth + 1);
		}
	};
	walk(null, 0);
	return out;
}

/** Paths that a group section shows (so the ungrouped list skips them). */
export function groupedPaths(sections: readonly GroupSection[]): Set<string> {
	return new Set(sections.flatMap((s) => s.projects.map((p) => p.path)));
}

/** The folder name: a project's label. */
export const projectName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

export type SidebarProject = { path: string; name: string; open: boolean };
/** Orca's `ui.projectOrderBy`: `manual` is the list's own order (drag a project header), `recent` the latest activity first. */
export type ProjectOrder = 'manual' | 'recent';

/**
 * The side bar's projects: in the order they were added (or dragged to) by default, or by latest
 * activity with `orderBy: 'recent'`; ties keep the list's order. Switching folders never moves
 * them. The open folder is one of them, first when it was never added (`kingu.projects.addOnOpen` off).
 */
export function sidebarProjects(
	list: readonly Project[],
	open: string | null,
	opts: { orderBy?: ProjectOrder; lastActive?: (path: string) => number } = {}
): SidebarProject[] {
	const out = list.map((p, index) => ({ path: p.path, name: projectName(p.path), open: p.path === open, index }));
	if (open && !out.some((p) => p.open)) out.unshift({ path: open, name: projectName(open), open: true, index: -1 });
	if (opts.orderBy === 'recent' && opts.lastActive) {
		const active = opts.lastActive;
		out.sort((a, b) => active(b.path) - active(a.path) || a.index - b.index);
	}
	return out.map(({ path, name, open }) => ({ path, name, open }));
}

/** The other projects split around the open one, so the side bar keeps the chosen order. */
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
