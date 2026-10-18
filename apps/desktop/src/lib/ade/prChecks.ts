// A task branch's pull request and CI checks (Orca's Checks panel), from Rust `worktree_pr` (its `status`)
// (`gh pr view`). Pure, so `bun test` covers it.

import { t } from '#lib/i18n/index.ts';

export type CheckState = 'pending' | 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled';
export type PrCheck = { name: string; state: CheckState; url: string | null; run_id?: number | null; job_id?: number | null };
export type PrStatus = {
	number: number;
	url: string;
	title: string;
	state: 'OPEN' | 'CLOSED' | 'MERGED' | string;
	draft: boolean;
	review: string;
	mergeable: string;
	/** GitHub's mergeStateStatus: CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, DRAFT, UNKNOWN or ''. */
	merge_state?: string;
	head_ref?: string;
	base_ref?: string;
	checks: PrCheck[];
};

export type ChecksSummary = { total: number; pending: number; failed: number; passed: number; overall: CheckState | 'none' };

export function summarizeChecks(checks: PrCheck[]): ChecksSummary {
	const count = (s: CheckState) => checks.filter((c) => c.state === s).length;
	const failed = count('failure');
	const pending = count('pending');
	const passed = count('success');
	const overall: ChecksSummary['overall'] = !checks.length ? 'none' : failed ? 'failure' : pending ? 'pending' : passed ? 'success' : 'neutral';
	return { total: checks.length, pending, failed, passed, overall };
}

/** Failures first, then running, then the rest (what needs attention on top). */
export function sortChecks(checks: PrCheck[]): PrCheck[] {
	const rank: Record<CheckState, number> = { failure: 0, pending: 1, cancelled: 2, neutral: 3, skipped: 4, success: 5 };
	return [...checks].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}

/** One line under the PR title: draft / merged / review decision / conflicts. */
export function prLine(pr: PrStatus): string {
	const parts = [t(pr.state === 'MERGED' ? 'ade.prChecks.merged' : pr.state === 'CLOSED' ? 'ade.prChecks.closed' : pr.draft ? 'ade.prChecks.draft' : 'ade.prChecks.open')];
	if (pr.review === 'APPROVED') parts.push(t('ade.prChecks.approved'));
	else if (pr.review === 'CHANGES_REQUESTED') parts.push(t('ade.prChecks.changesRequested'));
	else if (pr.review === 'REVIEW_REQUIRED') parts.push(t('ade.prChecks.reviewRequired'));
	if (pr.mergeable === 'CONFLICTING') parts.push(t('ade.prChecks.conflictsWithBase'));
	return parts.join(' · ');
}

// -------------------------------------------------------------------------------------------
// Merge (Orca: github-pr-merge-state.ts, pull-request-merge-methods.ts)

export type MergeMethod = 'squash' | 'merge' | 'rebase';
export const MERGE_METHODS: MergeMethod[] = ['squash', 'merge', 'rebase'];
export const MERGE_LABEL: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create merge commit', rebase: 'Rebase and merge' };

/** What the PR's repository allows (Rust `gh_merge_settings`). */
export type RepoMergeSettings = { squash: boolean; merge: boolean; rebase: boolean; default: string };

/** The default method first, then the other allowed ones; all three when nothing is known. */
export function mergeMethods(settings: RepoMergeSettings | null | undefined): { defaultMethod: MergeMethod; methods: MergeMethod[] } {
	const allowed = (m: MergeMethod) => (settings ? settings[m] : true);
	const preferred = settings?.default.toLowerCase() as MergeMethod | undefined;
	const first = MERGE_METHODS.find(allowed);
	const defaultMethod = preferred && MERGE_METHODS.includes(preferred) && allowed(preferred) ? preferred : (first ?? 'squash');
	const ordered = [defaultMethod, ...MERGE_METHODS.filter((m) => m !== defaultMethod)].filter(allowed);
	return { defaultMethod, methods: ordered.length ? ordered : MERGE_METHODS };
}

