// Orca 1.4.259's Workspace Cleanup filter/browse model, ported from the installed app.asar
// (`out/shared/workspace-cleanup/workspace-cleanup-filter-model.js`,
// `workspace-cleanup-facet-rankings.js`, `workspace-cleanup-filter-state-codec.js` and
// `workspace-cleanup-browse-state.js`). The dialog persists this state; normalize it field by field
// so one corrupt field cannot reset every filter.

import { normalizeExecutionHostId } from './workspaceCleanupClassify';

export type WorkspaceCleanupTriState = 'any' | 'only' | 'exclude';
export type WorkspaceCleanupPresence = 'any' | 'some' | 'none';
export type WorkspaceCleanupBlockerMode = 'any-of' | 'none-of';
export type WorkspaceCleanupIdleSignal = 'last-visited' | 'last-activity' | 'created';
export type WorkspaceCleanupAgentState = 'idle' | 'working' | 'permission';
export type WorkspaceCleanupGitState = 'clean' | 'unknown' | 'dirty' | 'unpushed';
export type WorkspaceCleanupReviewState = 'merged' | 'closed' | 'unknown' | 'draft' | 'open';
export type WorkspaceCleanupTicketSource = 'work-item' | 'linear' | 'issue';
export type WorkspaceCleanupReviewProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'gitea' | 'unsupported';
export type WorkspaceCleanupSortDirection = 'asc' | 'desc';
export type WorkspaceCleanupBlockerValue =
	| 'main-worktree'
	| 'folder-repo'
	| 'active-workspace'
	| 'pinned'
	| 'live-agent'
	| 'running-terminal'
	| 'dirty-editor-buffer'
	| 'recent-visible-context'
	| 'terminal-liveness-unknown'
	| 'ssh-disconnected'
	| 'unpushed-commits'
	| 'dirty-files'
	| 'ignored-files'
	| 'unknown-base'
	| 'git-status-error'
	| 'dismissed';

export type WorkspaceCleanupSortField =
	| 'last-activity'
	| 'last-visited'
	| 'created'
	| 'size'
	| 'name'
	| 'repo'
	| 'path'
	| 'host'
	| 'workspace-status'
	| 'agent'
	| 'git'
	| 'ahead'
	| 'behind'
	| 'branch'
	| 'review'
	| 'ticket'
	| 'local-context'
	| 'blocker-count';

// Records (not bare arrays) so tsc fails when a union gains a member.
const BLOCKER_SEVERITY: Record<WorkspaceCleanupBlockerValue, number> = {
	'main-worktree': 100,
	'folder-repo': 95,
	'active-workspace': 90,
	pinned: 85,
	'live-agent': 80,
	'running-terminal': 75,
	'dirty-editor-buffer': 70,
	'recent-visible-context': 60,
	'terminal-liveness-unknown': 55,
	'ssh-disconnected': 50,
	'unpushed-commits': 45,
	'dirty-files': 40,
	'ignored-files': 38,
	'unknown-base': 35,
	'git-status-error': 30,
	dismissed: 10
};

const AGENT_RANK: Record<WorkspaceCleanupAgentState, number> = { idle: 0, working: 2, permission: 3 };
const GIT_RANK: Record<WorkspaceCleanupGitState, number> = { clean: 1, unknown: 2, dirty: 3, unpushed: 4 };
const REVIEW_RANK: Record<WorkspaceCleanupReviewState, number> = { merged: 1, closed: 1, unknown: 2, draft: 3, open: 3 };

