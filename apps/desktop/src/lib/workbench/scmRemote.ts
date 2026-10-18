// Pure helpers for remotes and branches (VS Code's git extension: sync status bar item, Checkout
// to…, stash picks). Shapes mirror Rust `git_remote.rs`.

import type { PickItem } from '#lib/workbench/quick.svelte.ts';
import type { GitStatus } from '#lib/workbench/scm.ts';
import { t } from '#lib/i18n/index.ts';
import { isRustError } from '#lib/i18n/rustErrors.ts';

export type BranchRef = {
	/** `main`, or `origin/main` for a remote branch. */
	name: string;
	remote: boolean;
	current: boolean;
	upstream: string | null;
	/** Checked out in another worktree (e.g. a task's `.kingu/worktrees/<slug>`). */
	worktree: string | null;
	commit: string;
	subject: string;
	/** A tag (listed when `git.checkoutType` has `tags`); checked out detached. */
	tag?: boolean;
	/** Commit or tag date in seconds, for `git.branchSortOrder: committerdate`. */
	date?: number;
};

export type Stash = { index: number; message: string; branch: string | null; when: string };

export type DeleteResult = 'deleted' | 'not_merged';

/** Rust's message for a rejected or missing credential (`GitMsg::AuthFailed`), in either language. */
export const isAuthError = (e: unknown) => isRustError(e, 'remoteAuthFailed');

export type SyncItem = { label: string; title: string; command: 'git.sync' | 'git.publish' };

/** The status bar's sync item next to the branch: `↓n ↑m` with an upstream, Publish without. */
export function syncItem(repo: GitStatus | null): SyncItem | null {
	if (!repo?.branch || repo.detached) return null;
	if (!repo.upstream || repo.upstream_gone) {
		if (!repo.remotes.length) return null;
		const title = repo.upstream_gone ? t('workbench.scmRemote.publishGone', { upstream: repo.upstream ?? '', branch: repo.branch }) : t('workbench.scmRemote.publish', { branch: repo.branch });
		return { label: '', title, command: 'git.publish' };
	}
	return {
		label: `↓${repo.behind} ↑${repo.ahead}`,
		title: t('workbench.scmRemote.sync', { behind: repo.behind, ahead: repo.ahead, upstream: repo.upstream }),
		command: 'git.sync'
	};
}

/** The status bar's branch text: the branch, or the short commit when detached. */
export const branchLabel = (repo: GitStatus | null): string | null => (repo ? (repo.branch ?? repo.head) : null);

export const CREATE_BRANCH = '__create';
export const CREATE_BRANCH_FROM = '__createFrom';
const WORKTREE_PREFIX = 'worktree:';
const TAG_PREFIX = 'tag:';

export type CheckoutType = 'local' | 'remote' | 'tags';
export type BranchSortOrder = 'committerdate' | 'alphabetically';
export type CheckoutItemOptions = {
	create?: boolean;
	/** `git.checkoutType`: which kinds of refs, in this order. */
	types?: readonly CheckoutType[];
	/** `git.branchSortOrder`: newest first, or by name. */
	sort?: BranchSortOrder;
	/** `git.showReferenceDetails`: the commit and its subject next to each ref. */
	details?: boolean;
};

/** `git.branchSortOrder` within one section. */
export function sortRefs(refs: readonly BranchRef[], sort: BranchSortOrder): BranchRef[] {
	const byName = (a: BranchRef, b: BranchRef) => a.name.localeCompare(b.name);
	return [...refs].sort(sort === 'committerdate' ? (a, b) => (b.date ?? 0) - (a.date ?? 0) || byName(a, b) : byName);
}

/**
 * VS Code's "Select a branch or tag to checkout": create actions, then local branches, remote
 * branches and tags in `git.checkoutType` order. Branches held by another worktree come last,
 * marked; accepting one explains why not.
 */
