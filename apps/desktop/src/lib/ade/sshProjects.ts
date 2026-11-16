// Projects on SSH hosts: the shapes Rust's ssh_projects.rs returns and how the side bar reads
// them. Pure, so `bun test` covers it; the store is sshProjects.svelte.ts.

import type { WorktreeInfo } from '#lib/agent/events.ts';
import { slugify } from '#lib/agent/events.ts';
import type { Project } from './projects';

/** A project of `ssh_projects_list`: projects.json's record with its SSH host set. */
export type RemoteProject = Project & { host: string };

/** One worktree of `ssh_project_worktrees`: git's listing plus its `git status`. */
export type RemoteWorktree = WorktreeInfo & { changes: number | null; upstream: string | null; ahead: number; behind: number };

/** A project's key in the store (the same path can live on two hosts). */
export const remoteKey = (p: { host: string; path: string }) => `${p.host}\u0000${p.path}`;

/** The main checkout first, then task worktrees by slug, then any other worktree by path. */
export function sortWorktrees(rows: readonly RemoteWorktree[], root: string): RemoteWorktree[] {
	const rank = (w: RemoteWorktree) => (w.path === root ? 0 : w.slug ? 1 : 2);
	return [...rows].sort((a, b) => rank(a) - rank(b) || (a.slug ?? a.path).localeCompare(b.slug ?? b.path));
}

/** A row's git summary: `kingu/fix · 3 changed · ↑1 ↓2` (detached: the short commit). */
export function gitSummary(w: RemoteWorktree): { branch: string; changes: number | null; ahead: number; behind: number } {
	const branch = w.branch ?? (w.head ? w.head.slice(0, 7) : '—');
	return { branch, changes: w.changes, ahead: w.ahead, behind: w.behind };
}

/** A task title → the worktree slug Rust accepts (same rule as local tasks). */
export const remoteSlug = (title: string) => slugify(title);

/** The worktree a slug would make, `<root>/.kingu/worktrees/<slug>` (as on this computer). */
export const remoteWorktreePath = (root: string, slug: string) => `${root.replace(/\/+$/, '')}/.kingu/worktrees/${slug}`;

/** A typed host path, or null: `~`, `~/x` or an absolute POSIX path, no control characters. */
export function hostPath(text: string): string | null {
	const p = text.trim();
	// eslint-disable-next-line no-control-regex
	if (!p || /[\x00-\x1f\x7f]/.test(p)) return null;
	return p === '~' || p.startsWith('~/') || p.startsWith('/') ? p : null;
}
