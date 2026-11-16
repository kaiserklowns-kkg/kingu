import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_WORKSPACE_CLEANUP_SORT,
	WORKSPACE_CLEANUP_BROWSE_STATE_VERSION,
	WORKSPACE_CLEANUP_SORT_FIELD_VALUES,
	createDefaultWorkspaceCleanupBrowseState,
	createDefaultWorkspaceCleanupFilterState,
	getWorkspaceCleanupAgentRank,
	getWorkspaceCleanupBlockerSeverity,
	getWorkspaceCleanupGitRank,
	getWorkspaceCleanupReviewRank,
	mergeWorkspaceCleanupUIState,
	normalizeWorkspaceCleanupBrowseState,
	normalizeWorkspaceCleanupFilterState,
	normalizeWorkspaceCleanupSortState
} from './workspaceCleanupFilters';

describe('workspace cleanup filters', () => {
	test('defaults are empty and sort oldest activity first', () => {
		const filters = createDefaultWorkspaceCleanupFilterState();
		expect(filters.query).toBe('');
		expect(filters.activity).toEqual({ idleSignal: 'last-visited', idleMinDays: null, neverVisited: false });
		expect(filters.size).toEqual({ minBytes: null, maxBytes: null, includeUnsized: true });
		expect(filters.safety).toEqual({ blockers: [], blockerMode: 'none-of', dismissed: 'any' });
		expect(filters.location).toEqual({ hostIds: [], repoIds: [], pathPrefix: '' });
		expect(DEFAULT_WORKSPACE_CLEANUP_SORT).toEqual({ field: 'last-activity', direction: 'asc' });
		expect(WORKSPACE_CLEANUP_SORT_FIELD_VALUES).toContain('blocker-count');
	});

	test('normalize repairs invalid fields independently instead of resetting everything', () => {
		const filters = normalizeWorkspaceCleanupFilterState({
			query: 7,
			activity: { idleSignal: 'nope', idleMinDays: -5, neverVisited: 'yes' },
			size: { minBytes: -1, maxBytes: null, includeUnsized: 'no' },
			status: {
				workspaceStatuses: ['a', 'a', '', 3],
				matchStatusless: 'x',
				archived: 'maybe',
				pinned: 'only',
				unread: 'exclude',
				comment: 'any'
			},
			agent: { states: ['working', 'bogus', 'working'], retainedDoneAgents: 'only' },
			git: { states: ['dirty', 'bogus', 'dirty'], minAhead: -2, minBehind: 3, branchQuery: 5, prunable: 'only', locked: 'nope' },
			review: { presence: 'none', states: ['open', 'bogus'], providers: ['github', 'bogus'] },
			ticket: { presence: 'some', sources: ['linear', 'bogus'] },
			context: { presence: 'bogus', completelyEmpty: true },
			location: { hostIds: ['local', 'nope', 'ssh:x', 'ssh:x'], repoIds: ['r', 'r', 3], pathPrefix: 1 },
			safety: { blockers: ['main-worktree', 'bogus', 'main-worktree'], blockerMode: 'any-of', dismissed: 'exclude' }
		});
		expect(filters.query).toBe('');
		expect(filters.activity).toEqual({ idleSignal: 'last-visited', idleMinDays: 0, neverVisited: false });
		expect(filters.size).toEqual({ minBytes: 0, maxBytes: null, includeUnsized: true });
		expect(filters.status).toEqual({
			workspaceStatuses: ['a'],
			matchStatusless: true,
			archived: 'any',
			pinned: 'only',
			unread: 'exclude',
			comment: 'any'
		});
		expect(filters.agent).toEqual({ states: ['working'], retainedDoneAgents: 'only' });
		expect(filters.git).toEqual({
			states: ['dirty'],
			minAhead: 0,
			minBehind: 3,
			branchQuery: '',
			prunable: 'only',
			locked: 'any'
		});
		expect(filters.review).toEqual({ presence: 'none', states: ['open'], providers: ['github'] });
		expect(filters.ticket).toEqual({ presence: 'some', sources: ['linear'] });
		expect(filters.context).toEqual({ presence: 'any', completelyEmpty: true });
		expect(filters.location).toEqual({ hostIds: ['local', 'ssh:x'], repoIds: ['r'], pathPrefix: '' });
		expect(filters.safety).toEqual({ blockers: ['main-worktree'], blockerMode: 'any-of', dismissed: 'exclude' });
	});

	test('normalize sort falls back field by field', () => {
		expect(normalizeWorkspaceCleanupSortState({ field: 'size', direction: 'desc' })).toEqual({ field: 'size', direction: 'desc' });
		expect(normalizeWorkspaceCleanupSortState({ field: 'bogus', direction: 'desc' })).toEqual({ field: 'last-activity', direction: 'desc' });
		expect(normalizeWorkspaceCleanupSortState(null)).toEqual(DEFAULT_WORKSPACE_CLEANUP_SORT);
	});

	test('browse state always takes the current version and normalizes its parts', () => {
		expect(createDefaultWorkspaceCleanupBrowseState()).toEqual({
			version: WORKSPACE_CLEANUP_BROWSE_STATE_VERSION,
			filters: createDefaultWorkspaceCleanupFilterState(),
			sort: { ...DEFAULT_WORKSPACE_CLEANUP_SORT }
		});
		const state = normalizeWorkspaceCleanupBrowseState({ version: 99, filters: { query: 'api' }, sort: { field: 'name' } });
		expect(state.version).toBe(WORKSPACE_CLEANUP_BROWSE_STATE_VERSION);
		expect(state.filters.query).toBe('api');
		expect(state.sort).toEqual({ field: 'name', direction: 'asc' });
		expect(normalizeWorkspaceCleanupBrowseState(null)).toEqual(createDefaultWorkspaceCleanupBrowseState());
	});

	test('facet ranks match the dialog order', () => {
		expect(getWorkspaceCleanupBlockerSeverity('main-worktree')).toBe(100);
		expect(getWorkspaceCleanupBlockerSeverity('dismissed')).toBe(10);
		expect(getWorkspaceCleanupBlockerSeverity('nope' as never)).toBe(0);
		expect(getWorkspaceCleanupAgentRank('idle')).toBe(0);
		expect(getWorkspaceCleanupAgentRank('working')).toBe(2);
		expect(getWorkspaceCleanupAgentRank('permission')).toBe(3);
		expect(getWorkspaceCleanupGitRank('clean')).toBe(1);
		expect(getWorkspaceCleanupGitRank('unpushed')).toBe(4);
		expect(getWorkspaceCleanupReviewRank(null)).toBe(0);
		expect(getWorkspaceCleanupReviewRank('merged')).toBe(1);
		expect(getWorkspaceCleanupReviewRank('open')).toBe(3);
	});

	test('publishing dismissals keeps the existing browse state', () => {
		const current: { dismissals: Record<string, number>; browse: { version: number } } = { dismissals: { a: 1 }, browse: { version: 1 } };
		expect(mergeWorkspaceCleanupUIState(current, undefined)).toBe(current);
		expect(mergeWorkspaceCleanupUIState(current, { dismissals: { b: 2 } })).toEqual({
			dismissals: { b: 2 },
			browse: { version: 1 }
		});
	});
});
