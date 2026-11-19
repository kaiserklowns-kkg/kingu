import { describe, expect, test } from 'bun:test';
import { en } from '../i18n/en';
import { th } from '../i18n/th';
import { formatBytes, reclaimable, BROWSE_AGENT_STATES, BROWSE_BLOCKERS, BROWSE_GIT_STATES, BROWSE_IDLE_SIGNALS, BROWSE_REVIEW_STATES, BROWSE_SORT_FIELDS, BROWSE_TICKET_SOURCES, reviewStateOf, ticketSourceOf, agentStateOf, browseCleanupRows, gitStateOf, matchesCleanupFilters, rowFacts, type CleanupRowFacts } from './workspaceCleanupBrowse';
import { createDefaultWorkspaceCleanupFilterState, DEFAULT_WORKSPACE_CLEANUP_SORT } from './workspaceCleanupFilters';
import type { CleanupCandidate } from './workspaceCleanupScan';

const NOW = Date.UTC(2026, 10, 16);
const DAY = 86_400_000;
const row = (over: Partial<CleanupRowFacts> = {}): CleanupRowFacts => ({ slug: 'a', title: 'Fix login', branch: 'kingu/fix-login', status: 'done', agent: 'idle', git: 'clean', blockers: [], lastActivityAt: NOW - 10 * DAY, createdAt: NOW - 20 * DAY, sizeBytes: null, review: null, ticket: null, archived: false, hasComment: false, ...over });
const cand = (over: Partial<CleanupCandidate> = {}): CleanupCandidate => ({ path: '/p', branch: 'kingu/a', head: 'x', slug: 'a', isMain: false, detached: false, locked: false, checkedAt: NOW, clean: true, ignoredFiles: false, unpushed: false, merged: true, unchanged: false, squashMerged: false, prMerged: false, unknownBase: false, base: 'main', error: null, lastActivityAt: NOW - DAY, ...over });
const filters = () => createDefaultWorkspaceCleanupFilterState();
const ok = (r: CleanupRowFacts, patch: (f: ReturnType<typeof filters>) => void) => {
	const f = filters();
	patch(f);
	return matchesCleanupFilters(r, f, NOW);
};

