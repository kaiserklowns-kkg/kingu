// Pull request checks as Orca's Checks tab presents them: one kind per check (from GitHub's
// check runs and commit statuses), failures sorted first, the summary counts and the merge state.

/** A `statusCheckRollup` entry of `gh pr view --json`: a check run or a commit status context. */
export type Check = {
	__typename?: string;
	name?: string;
	context?: string;
	/** Check runs: QUEUED / IN_PROGRESS / COMPLETED. */
	status?: string;
	/** Check runs: SUCCESS / FAILURE / CANCELLED / TIMED_OUT / ACTION_REQUIRED / NEUTRAL / SKIPPED / STALE. */
	conclusion?: string;
	/** Commit statuses: SUCCESS / FAILURE / ERROR / PENDING / EXPECTED. */
	state?: string;
	detailsUrl?: string;
	targetUrl?: string;
};

export type Pr = {
	number: number;
	title: string;
	state: 'OPEN' | 'CLOSED' | 'MERGED';
	url: string;
	isDraft: boolean;
	headRefName: string;
	baseRefName: string;
	mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
	reviewDecision: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
	statusCheckRollup: Check[] | null;
	additions?: number;
	deletions?: number;
	autoMergeRequest?: { enabledAt?: string } | null;
};

export type CheckKind = 'success' | 'failure' | 'cancelled' | 'pending' | 'skipped' | 'neutral' | 'action';

export function checkKind(c: Check): CheckKind {
	const v = (c.conclusion || c.state || '').toUpperCase();
	if (c.status && c.status !== 'COMPLETED' && !c.state) return 'pending';
	switch (v) {
		case 'SUCCESS':
			return 'success';
		case 'FAILURE':
		case 'ERROR':
		case 'TIMED_OUT':
		case 'STARTUP_FAILURE':
			return 'failure';
		case 'CANCELLED':
			return 'cancelled';
		case 'ACTION_REQUIRED':
			return 'action';
		case 'SKIPPED':
			return 'skipped';
		case 'PENDING':
		case 'EXPECTED':
		case '':
			return 'pending';
		default:
			return 'neutral';
	}
}

/** Orca's order: failures, cancelled, pending, success, neutral, skipped. */
export function checkRank(c: Check): number {
	return { failure: 0, action: 0, cancelled: 1, pending: 2, success: 3, neutral: 4, skipped: 5 }[checkKind(c)];
}

export function checkLabel(c: Check): string {
	const v = (c.conclusion || c.state || '').toUpperCase();
	if (c.status === 'QUEUED') return 'Queued';
	if (c.status === 'IN_PROGRESS') return 'In progress';
	return (
		{ SUCCESS: 'Successful', FAILURE: 'Failed', ERROR: 'Failed', CANCELLED: 'Cancelled', TIMED_OUT: 'Timed out', ACTION_REQUIRED: 'Action required', NEUTRAL: 'Neutral', SKIPPED: 'Skipped' }[v] ??
		'Pending'
	);
}

export type CheckCounts = { passed: number; failed: number; pending: number; neutral: number };
export function summarize(checks: Check[]): CheckCounts {
	const out: CheckCounts = { passed: 0, failed: 0, pending: 0, neutral: 0 };
	for (const c of checks) {
		const k = checkKind(c);
		if (k === 'success' || k === 'skipped') out.passed++;
		else if (k === 'failure' || k === 'cancelled' || k === 'action') out.failed++;
		else if (k === 'pending') out.pending++;
		else out.neutral++;
	}
	return out;
}

/** What a poll compares to tell "nothing changed" (and back off): the PR's state and every check. */
export const prSignature = (pr: Pr | null) => (pr ? `${pr.state}|${(pr.statusCheckRollup ?? []).map((c) => `${c.name ?? c.context}:${c.status}:${c.conclusion}:${c.state}`).join('|')}` : '');

export const CHECKS_POLL = { base: 60_000, settled: 120_000, closed: 15 * 60_000, maxError: 15 * 60_000 };

/**
 * When the Checks tab looks at the PR again (Orca's checks polling policy): every minute while
 * checks run or there is no PR yet, backing off to two minutes once an open PR's checks settle
 * and stop changing; a closed PR every 15 minutes; a merged one with settled checks never. A
 * failed look backs off from a minute, doubling up to 15. `null` = stop polling.
 */
export function checksPollDelay(pr: Pr | null, o: { failed: boolean; unchanged: boolean; prev: number }): number | null {
	if (o.failed) return Math.min(Math.max(CHECKS_POLL.base, o.prev * 2), CHECKS_POLL.maxError);
	if (!pr) return CHECKS_POLL.base;
	const pending = summarize(pr.statusCheckRollup ?? []).pending > 0;
	if (pr.state === 'MERGED') return pending ? CHECKS_POLL.base : null;
	if (pr.state === 'CLOSED') return CHECKS_POLL.closed;
	if (pending || !o.unchanged) return CHECKS_POLL.base;
	return Math.min(Math.max(o.prev * 2, CHECKS_POLL.base), CHECKS_POLL.settled);
}

/** GitHub's merge state as Orca labels it. */
export function mergeLabel(pr: Pr, counts: CheckCounts): string {
	if (pr.state === 'MERGED') return 'Merged';
	if (pr.state === 'CLOSED') return 'Closed';
	if (pr.isDraft) return 'Draft';
	if (pr.mergeable === 'CONFLICTING') return 'Conflicts';
	if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'Changes requested';
	if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'Approval required';
	if (counts.failed) return 'Checks failed';
	if (counts.pending) return 'Checks pending';
	if (pr.mergeable === 'UNKNOWN') return 'Checking';
	return counts.passed ? 'Checks passed' : 'Able to merge';
}

/** A PR conversation comment or a review (`gh pr view --json comments,reviews`). */
export type PrComment = {
	id?: string;
	author?: { login?: string };
	body?: string;
	createdAt?: string;
	submittedAt?: string;
	state?: string;
	url?: string;
	reactionGroups?: { content: string; users?: { totalCount: number }; reactors?: { totalCount: number }; viewerHasReacted?: boolean }[];
};

/** A review thread on the diff (GraphQL `reviewThreads`). */
export type ReviewThread = { id: string; isResolved: boolean; path: string; line: number | null; comments: { nodes: PrComment[] } };

export const REACTIONS: { content: string; emoji: string }[] = [
	{ content: 'THUMBS_UP', emoji: '👍' },
	{ content: 'THUMBS_DOWN', emoji: '👎' },
	{ content: 'LAUGH', emoji: '😄' },
	{ content: 'CONFUSED', emoji: '😕' },
	{ content: 'HEART', emoji: '❤️' },
	{ content: 'HOORAY', emoji: '🎉' },
	{ content: 'ROCKET', emoji: '🚀' },
	{ content: 'EYES', emoji: '👀' }
];
/** Reaction pills with their counts, in GitHub's order. */
export function reactionPills(c: PrComment): { content: string; emoji: string; count: number; mine: boolean }[] {
	return REACTIONS.flatMap((r) => {
		const g = c.reactionGroups?.find((x) => x.content === r.content);
		const count = g?.users?.totalCount ?? g?.reactors?.totalCount ?? 0;
		return count ? [{ ...r, count, mine: !!g?.viewerHasReacted }] : [];
	});
}

