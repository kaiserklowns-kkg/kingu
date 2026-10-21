// Multi-file diffs of history (VS Code's multi-diff editor for a commit, a range and a stash), shown
// by the combined diff view (CombinedDiff.svelte) under its `changes:` editor keys:
//
// - `changes:@range/<repo>/<from or _>/<to>/<title>`: `to` against `from`, or against its first
//   parent with `_` (a commit's changes, Incoming/Outgoing Changes, Compare with…);
// - `changes:@stash/<repo>/<index>/<hash>/<title>`: a stash (Git: View Stash).
//
// Every part is URI-encoded. `repo` is the repository directory (`scm` Repository.dir); a file of
// it opens as a `refdiff://` diff of the two revisions. Pure, so bun tests cover it.

import { CHANGES_PREFIX } from '#lib/workbench/viewers.ts';

export type RangeChanges = { kind: 'range'; repo: string; from: string | null; to: string; title: string };
export type StashChanges = { kind: 'stash'; repo: string; index: number; hash: string; title: string };
export type HistoryChanges = RangeChanges | StashChanges;

const enc = encodeURIComponent;

export const rangeChangesKey = (repo: string, from: string | null, to: string, title: string) => `${CHANGES_PREFIX}@range/${enc(repo)}/${from ? enc(from) : '_'}/${enc(to)}/${enc(title)}`;
export const stashChangesKey = (repo: string, index: number, hash: string, title: string) => `${CHANGES_PREFIX}@stash/${enc(repo)}/${index}/${enc(hash)}/${enc(title)}`;

/** The start of every stash page key of `repo` (they close when a stash goes: the indexes move). */
export const stashChangesPrefix = (repo: string) => `${CHANGES_PREFIX}@stash/${enc(repo)}/`;

/** Whether a `changes:` key is one of these (not the folder's or a task's changes). */
export const isHistoryChangesKey = (key: string) => key.startsWith(`${CHANGES_PREFIX}@`);

export function parseHistoryChangesKey(key: string): HistoryChanges | null {
	if (!isHistoryChangesKey(key)) return null;
	const [kind, ...parts] = key.slice(CHANGES_PREFIX.length + 1).split('/');
	try {
		if (kind === 'range' && parts.length === 4) {
			const [repo, from, to, title] = parts;
			return { kind, repo: decodeURIComponent(repo), from: from === '_' ? null : decodeURIComponent(from), to: decodeURIComponent(to), title: decodeURIComponent(title) };
		}
		if (kind === 'stash' && parts.length === 4) {
			const [repo, index, hash, title] = parts;
			const n = Number(index);
			if (!Number.isInteger(n) || n < 0) return null;
			return { kind, repo: decodeURIComponent(repo), index: n, hash: decodeURIComponent(hash), title: decodeURIComponent(title) };
		}
	} catch {
		// A malformed escape: not a key of ours.
	}
	return null;
}

/**
 * The two revisions a file of `c` is diffed between: the left one (a range without `from` takes
 * `to`'s first parent; a stash its base commit, or nothing for an untracked file) and the right one.
 */
export function fileRevisions(c: HistoryChanges, untracked = false): { left: string; right: string } {
	if (c.kind === 'stash') return untracked ? { left: `${c.hash}^3^`, right: `${c.hash}^3` } : { left: `${c.hash}^1`, right: c.hash };
	return { left: c.from ?? `${c.to}^`, right: c.to };
}