export function checkoutItems(refs: BranchRef[], { create = true, types = ['local', 'remote', 'tags'], sort = 'alphabetically', details = true }: CheckoutItemOptions = {}): PickItem[] {
	const items: PickItem[] = [];
	if (create) {
		items.push({ id: CREATE_BRANCH, label: t('workbench.scmRemote.createBranch') }, { id: CREATE_BRANCH_FROM, label: t('workbench.scmRemote.createBranchFrom') });
	}
	const free = refs.filter((r) => !r.current && !r.worktree);
	const of: Record<CheckoutType, [string, BranchRef[], string]> = {
		local: [t('workbench.scmRemote.branches'), free.filter((r) => !r.remote && !r.tag), ''],
		remote: [t('workbench.scmRemote.remoteBranches'), free.filter((r) => r.remote), ''],
		tags: [t('workbench.scmRemote.tags'), free.filter((r) => r.tag), TAG_PREFIX]
	};
	for (const type of new Set(types)) {
		const [title, list, prefix] = of[type] ?? ['', [], ''];
		sortRefs(list, sort).forEach((r, i) =>
			items.push({ id: prefix + r.name, label: r.name, description: details ? `${r.commit} ${r.subject}`.trim() : undefined, separator: i === 0 ? title : undefined })
		);
	}
	refs
		.filter((r) => r.worktree && !r.remote)
		.forEach((r, i) =>
			items.push({ id: WORKTREE_PREFIX + r.name, label: r.name, description: t('workbench.scmRemote.inWorktree', { worktree: r.worktree ?? '' }), separator: i === 0 ? t('workbench.scmRemote.inOtherWorktrees') : undefined })
		);
	return items;
}

/** What accepting a checkout item means. */
export type CheckoutTarget = { kind: 'create' } | { kind: 'createFrom' } | { kind: 'worktree'; ref: BranchRef } | { kind: 'ref'; ref: BranchRef };

export function checkoutTarget(id: string, refs: BranchRef[]): CheckoutTarget | null {
	if (id === CREATE_BRANCH) return { kind: 'create' };
	if (id === CREATE_BRANCH_FROM) return { kind: 'createFrom' };
	if (id.startsWith(TAG_PREFIX)) {
		const ref = refs.find((r) => r.tag && r.name === id.slice(TAG_PREFIX.length));
		return ref ? { kind: 'ref', ref } : null;
	}
	const name = id.startsWith(WORKTREE_PREFIX) ? id.slice(WORKTREE_PREFIX.length) : id;
	const ref = refs.find((r) => !r.tag && r.name === name && (id.startsWith(WORKTREE_PREFIX) ? !r.remote : true));
	if (!ref) return null;
	return ref.worktree ? { kind: 'worktree', ref } : { kind: 'ref', ref };
}

/** Delete Branch candidates: local branches that are not checked out anywhere. */
export const deletableBranches = (refs: BranchRef[]): PickItem[] =>
	refs.filter((r) => !r.remote && !r.tag && !r.current && !r.worktree).map((r) => ({ id: r.name, label: r.name, description: `${r.commit} ${r.subject}`.trim() }));

export const stashItems = (stashes: Stash[]): PickItem[] =>
	stashes.map((s) => ({ id: String(s.index), label: `stash@{${s.index}}: ${s.message}`, description: [s.branch, s.when].filter(Boolean).join(' · ') }));

/** A branch name worth sending to git (it validates again): VS Code replaces spaces with `-`. */
export function cleanBranchName(input: string): string {
	return input.trim().replace(/\s+/g, '-');
}

export type NetOp = 'fetch' | 'pull' | 'push' | 'publish' | 'sync';

/** The same git command for a terminal, where the user can authenticate interactively. */
export function terminalCommand(op: NetOp, { rebase = false, remote = 'origin', branch = '', pull: pullArgs = undefined as string[] | undefined, prune = true } = {}): string[] {
	const pull = pullArgs ?? (rebase ? ['git', 'pull', '--rebase'] : ['git', 'pull', '--no-rebase', '--ff-only']);
	switch (op) {
		case 'fetch':
			return prune ? ['git', 'fetch', '--prune'] : ['git', 'fetch'];
		case 'pull':
		case 'sync':
			return pull;
		case 'push':
			return ['git', 'push'];
		case 'publish':
			return ['git', 'push', '-u', remote, branch];
	}
}

/** Status bar progress text for a running operation (in the current UI language). */
export function opLabel(op: NetOp): string {
	switch (op) {
		case 'fetch':
			return t('workbench.scmRemote.fetching');
		case 'pull':
			return t('workbench.scmRemote.pulling');
		case 'push':
			return t('workbench.scmRemote.pushing');
		case 'publish':
			return t('workbench.scmRemote.publishing');
		case 'sync':
			return t('workbench.scmRemote.syncing');
	}
}