export const WORKSPACE_CLEANUP_BLOCKER_VALUES = Object.keys(BLOCKER_SEVERITY) as WorkspaceCleanupBlockerValue[];
export const WORKSPACE_CLEANUP_AGENT_STATE_VALUES = Object.keys(AGENT_RANK) as WorkspaceCleanupAgentState[];
export const WORKSPACE_CLEANUP_GIT_STATE_VALUES = Object.keys(GIT_RANK) as WorkspaceCleanupGitState[];
export const WORKSPACE_CLEANUP_REVIEW_STATE_VALUES = Object.keys(REVIEW_RANK) as WorkspaceCleanupReviewState[];
export const WORKSPACE_CLEANUP_TICKET_SOURCE_VALUES: WorkspaceCleanupTicketSource[] = ['work-item', 'linear', 'issue'];
export const WORKSPACE_CLEANUP_IDLE_SIGNAL_VALUES: WorkspaceCleanupIdleSignal[] = ['last-visited', 'last-activity', 'created'];
export const WORKSPACE_CLEANUP_TRI_STATE_VALUES: WorkspaceCleanupTriState[] = ['any', 'only', 'exclude'];
export const WORKSPACE_CLEANUP_PRESENCE_VALUES: WorkspaceCleanupPresence[] = ['any', 'some', 'none'];
export const WORKSPACE_CLEANUP_BLOCKER_MODE_VALUES: WorkspaceCleanupBlockerMode[] = ['any-of', 'none-of'];
export const WORKSPACE_CLEANUP_SORT_DIRECTION_VALUES: WorkspaceCleanupSortDirection[] = ['asc', 'desc'];
export const WORKSPACE_CLEANUP_SORT_FIELD_VALUES: WorkspaceCleanupSortField[] = [
	'last-activity',
	'last-visited',
	'created',
	'size',
	'name',
	'repo',
	'path',
	'host',
	'workspace-status',
	'agent',
	'git',
	'ahead',
	'behind',
	'branch',
	'review',
	'ticket',
	'local-context',
	'blocker-count'
];
export const WORKSPACE_CLEANUP_REVIEW_PROVIDER_VALUES: WorkspaceCleanupReviewProvider[] = [
	'github',
	'gitlab',
	'bitbucket',
	'azure-devops',
	'gitea',
	'unsupported'
];

export function getWorkspaceCleanupBlockerSeverity(blocker: WorkspaceCleanupBlockerValue): number {
	return BLOCKER_SEVERITY[blocker] ?? 0;
}

export function getWorkspaceCleanupAgentRank(state: WorkspaceCleanupAgentState): number {
	return AGENT_RANK[state] ?? 0;
}

export function getWorkspaceCleanupGitRank(state: WorkspaceCleanupGitState): number {
	return GIT_RANK[state] ?? 0;
}

export function getWorkspaceCleanupReviewRank(state: WorkspaceCleanupReviewState | null): number {
	return state === null ? 0 : (REVIEW_RANK[state] ?? 0);
}

export type WorkspaceCleanupFilterState = {
	query: string;
	activity: { idleSignal: WorkspaceCleanupIdleSignal; idleMinDays: number | null; neverVisited: boolean };
	size: { minBytes: number | null; maxBytes: number | null; includeUnsized: boolean };
	status: {
		workspaceStatuses: string[];
		matchStatusless: boolean;
		archived: WorkspaceCleanupTriState;
		pinned: WorkspaceCleanupTriState;
		unread: WorkspaceCleanupTriState;
		comment: WorkspaceCleanupTriState;
	};
	agent: { states: WorkspaceCleanupAgentState[]; retainedDoneAgents: WorkspaceCleanupTriState };
	git: {
		states: WorkspaceCleanupGitState[];
		minAhead: number | null;
		minBehind: number | null;
		branchQuery: string;
		prunable: WorkspaceCleanupTriState;
		locked: WorkspaceCleanupTriState;
	};
	review: {
		presence: WorkspaceCleanupPresence;
		states: WorkspaceCleanupReviewState[];
		providers: WorkspaceCleanupReviewProvider[];
	};
	ticket: { presence: WorkspaceCleanupPresence; sources: WorkspaceCleanupTicketSource[] };
	context: { presence: WorkspaceCleanupPresence; completelyEmpty: boolean };
	location: { hostIds: string[]; repoIds: string[]; pathPrefix: string };
	safety: {
		blockers: WorkspaceCleanupBlockerValue[];
		blockerMode: WorkspaceCleanupBlockerMode;
		dismissed: WorkspaceCleanupTriState;
	};
};

export type WorkspaceCleanupSortState = { field: WorkspaceCleanupSortField; direction: WorkspaceCleanupSortDirection };

