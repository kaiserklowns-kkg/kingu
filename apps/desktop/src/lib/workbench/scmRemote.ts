// Pure helpers for remotes and branches (VS Code's git extension: sync status bar item, Checkout
// to…, stash picks). Shapes mirror Rust `git_remote.rs`.

import type { PickItem } from '#lib/workbench/quick.svelte.ts';
import type { GitStatus } from '#lib/workbench/scm.ts';

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
};

export type Stash = { index: number; message: string; branch: string | null; when: string };

export type DeleteResult = 'deleted' | 'not_merged';

/** Start of Rust's message for a rejected or missing credential (`git_remote::AUTH_FAILED`). */
export const AUTH_FAILED = 'ยืนยันตัวตนกับ remote ไม่สำเร็จ';
export const isAuthError = (e: unknown) => String(e).startsWith(AUTH_FAILED);

export type SyncItem = { label: string; title: string; command: 'git.sync' | 'git.publish' };

/** The status bar's sync item next to the branch: `↓n ↑m` with an upstream, Publish without. */
export function syncItem(repo: GitStatus | null): SyncItem | null {
	if (!repo?.branch || repo.detached) return null;
	if (!repo.upstream || repo.upstream_gone) {
		if (!repo.remotes.length) return null;
		const why = repo.upstream_gone ? `upstream ${repo.upstream} ถูกลบไปแล้ว ` : '';
		return { label: '', title: `${why}Publish Branch: push ${repo.branch} ขึ้น remote`, command: 'git.publish' };
	}
	return {
		label: `↓${repo.behind} ↑${repo.ahead}`,
		title: `Synchronize Changes: pull ${repo.behind} และ push ${repo.ahead} commit กับ ${repo.upstream}`,
		command: 'git.sync'
	};
}

/** The status bar's branch text: the branch, or the short commit when detached. */
export const branchLabel = (repo: GitStatus | null): string | null => (repo ? (repo.branch ?? repo.head) : null);

export const CREATE_BRANCH = '__create';
export const CREATE_BRANCH_FROM = '__createFrom';
const WORKTREE_PREFIX = 'worktree:';

/**
 * VS Code's "Select a branch or tag to checkout": create actions, then local branches, then remote
 * branches. Branches held by another worktree come last, marked; accepting one explains why not.
 */
export function checkoutItems(refs: BranchRef[], { create = true } = {}): PickItem[] {
	const items: PickItem[] = [];
	if (create) {
		items.push({ id: CREATE_BRANCH, label: '+ Create new branch...' }, { id: CREATE_BRANCH_FROM, label: '+ Create new branch from...' });
	}
	const free = refs.filter((r) => !r.current && !r.worktree);
	const sections: [string, BranchRef[]][] = [
		['branches', free.filter((r) => !r.remote)],
		['remote branches', free.filter((r) => r.remote)]
	];
	for (const [title, list] of sections) {
		list.forEach((r, i) => items.push({ id: r.name, label: r.name, description: `${r.commit} ${r.subject}`.trim(), separator: i === 0 ? title : undefined }));
	}
	refs
		.filter((r) => r.worktree && !r.remote)
		.forEach((r, i) =>
			items.push({ id: WORKTREE_PREFIX + r.name, label: r.name, description: `ใช้อยู่ใน worktree ${r.worktree}`, separator: i === 0 ? 'ใช้อยู่ใน worktree อื่น' : undefined })
		);
	return items;
}

/** What accepting a checkout item means. */
export type CheckoutTarget = { kind: 'create' } | { kind: 'createFrom' } | { kind: 'worktree'; ref: BranchRef } | { kind: 'ref'; ref: BranchRef };

export function checkoutTarget(id: string, refs: BranchRef[]): CheckoutTarget | null {
	if (id === CREATE_BRANCH) return { kind: 'create' };
	if (id === CREATE_BRANCH_FROM) return { kind: 'createFrom' };
	const name = id.startsWith(WORKTREE_PREFIX) ? id.slice(WORKTREE_PREFIX.length) : id;
	const ref = refs.find((r) => r.name === name && (id.startsWith(WORKTREE_PREFIX) ? !r.remote : true));
	if (!ref) return null;
	return ref.worktree ? { kind: 'worktree', ref } : { kind: 'ref', ref };
}

/** Delete Branch candidates: local branches that are not checked out anywhere. */
export const deletableBranches = (refs: BranchRef[]): PickItem[] =>
	refs.filter((r) => !r.remote && !r.current && !r.worktree).map((r) => ({ id: r.name, label: r.name, description: `${r.commit} ${r.subject}`.trim() }));

export const stashItems = (stashes: Stash[]): PickItem[] =>
	stashes.map((s) => ({ id: String(s.index), label: `stash@{${s.index}}: ${s.message}`, description: [s.branch, s.when].filter(Boolean).join(' · ') }));

/** A branch name worth sending to git (it validates again): VS Code replaces spaces with `-`. */
export function cleanBranchName(input: string): string {
	return input.trim().replace(/\s+/g, '-');
}

export type NetOp = 'fetch' | 'pull' | 'push' | 'publish' | 'sync';

/** The same git command for a terminal, where the user can authenticate interactively. */
export function terminalCommand(op: NetOp, { rebase = false, remote = 'origin', branch = '' } = {}): string[] {
	const pull = rebase ? ['git', 'pull', '--rebase'] : ['git', 'pull', '--no-rebase', '--ff-only'];
	switch (op) {
		case 'fetch':
			return ['git', 'fetch', '--prune'];
		case 'pull':
		case 'sync':
			return pull;
		case 'push':
			return ['git', 'push'];
		case 'publish':
			return ['git', 'push', '-u', remote, branch];
	}
}

/** Status bar progress text for a running operation. */
export const OP_LABELS: Record<NetOp, string> = {
	fetch: 'กำลัง fetch...',
	pull: 'กำลัง pull...',
	push: 'กำลัง push...',
	publish: 'กำลัง publish branch...',
	sync: 'กำลัง sync...'
};
