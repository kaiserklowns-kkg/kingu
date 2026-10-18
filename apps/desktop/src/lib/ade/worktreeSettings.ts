// How new task worktrees are made, from the ADE settings (Orca's worktree settings): the branch
// prefix, the default base branch and what happens to the branch when a task is removed. Pure,
// so `bun test` covers it; Rust checks the prefix again (agent/worktree.rs validate_prefix).

export const DEFAULT_BRANCH_PREFIX = 'kingu/';

/** The same rules as Rust's `validate_prefix`: ASCII letters, digits and `._/-`, may be empty. */
export function validBranchPrefix(prefix: string): boolean {
	return (
		prefix.length <= 64 &&
		/^[A-Za-z0-9._/-]*$/.test(prefix) &&
		!/^[-/.]/.test(prefix) &&
		!prefix.includes('..') &&
		!prefix.includes('//') &&
		!prefix.includes('/.')
	);
}

/** `kingu.worktree.branchPrefix` trimmed, or null when it is invalid (creating then refuses). */
export function branchPrefix(setting: string | undefined): string | null {
	const p = (setting ?? DEFAULT_BRANCH_PREFIX).trim();
	return validBranchPrefix(p) ? p : null;
}

/**
 * The base branch a new task starts from when the form has no pick: `kingu.worktree.baseBranch`
 * when that branch exists, else the folder's current branch, else the first local branch.
 */
export function defaultBaseBranch(setting: string | undefined, current: string | null | undefined, branches: readonly string[]): string {
	const wanted = (setting ?? '').trim();
	if (wanted && branches.includes(wanted)) return wanted;
	if (current && branches.includes(current)) return current;
	return branches[0] ?? '';
}

export type BranchOnRemove = 'keep' | 'deleteMerged' | 'delete';

/**
 * Whether removing a task also deletes its branch (`kingu.worktree.deleteBranchOnRemove`):
 * `deleteMerged` only once the task was merged locally or its PR was merged.
 */
export function deleteBranchOnRemove(setting: string | undefined, task: { merged: boolean }): boolean {
	if (setting === 'delete') return true;
	if (setting === 'deleteMerged') return task.merged;
	return false;
}

export type SetupScript = { path: string; content: string; hash: string; trusted: boolean };

/** The setup terminal's command: the trusted copy of `.kingu/setup.sh`, told where the folder and worktree are. */
export function setupCommand(file: string, root: string, worktree: string): string[] {
	return ['env', `KINGU_ROOT_PATH=${root}`, `KINGU_WORKTREE_PATH=${worktree}`, 'sh', file];
}

/** What the trust dialog shows of a script: its first lines, so a long one stays readable. */
export function scriptPreview(content: string, maxLines = 20): string {
	const lines = content.replace(/\s+$/, '').split('\n');
	return lines.length > maxLines ? [...lines.slice(0, maxLines), `… (อีก ${lines.length - maxLines} บรรทัด)`].join('\n') : lines.join('\n');
}
