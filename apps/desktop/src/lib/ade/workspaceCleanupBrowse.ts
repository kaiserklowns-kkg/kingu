// Workspace Cleanup, browse side: filtering and sorting the dialog's rows with Orca 1.4.259's filter
// state (workspaceCleanupFilters.ts). Orca's state covers more than Kingu knows about a task, so
// this applies the facets Kingu has data for and the dialog offers only those: search, idle days,
// Git state, branch, task status, agent state and blockers. A facet the dialog never sets stays at
// its default and filters nothing, so a state saved by another build still loads (normalize…).

import { getWorkspaceCleanupAgentRank, getWorkspaceCleanupBlockerSeverity, getWorkspaceCleanupGitRank, type WorkspaceCleanupAgentState, type WorkspaceCleanupBlockerValue, type WorkspaceCleanupFilterState, type WorkspaceCleanupGitState, type WorkspaceCleanupSortField, type WorkspaceCleanupSortState } from './workspaceCleanupFilters';
import { candidateInput, type CleanupCandidate, type CleanupTaskContext } from './workspaceCleanupScan';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The blockers Kingu can know (the ones a task can have), most protective first. */
export const BROWSE_BLOCKERS: readonly WorkspaceCleanupBlockerValue[] = ['active-workspace', 'live-agent', 'dirty-editor-buffer', 'unpushed-commits', 'dirty-files', 'ignored-files', 'git-status-error'];
export const BROWSE_GIT_STATES: readonly WorkspaceCleanupGitState[] = ['clean', 'dirty', 'unpushed', 'unknown'];
export const BROWSE_AGENT_STATES: readonly WorkspaceCleanupAgentState[] = ['idle', 'working', 'permission'];
export const BROWSE_TASK_STATUSES = ['running', 'waiting', 'review', 'done', 'failed'] as const;
export const BROWSE_IDLE_SIGNALS = ['last-activity', 'created'] as const;
export const BROWSE_SORT_FIELDS: readonly WorkspaceCleanupSortField[] = ['last-activity', 'created', 'name', 'branch', 'workspace-status', 'agent', 'git', 'blocker-count'];

export type CleanupRowFacts = {
	slug: string;
	title: string;
	branch: string;
	status: string;
	agent: WorkspaceCleanupAgentState;
	/** `null` before the scan has read Git. */
	git: WorkspaceCleanupGitState | null;
	blockers: WorkspaceCleanupBlockerValue[];
	lastActivityAt: number;
	createdAt: number;
};

/** One state per workspace, the most worrying first: unpushed, dirty, unknown, clean. */
export function gitStateOf(c: CleanupCandidate | undefined): WorkspaceCleanupGitState | null {
	if (!c) return null;
	if (c.unpushed) return 'unpushed';
	if (c.clean === false) return 'dirty';
	if (c.clean === null || c.error) return 'unknown';
	return 'clean';
}

export function agentStateOf(task: { status: string; working: boolean }): WorkspaceCleanupAgentState {
	if (task.status === 'waiting') return 'permission';
	return task.working ? 'working' : 'idle';
}

export function rowFacts(
	task: { slug: string; title: string; branch: string; status: string; working: boolean; createdAt: number; updatedAt: number },
	candidate: CleanupCandidate | undefined,
	ctx: CleanupTaskContext | undefined
): CleanupRowFacts {
	const blockers = candidate ? (candidateInput(candidate, ctx).blockers as readonly string[]).filter((b) => (BROWSE_BLOCKERS as readonly string[]).includes(b)) as WorkspaceCleanupBlockerValue[] : [];
	return {
		slug: task.slug,
		title: task.title,
		branch: task.branch,
		status: task.status,
		agent: agentStateOf(task),
		git: gitStateOf(candidate),
		blockers,
		lastActivityAt: Math.max(candidate?.lastActivityAt ?? 0, task.updatedAt),
		createdAt: task.createdAt
	};
}

const contains = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.trim().toLowerCase());

export function matchesCleanupFilters(row: CleanupRowFacts, f: WorkspaceCleanupFilterState, now: number): boolean {
	if (f.query.trim() && ![row.title, row.slug, row.branch].some((s) => contains(s, f.query))) return false;
	const { idleMinDays, idleSignal } = f.activity;
	if (idleMinDays !== null && idleMinDays > 0) {
		const since = idleSignal === 'created' ? row.createdAt : row.lastActivityAt;
		if (now - since < idleMinDays * DAY_MS) return false;
	}
	if (f.git.states.length && (row.git === null || !f.git.states.includes(row.git))) return false;
	if (f.git.branchQuery.trim() && !contains(row.branch, f.git.branchQuery)) return false;
	if (f.status.workspaceStatuses.length && !f.status.workspaceStatuses.includes(row.status)) return false;
	if (f.agent.states.length && !f.agent.states.includes(row.agent)) return false;
	if (f.safety.blockers.length) {
		const has = f.safety.blockers.filter((b) => row.blockers.includes(b));
		if (f.safety.blockerMode === 'any-of' ? !has.length : has.length) return false;
	}
	return true;
}

const SORT_VALUE: Record<string, (r: CleanupRowFacts) => number | string> = {
	'last-activity': (r) => r.lastActivityAt,
	created: (r) => r.createdAt,
	name: (r) => r.title.toLowerCase(),
	branch: (r) => r.branch.toLowerCase(),
	'workspace-status': (r) => BROWSE_TASK_STATUSES.indexOf(r.status as (typeof BROWSE_TASK_STATUSES)[number]),
	agent: (r) => getWorkspaceCleanupAgentRank(r.agent),
	git: (r) => (r.git ? getWorkspaceCleanupGitRank(r.git) : 0),
	'blocker-count': (r) => r.blockers.length
};

/** The sort's order; ties keep the most protective (highest blocker severity) workspace last, then the name. */
export function compareCleanupRows(a: CleanupRowFacts, b: CleanupRowFacts, sort: WorkspaceCleanupSortState): number {
	const value = SORT_VALUE[sort.field] ?? SORT_VALUE['last-activity'];
	const [x, y] = [value(a), value(b)];
	const order = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y;
	const severity = (r: CleanupRowFacts) => Math.max(0, ...r.blockers.map(getWorkspaceCleanupBlockerSeverity));
	return (sort.direction === 'asc' ? order : -order) || severity(a) - severity(b) || a.title.localeCompare(b.title);
}

/** Rows that pass the filters, in the sort's order. */
export function browseCleanupRows(rows: readonly CleanupRowFacts[], filters: WorkspaceCleanupFilterState, sort: WorkspaceCleanupSortState, now: number): CleanupRowFacts[] {
	return rows.filter((r) => matchesCleanupFilters(r, filters, now)).sort((a, b) => compareCleanupRows(a, b, sort));
}
