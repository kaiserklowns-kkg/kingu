import { describe, expect, test } from 'bun:test';
import { listAppliedWorkspaceCleanupFilters, type WorkspaceCleanupFilterLabels } from './workspaceCleanupAppliedFilters';
import { createDefaultWorkspaceCleanupFilterState, type WorkspaceCleanupFilterState } from './workspaceCleanupFilters';

const labels: WorkspaceCleanupFilterLabels = {
	idleDays: (days) => `${days}d`,
	neverVisited: () => 'never',
	minSize: (bytes) => `min ${bytes}`,
	maxSize: (bytes) => `max ${bytes}`,
	excludesUnsized: () => 'sized only',
	excludesStatusless: () => 'status only',
	list: (kind, count) => `${kind}:${count}`,
	triState: (key, value) => `${key}:${value}`,
	minAhead: (days) => `ahead ${days}`,
	minBehind: (days) => `behind ${days}`,
	branchQuery: (query) => `branch ${query}`,
	presence: (kind, value) => `${kind}:${value}`,
	completelyEmpty: () => 'empty',
	pathPrefix: (prefix) => `path ${prefix}`
};

const full = (): WorkspaceCleanupFilterState => ({
	...createDefaultWorkspaceCleanupFilterState(),
	query: 'ignored',
	activity: { idleSignal: 'last-activity', idleMinDays: 7, neverVisited: true },
	size: { minBytes: 100, maxBytes: 0, includeUnsized: false },
	status: {
		workspaceStatuses: ['a'],
		matchStatusless: false,
		archived: 'only',
		pinned: 'exclude',
		unread: 'only',
		comment: 'exclude'
	},
	agent: { states: ['working'], retainedDoneAgents: 'only' },
	git: { states: ['dirty'], minAhead: 2, minBehind: 3, branchQuery: '  feat  ', prunable: 'only', locked: 'exclude' },
	review: { presence: 'some', states: ['open'], providers: ['github'] },
	ticket: { presence: 'none', sources: ['linear'] },
	context: { presence: 'some', completelyEmpty: true },
	location: { hostIds: ['ssh:x'], repoIds: ['r'], pathPrefix: '  /a  ' },
	safety: { blockers: ['dirty-files'], blockerMode: 'none-of', dismissed: 'only' }
});

describe('workspace cleanup applied filters', () => {
	test('defaults produce no chips', () => {
		expect(listAppliedWorkspaceCleanupFilters(createDefaultWorkspaceCleanupFilterState(), labels)).toEqual([]);
	});

	test('every narrowing constraint becomes a chip in dialog order', () => {
		const chips = listAppliedWorkspaceCleanupFilters(full(), labels);
		expect(chips.map((chip) => chip.id)).toEqual([
			'activity.idleMinDays',
			'activity.neverVisited',
			'size.minBytes',
			'size.maxBytes',
			'size.includeUnsized',
			'status.workspaceStatuses',
			'status.matchStatusless',
			'status.archived',
			'status.pinned',
			'status.unread',
			'status.comment',
			'agent.states',
			'agent.retainedDoneAgents',
			'git.states',
			'git.minAhead',
			'git.minBehind',
			'git.branchQuery',
			'git.prunable',
			'git.locked',
			'review.presence',
			'review.states',
			'review.providers',
			'ticket.presence',
			'ticket.sources',
			'context.presence',
			'context.completelyEmpty',
			'location.hostIds',
			'location.repoIds',
			'location.pathPrefix',
			'safety.blockers',
			'safety.dismissed'
		]);
		expect(chips.find((chip) => chip.id === 'git.branchQuery')?.label).toBe('branch feat');
		expect(chips.find((chip) => chip.id === 'location.pathPrefix')?.label).toBe('path /a');
	});

	test('each chip clears only its own constraint', () => {
		const filters = full();
		const chips = new Map(listAppliedWorkspaceCleanupFilters(filters, labels).map((chip) => [chip.id, chip]));
		expect(chips.get('activity.idleMinDays')!.clear(filters).activity.idleMinDays).toBeNull();
		expect(chips.get('size.maxBytes')!.clear(filters).size.maxBytes).toBeNull();
		expect(chips.get('status.archived')!.clear(filters).status.archived).toBe('any');
		expect(chips.get('agent.retainedDoneAgents')!.clear(filters).agent.retainedDoneAgents).toBe('any');
		expect(chips.get('git.branchQuery')!.clear(filters).git.branchQuery).toBe('');
		expect(chips.get('safety.dismissed')!.clear(filters).safety.dismissed).toBe('any');
		expect(chips.get('location.pathPrefix')!.clear(filters).location.pathPrefix).toBe('');
		const cleared = chips.get('status.archived')!.clear(filters);
		expect(cleared.status.pinned).toBe('exclude');
		expect(cleared.git.states).toEqual(['dirty']);
	});

	test('zero minimum is inert but zero maximum is applied', () => {
		const filters: WorkspaceCleanupFilterState = {
			...createDefaultWorkspaceCleanupFilterState(),
			size: { minBytes: 0, maxBytes: 0, includeUnsized: true }
		};
		expect(listAppliedWorkspaceCleanupFilters(filters, labels).map((chip) => chip.id)).toEqual(['size.maxBytes']);
		const git: WorkspaceCleanupFilterState = {
			...createDefaultWorkspaceCleanupFilterState(),
			git: { ...createDefaultWorkspaceCleanupFilterState().git, minAhead: 0, minBehind: 0 }
		};
		expect(listAppliedWorkspaceCleanupFilters(git, labels)).toEqual([]);
	});
});