export type MergeTone = 'ok' | 'warn' | 'error' | 'neutral';
/** The label beside the merge button, its explanation, and whether a direct merge is offered. */
export type MergePresentation = { label: string; tone: MergeTone; tooltip: string; canMerge: boolean };

/**
 * Orca's merge-state gate, in its order: merged / closed / draft, review required or changes
 * requested, then GitHub's mergeability (conflicts, behind, blocked), then checks. A failing or
 * running check only warns (GitHub blocks it through BLOCKED when the check is required); the
 * merge itself re-checks on GitHub first.
 */
export function mergePresentation(pr: PrStatus): MergePresentation {
	const checks = summarizeChecks(pr.checks).overall;
	const passed = (): MergePresentation => ({ label: t('ade.prChecks.passedLabel'), tone: 'ok', tooltip: t('ade.prChecks.passedTip'), canMerge: true });
	if (pr.state === 'MERGED') return { label: t('ade.prChecks.mergedLabel'), tone: 'neutral', tooltip: t('ade.prChecks.mergedTip'), canMerge: false };
	if (pr.state === 'CLOSED') return { label: t('ade.prChecks.closedLabel'), tone: 'error', tooltip: t('ade.prChecks.closedTip'), canMerge: false };
	if (pr.draft) return { label: t('ade.prChecks.draftLabel'), tone: 'neutral', tooltip: t('ade.prChecks.draftTip'), canMerge: false };
	if (pr.review === 'REVIEW_REQUIRED') return { label: t('ade.prChecks.approvalLabel'), tone: 'warn', tooltip: t('ade.prChecks.approvalTip'), canMerge: false };
	if (pr.review === 'CHANGES_REQUESTED') return { label: t('ade.prChecks.changesLabel'), tone: 'error', tooltip: t('ade.prChecks.changesTip'), canMerge: false };
	const state = pr.merge_state ?? '';
	const known = !!pr.mergeable && pr.mergeable !== 'UNKNOWN';
	if (!known && !state) return checks === 'success' ? passed() : { label: t('ade.prChecks.mergeLabel'), tone: 'neutral', tooltip: t('ade.prChecks.unknownTip'), canMerge: false };
	if (pr.mergeable === 'CONFLICTING' || state === 'DIRTY') return { label: t('ade.prChecks.conflictLabel'), tone: 'error', tooltip: t('ade.prChecks.conflictTip'), canMerge: false };
	if (state === 'BEHIND') return { label: t('ade.prChecks.behindLabel'), tone: 'warn', tooltip: t('ade.prChecks.behindTip'), canMerge: false };
	if (state === 'BLOCKED') return { label: t('ade.prChecks.blockedLabel'), tone: 'error', tooltip: t('ade.prChecks.blockedTip'), canMerge: false };
	if (pr.mergeable === 'MERGEABLE' || state === 'CLEAN') {
		if (checks === 'failure') return { label: t('ade.prChecks.failedLabel'), tone: 'error', tooltip: t('ade.prChecks.failedTip'), canMerge: true };
		if (checks === 'pending') return { label: t('ade.prChecks.pendingLabel'), tone: 'warn', tooltip: t('ade.prChecks.pendingTip'), canMerge: true };
		return { label: t('ade.prChecks.mergeableLabel'), tone: 'ok', tooltip: checks === 'success' ? t('ade.prChecks.mergeablePassedTip') : t('ade.prChecks.mergeableTip'), canMerge: true };
	}
	if (checks === 'success') return passed();
	return { label: t('ade.prChecks.computingLabel'), tone: 'neutral', tooltip: t('ade.prChecks.computingTip'), canMerge: false };
}

/** Failed checks the "fix failing checks" prompt is about (Orca's broken checks: failure, cancelled, timed out). */
export function brokenChecks(checks: PrCheck[]): PrCheck[] {
	return checks.filter((c) => c.state === 'failure' || c.state === 'cancelled');
}

/** `host/owner/repo` of a PR URL. */
export function repoOf(url: string): string | null {
	const m = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
	return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}
