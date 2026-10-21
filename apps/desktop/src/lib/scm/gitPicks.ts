// Pure helpers of the git commands in gitCommands.svelte.ts: the pickers' items (branches, tags,
// remotes, worktrees) and the names and paths they suggest. Shapes mirror Rust `git_ops.rs`.

import type { PickItem } from '#lib/workbench/quick.svelte.ts';
import type { BranchRef } from '#lib/workbench/scmRemote.ts';

/** A remote (Rust `git_ops::Remote`). */
export type Remote = { name: string; fetch_url: string; push_url: string };

/** A worktree (Rust `agent::worktree::WorktreeInfo`); the first one listed is the main worktree. */
export type Worktree = { path: string; head: string | null; branch: string | null; slug: string | null; bare: boolean; detached: boolean; locked: boolean; prunable: boolean };

/** How a merge, rebase or cherry-pick ended (Rust `git_ops::Outcome`). */
export type Outcome = 'done' | 'conflicts';

/**
 * Refs to pick from (Merge Branch, Rebase Branch, Compare with…): local branches, remote branches,
 * then tags with their own separators; the current branch is left out with `skipCurrent`.
 */
export function refItems(refs: readonly BranchRef[], labels: { branches: string; remotes: string; tags: string }, { skipCurrent = true, tags = true } = {}): PickItem[] {
	const groups: [string, BranchRef[]][] = [
		[labels.branches, refs.filter((r) => !r.remote && !r.tag && !(skipCurrent && r.current))],
		[labels.remotes, refs.filter((r) => r.remote)],
		[labels.tags, tags ? refs.filter((r) => r.tag) : []]
	];
	return groups.flatMap(([separator, list]) =>
		list.map((r, i) => ({ id: r.name, label: r.name, description: `${r.commit} ${r.subject}`.trim(), ...(i === 0 ? { separator } : {}) }))
	);
}

/** Tags to delete. */
export const tagItems = (refs: readonly BranchRef[]): PickItem[] => refs.filter((r) => r.tag).map((r) => ({ id: r.name, label: r.name, description: `${r.commit} ${r.subject}`.trim() }));

export const remoteItems = (remotes: readonly Remote[]): PickItem[] => remotes.map((r) => ({ id: r.name, label: r.name, description: r.fetch_url }));

/** The remote a command uses without asking: the only one (several: the user picks). */
export const defaultRemote = (remotes: readonly Remote[]): string | undefined => (remotes.length === 1 ? remotes[0].name : undefined);

/** The name Add Remote suggests: `origin` for the first remote, else none. */
export const suggestedRemoteName = (remotes: readonly Remote[]) => (remotes.some((r) => r.name === 'origin') ? '' : 'origin');

/**
 * Worktrees the user may act on: never the main one (listed first) nor the ADE's task worktrees
 * (`slug`), and not `except` (the one this window shows).
 */
export function worktreeItems(list: readonly Worktree[], except?: string): PickItem[] {
	return list
		.slice(1)
		.filter((w) => !w.slug && !w.bare && w.path !== except)
		.map((w) => ({ id: w.path, label: w.path.slice(w.path.lastIndexOf('/') + 1), description: [w.branch ?? (w.head ? w.head.slice(0, 7) : ''), w.path].filter(Boolean).join(' · ') }));
}

/** Where Create Worktree suggests the new folder: `<parent>/<repo>.worktrees/<branch>` (VS Code). */
export function defaultWorktreePath(repoDir: string, branch: string): string {
	const dir = repoDir.replace(/\/+$/, '');
	const parent = dir.slice(0, dir.lastIndexOf('/')) || '';
	const name = dir.slice(dir.lastIndexOf('/') + 1);
	return `${parent}/${name}.worktrees/${branch.replace(/[\\/:*?"<>|\s]+/g, '-')}`;
}

/** One name, or "N files" for several (confirmations). */
export const summarize = (names: readonly string[], many: (count: number) => string) => (names.length === 1 ? names[0] : many(names.length));
