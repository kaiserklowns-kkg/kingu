// A task branch's pull request and CI checks (Orca's Checks panel), from Rust `worktree_pr_status`
// (`gh pr view`). Pure, so `bun test` covers it.

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
	const parts = [pr.state === 'MERGED' ? 'merged แล้ว' : pr.state === 'CLOSED' ? 'ปิดแล้ว' : pr.draft ? 'draft' : 'open'];
	if (pr.review === 'APPROVED') parts.push('อนุมัติแล้ว');
	else if (pr.review === 'CHANGES_REQUESTED') parts.push('ขอให้แก้');
	else if (pr.review === 'REVIEW_REQUIRED') parts.push('รอรีวิว');
	if (pr.mergeable === 'CONFLICTING') parts.push('มี conflict กับ base');
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
	const passed = (): MergePresentation => ({ label: 'Checks ผ่าน', tone: 'ok', tooltip: 'checks ผ่านแล้ว จะตรวจว่า merge ได้อีกครั้งก่อน merge', canMerge: true });
	if (pr.state === 'MERGED') return { label: 'Merged', tone: 'neutral', tooltip: 'PR นี้ merge แล้ว', canMerge: false };
	if (pr.state === 'CLOSED') return { label: 'ปิดแล้ว', tone: 'error', tooltip: 'PR นี้ถูกปิดแล้ว', canMerge: false };
	if (pr.draft) return { label: 'Draft', tone: 'neutral', tooltip: 'PR นี้ยังเป็น draft', canMerge: false };
	if (pr.review === 'REVIEW_REQUIRED') return { label: 'ต้องได้รับอนุมัติ', tone: 'warn', tooltip: 'GitHub ต้องการการอนุมัติ (review) ก่อน merge', canMerge: false };
	if (pr.review === 'CHANGES_REQUESTED') return { label: 'ขอให้แก้', tone: 'error', tooltip: 'ผู้รีวิวขอให้แก้ PR นี้', canMerge: false };
	const state = pr.merge_state ?? '';
	const known = !!pr.mergeable && pr.mergeable !== 'UNKNOWN';
	if (!known && !state) return checks === 'success' ? passed() : { label: 'Merge', tone: 'neutral', tooltip: 'ยังไม่รู้สถานะการ merge ของ PR นี้', canMerge: false };
	if (pr.mergeable === 'CONFLICTING' || state === 'DIRTY') return { label: 'มี conflict', tone: 'error', tooltip: 'GitHub บอกว่ามี conflict กับ base', canMerge: false };
	if (state === 'BEHIND') return { label: 'ตามหลัง base', tone: 'warn', tooltip: 'อัปเดต branch กับ base ก่อน merge', canMerge: false };
	if (state === 'BLOCKED') return { label: 'ถูกบล็อก', tone: 'error', tooltip: 'GitHub บล็อก PR นี้ไว้ (เช่น required check ไม่ผ่าน หรือกฎของ branch)', canMerge: false };
	if (pr.mergeable === 'MERGEABLE' || state === 'CLEAN') {
		if (checks === 'failure') return { label: 'Checks ล้มเหลว', tone: 'error', tooltip: 'GitHub ให้ merge ได้ แต่มี check ล้มเหลว', canMerge: true };
		if (checks === 'pending') return { label: 'Checks กำลังรัน', tone: 'warn', tooltip: 'GitHub ให้ merge ได้ แต่ checks ยังรันอยู่', canMerge: true };
		return { label: 'Merge ได้', tone: 'ok', tooltip: checks === 'success' ? 'GitHub ให้ merge ได้และ checks ผ่าน' : 'GitHub ให้ merge ได้', canMerge: true };
	}
	if (checks === 'success') return passed();
	return { label: 'กำลังตรวจ', tone: 'neutral', tooltip: 'GitHub ยังคำนวณสถานะการ merge อยู่', canMerge: false };
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
