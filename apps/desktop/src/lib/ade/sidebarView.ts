// The ADE side bar's worktree list from the ADE Sidebar settings (Orca's sidebar UI prefs:
// group by, sort by, the Filters switches, card properties) and the external-worktree visibility
// (Orca's worktree visibility). Pure, so `bun test` covers it.

import type { TaskStatus } from './model';
import { workflowOf, workflowStatuses, type WorkflowStatus } from './workflow.ts';
import { t } from '#lib/i18n/index.ts';

/** `repo`: one group per added project (projects.ts); within the open folder it lists like `none`.
 *  `workflow`: the board columns you move tasks between (workflow.ts). */
export type GroupBy = 'none' | 'workspace-status' | 'pr-status' | 'repo' | 'workflow';
/** `manual`: the order the user dragged (the side bar keeps it); sorted here like `recent`. */
export type SortBy = 'smart' | 'recent' | 'name' | 'manual';
export type CardProperty = 'status' | 'branch' | 'diff' | 'activity' | 'time' | 'pr' | 'issue' | 'automation';
export const CARD_PROPERTIES: readonly CardProperty[] = ['status', 'branch', 'diff', 'activity', 'time', 'pr', 'issue', 'automation'];
/** Orca's default card: everything on. */
export const DEFAULT_CARD_PROPERTIES: CardProperty[] = [...CARD_PROPERTIES];

/** What the list needs to know of one task card. */
export type SidebarTask = {
	slug: string;
	title: string;
	status: TaskStatus;
	/** Unix ms of the latest activity. */
	updatedAt: number;
	origin?: 'automation' | null;
	/** An agent session is open or a terminal of the worktree is running. */
	live: boolean;
	/** The worktree's HEAD is detached. */
	detached: boolean;
	/** `OPEN`, `MERGED`, `CLOSED` (from gh), or null when there is no PR (or not fetched). */
	prState: string | null;
	prDraft?: boolean;
	/** The board column you put it in (`TaskMeta.workflow_status`). */
	workflowStatus?: string | null;
};

export type SidebarPrefs = {
	groupBy: GroupBy;
	sortBy: SortBy;
	showActiveOnly: boolean;
	hideAutomation: boolean;
	hideSleeping: boolean;
	hideDetached: boolean;
};

const ATTENTION: TaskStatus[] = ['waiting', 'review', 'failed'];
const RANK: Record<TaskStatus, number> = { waiting: 0, failed: 0, review: 0, running: 1, done: 2 };

/** Orca's "Show active only": the agent is working or waiting on you. */
export const isActive = (t: Pick<SidebarTask, 'status'>) => t.status === 'running' || t.status === 'waiting';
/** Orca's sleeping workspace: no agent session and no running terminal (and nothing working). */
export const isSleeping = (t: Pick<SidebarTask, 'status' | 'live'>) => !t.live && t.status !== 'running' && t.status !== 'waiting';

/** Whether the side bar's filters hide this task (the Filters switches). */
export function hiddenBy(t: SidebarTask, p: Pick<SidebarPrefs, 'showActiveOnly' | 'hideAutomation' | 'hideSleeping' | 'hideDetached'>): boolean {
	if (p.showActiveOnly && !isActive(t)) return true;
	if (p.hideAutomation && t.origin === 'automation') return true;
	if (p.hideSleeping && isSleeping(t)) return true;
	if (p.hideDetached && t.detached) return true;
	return false;
}

/** `smart`: needs you first, then working, then done, newest first in each (Kingu's default order). */
export function sortTasks<T extends SidebarTask>(list: T[], sortBy: SortBy): T[] {
	const recent = (a: T, b: T) => b.updatedAt - a.updatedAt;
	const copy = [...list];
	if (sortBy === 'name') return copy.sort((a, b) => a.title.localeCompare(b.title, 'th') || a.slug.localeCompare(b.slug));
	if (sortBy === 'recent' || sortBy === 'manual') return copy.sort(recent);
	return copy.sort((a, b) => RANK[a.status] - RANK[b.status] || recent(a, b));
}

export type Group<T> = { id: string; label: string; tasks: T[] };

export const PR_GROUPS: { id: string; label: string }[] = [
	{ id: 'open', get label() { return t('ade.sidebar.prOpen'); } },
	{ id: 'draft', get label() { return t('ade.sidebar.prDraft'); } },
	{ id: 'merged', get label() { return t('ade.sidebar.prMerged'); } },
	{ id: 'closed', get label() { return t('ade.sidebar.prClosed'); } },
	{ id: 'none', get label() { return t('ade.sidebar.prNone'); } }
];

export function prGroupOf(t: Pick<SidebarTask, 'prState' | 'prDraft'>): string {
	switch (t.prState) {
		case 'OPEN':
			return t.prDraft ? 'draft' : 'open';
		case 'MERGED':
			return 'merged';
		case 'CLOSED':
			return 'closed';
		default:
			return 'none';
	}
}

const STATUS_GROUPS: { id: string; label: string; of: (s: TaskStatus) => boolean }[] = [
	{ id: 'attention', get label() { return t('ade.model.colAttention'); }, of: (s) => ATTENTION.includes(s) },
	{ id: 'active', get label() { return t('ade.model.colActive'); }, of: (s) => s === 'running' },
	{ id: 'done', get label() { return t('ade.model.colDone'); }, of: (s) => s === 'done' }
];

