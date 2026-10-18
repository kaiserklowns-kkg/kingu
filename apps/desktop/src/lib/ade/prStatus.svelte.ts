// Pull request + CI checks per task (Orca's Checks), fetched with `gh` through Rust. Refreshed when a
// task page shows it, then every 30s while a check is still running and the window is visible.
// An open PR's review threads and its repository's merge methods are read along with it.

import { invoke } from '@tauri-apps/api/core';
import { repoOf, summarizeChecks, type PrStatus, type RepoMergeSettings } from './prChecks.ts';
import { withResolved, type ReviewThread } from './prComments.ts';

type Entry = { pr: PrStatus | null; error?: string; at: number; loading: boolean };
type Threads = { list: ReviewThread[]; error?: string; loading: boolean };

class PrStatuses {
	bySlug = $state<Record<string, Entry>>({});
	threads = $state<Record<string, Threads>>({});
	/** Merge settings per repository (`host/owner/repo` of the PR URL); they rarely change. */
	mergeSettings = $state<Record<string, RepoMergeSettings | null>>({});
	#timers: Record<string, ReturnType<typeof setTimeout>> = {};

	/** `threads: false` (the background poll) leaves the review threads as they are. */
	async refresh(slug: string, opts: { threads?: boolean } = {}) {
		const prev = this.bySlug[slug];
		this.bySlug[slug] = { pr: prev?.pr ?? null, at: prev?.at ?? 0, loading: true };
		try {
			const pr = await invoke<PrStatus | null>('worktree_pr_status', { slug });
			this.bySlug[slug] = { pr, at: Date.now(), loading: false };
			if (pr?.state === 'OPEN') {
				if (opts.threads !== false || !this.threads[slug]) void this.refreshThreads(slug);
				void this.#loadMergeSettings(slug, pr.url);
			} else delete this.threads[slug];
		} catch (e) {
			this.bySlug[slug] = { pr: prev?.pr ?? null, error: String(e), at: Date.now(), loading: false };
		}
		this.#schedule(slug);
	}

	async refreshThreads(slug: string) {
		const pr = this.bySlug[slug]?.pr;
		if (!pr) return;
		const prev = this.threads[slug];
		this.threads[slug] = { list: prev?.list ?? [], loading: true };
		try {
			const list = await invoke<ReviewThread[]>('worktree_pr_threads', { slug, url: pr.url, number: pr.number });
			this.threads[slug] = { list, loading: false };
		} catch (e) {
			this.threads[slug] = { list: prev?.list ?? [], error: String(e), loading: false };
		}
	}

	/** Records a thread resolved or reopened on GitHub without re-reading every thread. */
	markResolved(slug: string, id: string, resolved: boolean) {
		const t = this.threads[slug];
		if (t) this.threads[slug] = { ...t, list: withResolved(t.list, id, resolved) };
	}

	async #loadMergeSettings(slug: string, url: string) {
		const repo = repoOf(url);
		if (!repo || repo in this.mergeSettings) return;
		this.mergeSettings[repo] = null;
		try {
			this.mergeSettings[repo] = await invoke<RepoMergeSettings>('gh_merge_settings', { slug, url });
		} catch {
			// Unknown settings offer all three methods; GitHub refuses a disallowed one with a clear error.
		}
	}

	settingsFor(url: string): RepoMergeSettings | null {
		return this.mergeSettings[repoOf(url) ?? ''] ?? null;
	}

	/** Keep polling while checks run; stop when none are pending or nobody is watching. */
	#schedule(slug: string) {
		clearTimeout(this.#timers[slug]);
		const pr = this.bySlug[slug]?.pr;
		if (!pr || pr.state !== 'OPEN' || summarizeChecks(pr.checks).pending === 0) return;
		this.#timers[slug] = setTimeout(() => {
			if (document.visibilityState === 'visible') void this.refresh(slug, { threads: false });
			else this.#schedule(slug);
		}, 30_000);
	}

	stop(slug: string) {
		clearTimeout(this.#timers[slug]);
		delete this.#timers[slug];
	}
}

export const prStatuses = new PrStatuses();
