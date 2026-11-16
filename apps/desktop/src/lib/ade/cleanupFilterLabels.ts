// Chip texts of the Clean Up Tasks filter bar in the UI language (Orca's applied-filter labels,
// workspaceCleanupAppliedFilters.ts). Only the facets the dialog offers have words of their own;
// a facet a newer state carries shows its kind and count.
import { t } from '#lib/i18n/index.ts';
import { formatBytes } from './workspaceCleanupBrowse';
import type { WorkspaceCleanupFilterLabels } from './workspaceCleanupAppliedFilters';

const other = (kind: string, count: number) => t('workspaceCleanup.chip.other', { kind, count });

export const cleanupFilterLabels: WorkspaceCleanupFilterLabels = {
	idleDays: (days) => t('workspaceCleanup.chip.idleDays', { days }),
	neverVisited: () => other('never visited', 1),
	minSize: (bytes) => t('workspaceCleanup.chip.minSize', { size: formatBytes(bytes) }),
	maxSize: (bytes) => t('workspaceCleanup.chip.maxSize', { size: formatBytes(bytes) }),
	excludesUnsized: () => t('workspaceCleanup.chip.unsized'),
	excludesStatusless: () => other('no status', 0),
	list(kind, count) {
		if (kind === 'status') return t('workspaceCleanup.chip.status', { count });
		if (kind === 'agent') return t('workspaceCleanup.chip.agent', { count });
		if (kind === 'git') return t('workspaceCleanup.chip.git', { count });
		if (kind === 'reviewState') return t('workspaceCleanup.chip.reviewState', { count });
		if (kind === 'ticketSource') return t('workspaceCleanup.chip.ticketSource', { count });
		if (kind === 'blocker') return t('workspaceCleanup.chip.blocker', { count });
		return other(kind, count);
	},
	triState: (key, value) => other(`${key}: ${value}`, 1),
	minAhead: (days) => other('ahead ≥', days),
	minBehind: (days) => other('behind ≥', days),
	branchQuery: (query) => t('workspaceCleanup.chip.branch', { query }),
	presence(kind, value) {
		if (kind === 'review') return t(value === 'some' ? 'workspaceCleanup.chip.hasPr' : 'workspaceCleanup.chip.noPr');
		if (kind === 'ticket') return t(value === 'some' ? 'workspaceCleanup.chip.hasTicket' : 'workspaceCleanup.chip.noTicket');
		return other(`${kind}: ${value}`, 1);
	},
	completelyEmpty: () => other('empty', 1),
	pathPrefix: (prefix) => other(`path ${prefix}`, 1)
};
