// A task branch's pull request and CI checks (Orca's Checks panel), from Rust `worktree_pr_status`
// (`gh pr view`). Pure, so `bun test` covers it.

export type CheckState = 'pending' | 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled';
export type PrCheck = { name: string; state: CheckState; url: string | null };
export type PrStatus = {
	number: number;
	url: string;
	title: string;
	state: 'OPEN' | 'CLOSED' | 'MERGED' | string;
	draft: boolean;
	review: string;
	mergeable: string;
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
	const parts = [pr.state === 'MERGED' ? 'merged แล้ว' : pr.state === 'CLOSED' ? 'ปิดแล้ว' : pr.draft ? 'draft' : 'open'];
	if (pr.review === 'APPROVED') parts.push('อนุมัติแล้ว');
	else if (pr.review === 'CHANGES_REQUESTED') parts.push('ขอให้แก้');
	else if (pr.review === 'REVIEW_REQUIRED') parts.push('รอรีวิว');
	if (pr.mergeable === 'CONFLICTING') parts.push('มี conflict กับ base');
	return parts.join(' · ');
}