/** The visible tasks, filtered, sorted and grouped; empty groups are left out. `none` is one unnamed group. */
export function sidebarGroups<T extends SidebarTask>(list: T[], p: SidebarPrefs, statuses: readonly WorkflowStatus[] = workflowStatuses(undefined)): Group<T>[] {
	const shown = sortTasks(
		list.filter((t) => !hiddenBy(t, p)),
		p.sortBy
	);
	if (p.groupBy === 'none' || p.groupBy === 'repo') return shown.length ? [{ id: 'all', label: '', tasks: shown }] : [];
	if (p.groupBy === 'workflow')
		return statuses
			.map((s) => ({ id: `workflow:${s.id}`, label: s.label, tasks: shown.filter((t) => workflowOf({ workflow_status: t.workflowStatus }, statuses) === s.id) }))
			.filter((g) => g.tasks.length);
	const defs = p.groupBy === 'pr-status' ? PR_GROUPS.map((g) => ({ ...g, of: (t: T) => prGroupOf(t) === g.id })) : STATUS_GROUPS.map((g) => ({ ...g, of: (t: T) => g.of(t.status) }));
	return defs.map((g) => ({ id: g.id, label: g.label, tasks: shown.filter(g.of) })).filter((g) => g.tasks.length);
}

/** `kingu.sidebar.cardProperties` without unknown names; compact cards (Orca) show only the status and title. */
export function cardProperties(setting: readonly unknown[] | undefined, compact: boolean): Set<CardProperty> {
	if (compact) return new Set(['status']);
	const list = Array.isArray(setting) ? setting.filter((p): p is CardProperty => (CARD_PROPERTIES as readonly unknown[]).includes(p)) : DEFAULT_CARD_PROPERTIES;
	return new Set(list);
}

// ---------------------------------------------------------------------------------------------
// External worktrees (Orca's worktree visibility)

export type Visibility = 'hide' | 'show';
export type ExternalKind = 'agent' | 'external';

/**
 * Folders where coding agents keep scratch worktrees (Orca's agent worktree source): Claude Code's
 * `.claude/worktrees`, Codex's `.codex/worktrees`, Cursor's `.cursor/worktrees`, Conductor's
 * `conductor/workspaces`.
 */
export const AGENT_WORKTREE_DIRS = ['.claude/worktrees/', '.codex/worktrees/', '.cursor/worktrees/', 'conductor/workspaces/', '.conductor/'];

export type ListedWorktree = { path: string; branch: string | null; slug: string | null; bare: boolean; detached: boolean; prunable: boolean };

/** A worktree not made by Kingu: `agent` when it lives in an agent's scratch folder, else `external`. */
export function externalKind(path: string): ExternalKind {
	const p = path.replace(/\\/g, '/') + '/';
	return AGENT_WORKTREE_DIRS.some((d) => p.includes(`/${d}`)) ? 'agent' : 'external';
}

/**
 * The worktrees to show as read-only cards: not Kingu's own (they have a slug), not the folder
 * itself, not bare or prunable, and allowed by `kingu.worktree.agentVisibility` (agent scratch
 * worktrees) or `kingu.worktree.externalVisibility` (the rest). `custom`: extra folders (Orca's
 * custom visibility sources) whose worktrees always show.
 */
export function externalWorktrees(list: ListedWorktree[], root: string, vis: { external: Visibility; agent: Visibility; custom?: readonly string[] }): (ListedWorktree & { kind: ExternalKind })[] {
	const norm = (p: string) => p.replace(/\/+$/, '');
	const custom = (vis.custom ?? []).map((c) => norm(c.trim())).filter(Boolean);
	return list
		.filter((w) => !w.slug && !w.bare && !w.prunable && norm(w.path) !== norm(root))
		.map((w) => ({ ...w, kind: externalKind(w.path) }))
		.filter((w) => {
			if (custom.some((c) => norm(w.path) === c || norm(w.path).startsWith(`${c}/`))) return true;
			return (w.kind === 'agent' ? vis.agent : vis.external) === 'show';
		});
}

/** The last path segment: an external worktree card's title. */
export const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

// ---------------------------------------------------------------------------------------------
// Appearance

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const MAX_TINT_OPACITY = 0.35;

/** A `#rrggbb` / `#rgb` color, or null. */
export function hexColor(value: unknown): string | null {
	if (typeof value !== 'string' || !HEX.test(value.trim())) return null;
	const v = value.trim();
	return v.startsWith('#') ? v : `#${v}`;
}

/**
 * Orca's left side bar appearance: `tinted` lays the tint color over the side bar at the given
 * opacity (clamped to 0–0.35), `match-terminal` uses the terminal background, `default` nothing.
 */
export function sidebarTint(mode: string | undefined, color: unknown, opacity: unknown): { backgroundColor?: string; backgroundImage?: string } | null {
	if (mode === 'match-terminal') return { backgroundColor: 'var(--vscode-terminal-background, var(--vscode-panel-background))' };
	if (mode !== 'tinted') return null;
	const c = hexColor(color) ?? '#18181b';
	const o = typeof opacity === 'number' && Number.isFinite(opacity) ? Math.min(MAX_TINT_OPACITY, Math.max(0, opacity)) : 0.08;
	const tint = `color-mix(in srgb, ${c} ${Math.round(o * 1000) / 10}%, transparent)`;
	return { backgroundImage: `linear-gradient(${tint}, ${tint})` };
}

/** `kingu.tabs.ctrlTabOrder`: Ctrl+Tab's rows by recent use (`mru`) or the tab strip order from the active tab (`sequential`). */
export function switcherOrder(mode: string | undefined, mru: string[], tabs: string[]): string[] {
	if (mode !== 'sequential') return mru;
	const active = mru[0];
	const i = tabs.indexOf(active);
	return i < 0 ? tabs : [...tabs.slice(i), ...tabs.slice(0, i)];
}