export type WorkspaceCleanupBrowseState = {
	version: number;
	filters: WorkspaceCleanupFilterState;
	sort: WorkspaceCleanupSortState;
};

/** Fresh object every call — filter state is mutated by the UI and stored per dialog. */
export function createDefaultWorkspaceCleanupFilterState(): WorkspaceCleanupFilterState {
	return {
		query: '',
		activity: { idleSignal: 'last-visited', idleMinDays: null, neverVisited: false },
		size: { minBytes: null, maxBytes: null, includeUnsized: true },
		status: {
			workspaceStatuses: [],
			matchStatusless: true,
			archived: 'any',
			pinned: 'any',
			unread: 'any',
			comment: 'any'
		},
		agent: { states: [], retainedDoneAgents: 'any' },
		git: { states: [], minAhead: null, minBehind: null, branchQuery: '', prunable: 'any', locked: 'any' },
		review: { presence: 'any', states: [], providers: [] },
		ticket: { presence: 'any', sources: [] },
		context: { presence: 'any', completelyEmpty: false },
		location: { hostIds: [], repoIds: [], pathPrefix: '' },
		safety: { blockers: [], blockerMode: 'none-of', dismissed: 'any' }
	};
}

export const DEFAULT_WORKSPACE_CLEANUP_SORT: WorkspaceCleanupSortState = { field: 'last-activity', direction: 'asc' };

export const WORKSPACE_CLEANUP_BROWSE_STATE_VERSION = 1;

export function createDefaultWorkspaceCleanupBrowseState(): WorkspaceCleanupBrowseState {
	return {
		version: WORKSPACE_CLEANUP_BROWSE_STATE_VERSION,
		filters: createDefaultWorkspaceCleanupFilterState(),
		sort: { ...DEFAULT_WORKSPACE_CLEANUP_SORT }
	};
}

const asRecord = (value: unknown): Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asString = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
const asBoolean = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

const asNullableNumber = (value: unknown, fallback: number | null, min?: number): number | null => {
	if (value === null) return null;
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return min !== undefined && value < min ? min : value;
};

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function asEnumList<T extends string>(value: unknown, allowed: readonly T[]): T[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const result: T[] = [];
	for (const entry of value) {
		if (typeof entry === 'string' && (allowed as readonly string[]).includes(entry) && !seen.has(entry)) {
			seen.add(entry);
			result.push(entry as T);
		}
	}
	return result;
}

function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	for (const entry of value) if (typeof entry === 'string' && entry.length > 0) seen.add(entry);
	return [...seen];
}

function asExecutionHostIdList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const result = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== 'string') continue;
		const hostId = normalizeExecutionHostId(entry);
		if (hostId) result.add(hostId);
	}
	return [...result];
}

const asTriState = (value: unknown, fallback: WorkspaceCleanupTriState): WorkspaceCleanupTriState =>
	asEnum(value, WORKSPACE_CLEANUP_TRI_STATE_VALUES, fallback);

