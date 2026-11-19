// Commit (Amend) in the ADE's Source Control: when it is offered, what it rewrites and what the
// user must agree to first. Orca's source has no Amend action (its `DropdownActionKind` in
// src/shared/source-control/dropdown/source-control-dropdown-item-types.ts stops at commit,
// commit_push, commit_sync), so the rules here follow the Orca rules around it:
// - the commit items are off while something else runs or conflicts are unresolved
//   (source-control-dropdown-remote-items.ts: `globalBusy`, detached HEAD blocks the remote items);
// - rewritten history is never pushed by a plain Push or as a fallback: Force Push is its own,
//   explicit action and always `--force-with-lease` (src/main/git/remotes/remote.ts:45,
//   docs/site/content/docs/review/commit-push.mdx:21).
// Pure.

/** `git_amend_info` (git.rs `AmendInfo`): the last commit's message and the remote branches that have it. */
export type AmendInfo = { message: string; pushed: string[] };

export type AmendBlock = 'busy' | 'noCommit' | 'conflicts' | 'operation' | 'detached' | 'nothing';

/**
 * Why Commit (Amend) is off, or null when it can run. `nothing`: no staged change and no typed
 * message, so the amended commit would be the same commit.
 */
export function amendBlock(s: { busy: boolean; head: string | null; detached: boolean; operation: string | null; conflicts: number; staged: number; message: string }): AmendBlock | null {
	if (s.busy) return 'busy';
	if (!s.head) return 'noCommit';
	if (s.conflicts) return 'conflicts';
	// A merge, rebase, cherry-pick or revert half-way: amending would rewrite the commit it stands on.
	if (s.operation) return 'operation';
	if (s.detached) return 'detached';
	if (!s.staged && !s.message.trim()) return 'nothing';
	return null;
}

export type AmendPlan =
	/** Same message, nothing staged: nothing to rewrite. */
	| { kind: 'unchanged' }
	| {
			kind: 'amend';
			/** The typed message, or the last commit's when the box is empty. */
			message: string;
			/** Remote branches that already have the commit: ask before rewriting it ([] = local only). */
			confirm: string[];
			/** The branch's own upstream has it: after the amend only a force push with lease updates it. */
			forcePush: boolean;
	  };

/** What Commit (Amend) does with the last commit, given what the user typed and staged. */
export function amendPlan(info: AmendInfo, s: { message: string; staged: number; upstream: string | null }): AmendPlan {
	const message = s.message.trim() || info.message.trim();
	if (!s.staged && message === info.message.trim()) return { kind: 'unchanged' };
	return { kind: 'amend', message, confirm: info.pushed, forcePush: !!s.upstream && info.pushed.includes(s.upstream) };
}

/**
 * An amend whose old copy is still on the branch's upstream: the local branch now shows `behind`
 * commits it must not pull back. Kept per worktree until a force push (or anything else) changes
 * the counts it was taken with.
 */
export type AmendedPending = { branch: string; upstream: string; ahead: number; behind: number };

/** After a successful amend of a commit the upstream already has, with the status read after it. */
export function amendedPending(s: { branch: string | null; upstream: string | null; ahead: number; behind: number }): AmendedPending | null {
	if (!s.branch || !s.upstream || !s.behind) return null;
	return { branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind };
}

/**
 * Whether the pending amend still explains the divergence: same branch and upstream, the same
 * commits behind (a fetch that brought someone else's work changes it, and then a force push would
 * drop theirs), and at least as many ahead (new local commits on top are fine).
 */
export function stillAmended(p: AmendedPending | null | undefined, s: { branch: string | null; upstream: string | null; ahead: number; behind: number }): boolean {
	return !!p && s.branch === p.branch && s.upstream === p.upstream && s.behind === p.behind && s.ahead >= p.ahead;
}
