// The create-PR form (Orca's CreateHostedReviewComposer): title, body, base and draft, seeded
// once when the form opens and then the user's to edit. Pure.

import { prBody } from './issues.ts';
import type { TaskMeta } from './model.ts';

export type Commit = { subject: string; body: string };
export type PrForm = { title: string; body: string; base: string; draft: boolean };

/** Orca's humanizeBranchSlug: `fix-login-page` → `Fix login page`. */
export function humanizeBranchSlug(slug: string): string {
	const joined = slug.split('-').filter(Boolean).join(' ');
	return joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : '';
}

/** Orca's resolveCreateReviewDraftTitle without a provider title: the branch's last segment, humanized. */
export function branchTitle(branch: string): string {
	const leaf = (branch.split('/').pop() ?? '').replace(/_/g, '-');
	return humanizeBranchSlug(leaf) || branch;
}

/**
 * The form's first values. Title: the only commit's subject (what `gh pr create --fill` would
 * use), else the task's name, else the branch humanized (Orca's fallback; an adopted worktree's
 * name is just its slug). Body: `Fixes #N` for an issue task, the only commit's body or else the
 * task prompt. Draft from `kingu.pr.draft`, base from the task.
 */
export function prefillPr(meta: Pick<TaskMeta, 'slug' | 'title' | 'prompt' | 'base' | 'issue'>, branch: string, commits: Commit[], draft: boolean): PrForm {
	const only = commits.length === 1 ? commits[0] : null;
	const named = meta.title.trim() && meta.title.trim() !== meta.slug ? meta.title.trim() : '';
	const title = only?.subject.trim() || named || branchTitle(branch);
	const body = prBody({ slug: meta.slug, issue: meta.issue, prompt: only?.body.trim() || meta.prompt.trim() });
	return { title, body, base: meta.base, draft };
}

/** Why Create is disabled (Orca's reasons), or null when the form can be sent. */
export function prFormProblem(form: Pick<PrForm, 'title' | 'base'>, branch: string): string | null {
	if (!form.title.trim()) return 'ใส่ชื่อ PR';
	if (!form.base.trim()) return 'เลือก base branch';
	if (form.base.trim().toLowerCase() === branch.trim().toLowerCase()) return 'base ต้องไม่ใช่ branch ของงานเอง';
	return null;
}

/** The submit button (Orca: "Push & Create PR" / "Create draft PR"). */
export const prSubmitLabel = (draft: boolean, busy: boolean) => (busy ? 'กำลังสร้าง…' : draft ? 'Push และสร้าง draft PR' : 'Push และสร้าง PR');