describe('workspace cleanup browse', () => {
	test('default filters keep every row', () => {
		expect(matchesCleanupFilters(row(), filters(), NOW)).toBe(true);
	});

	test('search looks at the title, slug and branch', () => {
		for (const q of ['login', 'KINGU/fix', 'a']) expect([q, ok(row(), (f) => (f.query = q))]).toEqual([q, true]);
		expect(ok(row(), (f) => (f.query = 'payments'))).toBe(false);
	});

	test('idle days count from the chosen signal', () => {
		expect(ok(row(), (f) => (f.activity.idleMinDays = 7))).toBe(true);
		expect(ok(row(), (f) => (f.activity.idleMinDays = 11))).toBe(false);
		expect(ok(row(), (f) => ((f.activity.idleMinDays = 15), (f.activity.idleSignal = 'created')))).toBe(true);
		expect(ok(row(), (f) => ((f.activity.idleMinDays = 25), (f.activity.idleSignal = 'created')))).toBe(false);
	});

	test('git state, status and agent are any-of lists; an unscanned row matches no git state', () => {
		expect(ok(row({ git: 'dirty' }), (f) => (f.git.states = ['dirty', 'unpushed']))).toBe(true);
		expect(ok(row({ git: 'clean' }), (f) => (f.git.states = ['dirty']))).toBe(false);
		expect(ok(row({ git: null }), (f) => (f.git.states = ['clean']))).toBe(false);
		expect(ok(row({ status: 'failed' }), (f) => (f.status.workspaceStatuses = ['done', 'review']))).toBe(false);
		expect(ok(row({ agent: 'working' }), (f) => (f.agent.states = ['working']))).toBe(true);
	});

	test('blockers: any-of needs one of them, none-of needs none', () => {
		const blocked = row({ blockers: ['dirty-files'] });
		expect(ok(blocked, (f) => ((f.safety.blockers = ['dirty-files', 'live-agent']), (f.safety.blockerMode = 'any-of')))).toBe(true);
		expect(ok(row(), (f) => ((f.safety.blockers = ['dirty-files']), (f.safety.blockerMode = 'any-of')))).toBe(false);
		expect(ok(blocked, (f) => ((f.safety.blockers = ['dirty-files']), (f.safety.blockerMode = 'none-of')))).toBe(false);
		expect(ok(row(), (f) => ((f.safety.blockers = ['dirty-files']), (f.safety.blockerMode = 'none-of')))).toBe(true);
	});

	test('sorts by the field and direction, oldest activity first by default', () => {
		const rows = [row({ slug: 'new', title: 'B', lastActivityAt: NOW - DAY }), row({ slug: 'old', title: 'A', lastActivityAt: NOW - 9 * DAY })];
		expect(browseCleanupRows(rows, filters(), DEFAULT_WORKSPACE_CLEANUP_SORT, NOW).map((r) => r.slug)).toEqual(['old', 'new']);
		expect(browseCleanupRows(rows, filters(), { field: 'last-activity', direction: 'desc' }, NOW).map((r) => r.slug)).toEqual(['new', 'old']);
		expect(browseCleanupRows(rows, filters(), { field: 'name', direction: 'desc' }, NOW).map((r) => r.slug)).toEqual(['new', 'old']);
	});

	test('facts: the worst git state wins, the agent state follows the task, blockers come from the evaluator input', () => {
		expect(gitStateOf(cand({ unpushed: true, clean: false }))).toBe('unpushed');
		expect(gitStateOf(cand({ clean: false }))).toBe('dirty');
		expect(gitStateOf(cand({ clean: null, checkedAt: null, error: 'x' }))).toBe('unknown');
		expect(gitStateOf(cand())).toBe('clean');
		expect(gitStateOf(undefined)).toBeNull();
		expect(agentStateOf({ status: 'waiting', working: true })).toBe('permission');
		expect(agentStateOf({ status: 'running', working: true })).toBe('working');
		expect(agentStateOf({ status: 'done', working: false })).toBe('idle');
		const f = rowFacts({ slug: 'a', title: 'T', branch: 'b', status: 'done', working: false, createdAt: 1, updatedAt: NOW }, cand({ clean: false, ignoredFiles: true }), { liveAgent: true, active: false, dirtyEditor: false, pinned: true });
		expect(f.blockers).toEqual(['live-agent', 'pinned', 'dirty-files', 'ignored-files']);
		expect(f.lastActivityAt).toBe(NOW);
	});

	test('every option the filter bar shows has words in both languages', () => {
		const camel = (v: string) => v.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
		const keys = [
			...BROWSE_SORT_FIELDS.map((v) => `sort.${camel(v)}`),
			...BROWSE_IDLE_SIGNALS.map((v) => `signal.${camel(v)}`),
			...BROWSE_GIT_STATES.map((v) => `git.${v}`),
			...BROWSE_AGENT_STATES.map((v) => `agent.${v}`),
			...BROWSE_BLOCKERS.map((v) => `blocker.${camel(v)}`),
			...BROWSE_REVIEW_STATES.map((v) => `review.${v}`),
			...BROWSE_TICKET_SOURCES.map((v) => `ticket.${v}`),
			'presence.some',
			'presence.none',
			'archived',
			'comment',
			'triState.only',
			'triState.exclude'
		].map((k) => `workspaceCleanup.filter.${k}`);
		for (const k of keys) expect([k, k in en, k in th]).toEqual([k, true, true]);
	});

	test('review: a PR is read into one state, a draft is not open', () => {
		expect(reviewStateOf(undefined)).toBeNull();
		expect(reviewStateOf(null)).toBeNull();
		expect(reviewStateOf({ state: 'OPEN', draft: false })).toBe('open');
		expect(reviewStateOf({ state: 'OPEN', draft: true })).toBe('draft');
		expect(reviewStateOf({ state: 'MERGED' })).toBe('merged');
		expect(reviewStateOf({ state: 'CLOSED' })).toBe('closed');
		expect(reviewStateOf({ state: 'WEIRD' })).toBe('unknown');
	});

	test('review: presence and states; an unread task is unknown and stays unless a PR or other states are asked for', () => {
		const unread = row({ review: null });
		const open = row({ review: 'open' });
		const merged = row({ review: 'merged' });
		expect(ok(unread, (f) => (f.review.presence = 'some'))).toBe(false);
		expect(ok(open, (f) => (f.review.presence = 'some'))).toBe(true);
		expect(ok(unread, (f) => (f.review.presence = 'none'))).toBe(true);
		expect(ok(open, (f) => (f.review.presence = 'none'))).toBe(false);
		expect(ok(unread, (f) => (f.review.states = ['unknown']))).toBe(true);
		expect(ok(unread, (f) => (f.review.states = ['merged']))).toBe(false);
		expect(ok(merged, (f) => (f.review.states = ['merged', 'closed']))).toBe(true);
		expect(ok(open, (f) => (f.review.states = ['merged', 'closed']))).toBe(false);
		expect(ok(row({ review: 'unknown' }), (f) => (f.review.presence = 'some'))).toBe(false);
		// An untouched review facet hides nothing, whatever the data.
		for (const review of [null, 'open', 'draft', 'merged', 'closed', 'unknown'] as const) expect(matchesCleanupFilters(row({ review }), filters(), NOW)).toBe(true);
	});

	test('ticket: source is told from the link provider; presence and sources narrow', () => {
		expect(ticketSourceOf(null)).toBeNull();
		expect(ticketSourceOf({})).toBe('issue');
		expect(ticketSourceOf({ provider: 'github' })).toBe('issue');
		expect(ticketSourceOf({ provider: 'linear' })).toBe('linear');
		const lin = row({ ticket: 'linear' });
		const none = row({ ticket: null });
		expect(ok(lin, (f) => (f.ticket.presence = 'some'))).toBe(true);
		expect(ok(none, (f) => (f.ticket.presence = 'some'))).toBe(false);
		expect(ok(none, (f) => (f.ticket.presence = 'none'))).toBe(true);
		expect(ok(lin, (f) => (f.ticket.presence = 'none'))).toBe(false);
		expect(ok(lin, (f) => (f.ticket.sources = ['issue']))).toBe(false);
		expect(ok(lin, (f) => (f.ticket.sources = ['issue', 'linear']))).toBe(true);
		expect(ok(none, (f) => (f.ticket.sources = ['linear']))).toBe(false);
	});

	test('rowFacts carries the PR state and the ticket source', () => {
		const task = { slug: 'a', title: 'T', branch: 'b', status: 'done', working: false, createdAt: 1, updatedAt: NOW };
		const f = rowFacts(task, undefined, undefined, null, { pr: { state: 'OPEN', draft: true }, issue: { provider: 'linear' } });
		expect([f.review, f.ticket]).toEqual(['draft', 'linear']);
		const g = rowFacts(task, undefined, undefined);
		expect([g.review, g.ticket]).toEqual([null, null]);
	});

	test('archived and comment: only keeps the ones that have it, exclude hides them', () => {
		const archived = row({ archived: true });
		expect(ok(archived, (f) => (f.status.archived = 'only'))).toBe(true);
		expect(ok(row(), (f) => (f.status.archived = 'only'))).toBe(false);
		expect(ok(archived, (f) => (f.status.archived = 'exclude'))).toBe(false);
		expect(ok(row(), (f) => (f.status.archived = 'exclude'))).toBe(true);
		const noted = row({ hasComment: true });
		expect(ok(noted, (f) => (f.status.comment = 'only'))).toBe(true);
		expect(ok(row(), (f) => (f.status.comment = 'only'))).toBe(false);
		expect(ok(noted, (f) => (f.status.comment = 'exclude'))).toBe(false);
		expect(ok(row(), (f) => (f.status.comment = 'exclude'))).toBe(true);
	});

	test('rowFacts reads archived and a non-blank comment', () => {
		const task = { slug: 'a', title: 'T', branch: 'b', status: 'done', working: false, createdAt: 1, updatedAt: NOW };
		const f = rowFacts(task, undefined, undefined, null, { archived: true, comment: 'keep for demo' });
		expect([f.archived, f.hasComment]).toEqual([true, true]);
		expect([rowFacts(task, undefined, undefined, null, { comment: '  ' }).hasComment, rowFacts(task, undefined, undefined).archived]).toEqual([false, false]);
	});

	test('size: min and max narrow the measured ones; an unmeasured one follows "include unmeasured"', () => {
		const MB = 1024 * 1024;
		expect(ok(row({ sizeBytes: 5 * MB }), (f) => (f.size.minBytes = 4 * MB))).toBe(true);
		expect(ok(row({ sizeBytes: 3 * MB }), (f) => (f.size.minBytes = 4 * MB))).toBe(false);
		expect(ok(row({ sizeBytes: 5 * MB }), (f) => (f.size.maxBytes = 4 * MB))).toBe(false);
		expect(ok(row({ sizeBytes: 0 }), (f) => (f.size.maxBytes = 0))).toBe(true);
		expect(ok(row({ sizeBytes: 1 }), (f) => (f.size.maxBytes = 0))).toBe(false);
		expect(ok(row({ sizeBytes: null }), (f) => (f.size.minBytes = 4 * MB))).toBe(true);
		expect(ok(row({ sizeBytes: null }), (f) => ((f.size.minBytes = 4 * MB), (f.size.includeUnsized = false)))).toBe(false);
		expect(ok(row({ sizeBytes: null }), (f) => (f.size.includeUnsized = false))).toBe(false);
	});

	test('sorting by size puts the largest first when descending, unmeasured last', () => {
		const rows = [row({ slug: 'none', sizeBytes: null }), row({ slug: 'big', sizeBytes: 900 }), row({ slug: 'small', sizeBytes: 10 })];
		expect(browseCleanupRows(rows, filters(), { field: 'size', direction: 'desc' }, NOW).map((r) => r.slug)).toEqual(['big', 'small', 'none']);
		expect(browseCleanupRows(rows, filters(), { field: 'size', direction: 'asc' }, NOW).map((r) => r.slug)).toEqual(['none', 'small', 'big']);
	});

	test('sizes read as people say them, and the total counts what could not be measured', () => {
		expect([0, 812, 1024, 1536, 15 * 1024 * 1024, 3.2 * 1024 ** 3].map(formatBytes)).toEqual(['0 B', '812 B', '1 KB', '1.5 KB', '15 MB', '3.2 GB']);
		expect(reclaimable([{ sizeBytes: 100 }, { sizeBytes: null }, { sizeBytes: 50 }])).toEqual({ bytes: 150, unmeasured: 1 });
	});
});