/** Default unknown fields independently when reading older/newer settings instead of discarding the whole filter state. */
export function normalizeWorkspaceCleanupFilterState(value: unknown): WorkspaceCleanupFilterState {
	const base = createDefaultWorkspaceCleanupFilterState();
	const raw = asRecord(value);
	const activity = asRecord(raw.activity);
	const size = asRecord(raw.size);
	const status = asRecord(raw.status);
	const agent = asRecord(raw.agent);
	const git = asRecord(raw.git);
	const review = asRecord(raw.review);
	const ticket = asRecord(raw.ticket);
	const context = asRecord(raw.context);
	const location = asRecord(raw.location);
	const safety = asRecord(raw.safety);
	return {
		query: asString(raw.query, base.query),
		activity: {
			idleSignal: asEnum(activity.idleSignal, WORKSPACE_CLEANUP_IDLE_SIGNAL_VALUES, base.activity.idleSignal),
			idleMinDays: asNullableNumber(activity.idleMinDays, base.activity.idleMinDays, 0),
			neverVisited: asBoolean(activity.neverVisited, base.activity.neverVisited)
		},
		size: {
			minBytes: asNullableNumber(size.minBytes, base.size.minBytes, 0),
			maxBytes: asNullableNumber(size.maxBytes, base.size.maxBytes, 0),
			includeUnsized: asBoolean(size.includeUnsized, base.size.includeUnsized)
		},
		status: {
			workspaceStatuses: asStringList(status.workspaceStatuses),
			matchStatusless: asBoolean(status.matchStatusless, base.status.matchStatusless),
			archived: asTriState(status.archived, base.status.archived),
			pinned: asTriState(status.pinned, base.status.pinned),
			unread: asTriState(status.unread, base.status.unread),
			comment: asTriState(status.comment, base.status.comment)
		},
		agent: {
			states: asEnumList(agent.states, WORKSPACE_CLEANUP_AGENT_STATE_VALUES),
			retainedDoneAgents: asTriState(agent.retainedDoneAgents, base.agent.retainedDoneAgents)
		},
		git: {
			states: asEnumList(git.states, WORKSPACE_CLEANUP_GIT_STATE_VALUES),
			minAhead: asNullableNumber(git.minAhead, base.git.minAhead, 0),
			minBehind: asNullableNumber(git.minBehind, base.git.minBehind, 0),
			branchQuery: asString(git.branchQuery, base.git.branchQuery),
			prunable: asTriState(git.prunable, base.git.prunable),
			locked: asTriState(git.locked, base.git.locked)
		},
		review: {
			presence: asEnum(review.presence, WORKSPACE_CLEANUP_PRESENCE_VALUES, base.review.presence),
			states: asEnumList(review.states, WORKSPACE_CLEANUP_REVIEW_STATE_VALUES),
			providers: asEnumList(review.providers, WORKSPACE_CLEANUP_REVIEW_PROVIDER_VALUES)
		},
		ticket: {
			presence: asEnum(ticket.presence, WORKSPACE_CLEANUP_PRESENCE_VALUES, base.ticket.presence),
			sources: asEnumList(ticket.sources, WORKSPACE_CLEANUP_TICKET_SOURCE_VALUES)
		},
		context: {
			presence: asEnum(context.presence, WORKSPACE_CLEANUP_PRESENCE_VALUES, base.context.presence),
			completelyEmpty: asBoolean(context.completelyEmpty, base.context.completelyEmpty)
		},
		location: {
			hostIds: asExecutionHostIdList(location.hostIds),
			repoIds: asStringList(location.repoIds),
			pathPrefix: asString(location.pathPrefix, base.location.pathPrefix)
		},
		safety: {
			blockers: asEnumList(safety.blockers, WORKSPACE_CLEANUP_BLOCKER_VALUES),
			blockerMode: asEnum(safety.blockerMode, WORKSPACE_CLEANUP_BLOCKER_MODE_VALUES, base.safety.blockerMode),
			dismissed: asTriState(safety.dismissed, base.safety.dismissed)
		}
	};
}

export function normalizeWorkspaceCleanupSortState(value: unknown): WorkspaceCleanupSortState {
	const raw = asRecord(value);
	return {
		field: asEnum(raw.field, WORKSPACE_CLEANUP_SORT_FIELD_VALUES, DEFAULT_WORKSPACE_CLEANUP_SORT.field),
		direction: asEnum(raw.direction, WORKSPACE_CLEANUP_SORT_DIRECTION_VALUES, DEFAULT_WORKSPACE_CLEANUP_SORT.direction)
	};
}

/** Normalize corrupt/older values field by field to defaults so one bad setting cannot brick the dialog. */
export function normalizeWorkspaceCleanupBrowseState(value: unknown): WorkspaceCleanupBrowseState {
	if (value == null) return createDefaultWorkspaceCleanupBrowseState();
	const raw = asRecord(value);
	return {
		version: WORKSPACE_CLEANUP_BROWSE_STATE_VERSION,
		filters: normalizeWorkspaceCleanupFilterState(raw.filters),
		sort: normalizeWorkspaceCleanupSortState(raw.sort)
	};
}

/** Keep browse state when an older client or host publishes dismissals only. */
export function mergeWorkspaceCleanupUIState<T extends { browse?: unknown }>(current: T, incoming: Partial<T> | undefined): T {
	if (!incoming) return current;
	return { ...current, ...incoming };
}
