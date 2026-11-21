// Pull requests of other added projects' tasks, for the board's PR / MR filter over every project
// (Orca's Agent Dashboard filters every repo's cards by PR state). The open folder's tasks use
// prStatuses (polled, with checks and threads); these are read once when the filter needs them
// and again after a few minutes, one `worktree_pr` call per task with its project's root.

import { invoke } from '@tauri-apps/api/core';
import type { PrStatus } from './prChecks.ts';

/** How long a read answer stands before the filter asks again. */
const STALE_MS = 5 * 60_000;

type Entry = { pr: PrStatus | null; at: number };

const key = (root: string, slug: string) => `${root}\u0000${slug}`;

class ProjectPrs {
	byKey = $state<Record<string, Entry>>({});
	#inflight = new Set<string>();

	/** The PR of `slug` in `root`: undefined while it was never read. */
	get(root: string, slug: string): PrStatus | null | undefined {
		return this.byKey[key(root, slug)]?.pr;
	}

	/** Reads the PR unless a fresh answer is known or a read is running. A failure counts as none. */
	ask(root: string, slug: string) {
		const k = key(root, slug);
		const known = this.byKey[k];
		if (this.#inflight.has(k) || (known && Date.now() - known.at < STALE_MS)) return;
		this.#inflight.add(k);
		invoke<{ status: PrStatus } | null>('worktree_pr', { slug, root })
			.then((r) => (this.byKey[k] = { pr: r?.status ?? null, at: Date.now() }))
			.catch(() => (this.byKey[k] = { pr: known?.pr ?? null, at: Date.now() }))
			.finally(() => this.#inflight.delete(k));
	}
}

export const projectPrs = new ProjectPrs();
