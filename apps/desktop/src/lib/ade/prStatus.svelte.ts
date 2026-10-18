// Pull request + CI checks per worktree (Orca's Checks), the one PR read every view of a worktree
// shares: the task page's review, the right side bar's Checks and Source Control. `worktree_pr`
// makes one `gh pr view` call and returns Kingu's parsed status (`pr`) along with gh's own JSON
// (`raw`, what the right side bar renders). Views `watch` a worktree while they show it; watched
// worktrees poll with Orca's policy (`checksPollDelay`) while the window is visible and look again
// when it regains focus. An open PR's review threads and its repository's merge methods are read
// along with it. `slug` '' is the folder itself (the PR of its checked-out branch).

import { invoke } from '@tauri-apps/api/core';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { checksPollDelay, prSignature, type Pr } from './checks.ts';
import { repoOf, type PrStatus, type RepoMergeSettings } from './prChecks.ts';
import { withResolved, type ReviewThread } from './prComments.ts';

type Entry = { pr: PrStatus | null; raw: Pr | null; error?: string; at: number; loading: boolean };
type Threads = { list: ReviewThread[]; error?: string; loading: boolean };
type Poll = { watchers: number; timer?: ReturnType<typeof setTimeout>; delay: number; signature: string };


class PrStatuses {
	bySlug = $state<Record<string, Entry>>({});
	threads = $state<Record<string, Threads>>({});
	/** Merge settings per repository (`host/owner/repo` of the PR URL); they rarely change. */
	mergeSettings = $state<Record<string, RepoMergeSettings | null>>({});
	#polls = new Map<string, Poll>();
	#inflight = new Map<string, Promise<void>>();
	/** Bumped when the folder changes, so an answer for the old folder is dropped. */
	#generation = 0;
	#root: string | null = null;
	#focusInstalled = false;

	/** `threads: false` (the background poll) leaves the review threads as they are. Concurrent
	 * calls for one worktree share the read in flight. */
	refresh(slug: string, opts: { threads?: boolean } = {}): Promise<void> {
		this.#sameFolder();
		const running = this.#inflight.get(slug);
		if (running) return running;
		const p: Promise<void> = this.#read(slug, opts).finally(() => {
			if (this.#inflight.get(slug) === p) this.#inflight.delete(slug);
		});
		this.#inflight.set(slug, p);
		return p;
	}

	async #read(slug: string, opts: { threads?: boolean }) {
		const gen = this.#generation;
		const prev = this.bySlug[slug];
		this.bySlug[slug] = { pr: prev?.pr ?? null, raw: prev?.raw ?? null, at: prev?.at ?? 0, loading: true };
		let failed = false;
		try {
			const r = await invoke<{ status: PrStatus; raw: Pr } | null>('worktree_pr', { slug });
			if (gen !== this.#generation) return;
			const pr = r?.status ?? null;
			this.bySlug[slug] = { pr, raw: r?.raw ?? null, at: Date.now(), loading: false };
			if (pr?.state === 'OPEN') {
				if (opts.threads !== false || !this.threads[slug]) void this.refreshThreads(slug);
				void this.#loadMergeSettings(slug, pr.url);
			} else delete this.threads[slug];
		} catch (e) {
			if (gen !== this.#generation) return;
			failed = true;
			this.bySlug[slug] = { pr: prev?.pr ?? null, raw: prev?.raw ?? null, error: String(e), at: Date.now(), loading: false };
		}
		this.#schedule(slug, failed);
	}

	async refreshThreads(slug: string) {
		const pr = this.bySlug[slug]?.pr;
		if (!pr) return;
		const gen = this.#generation;
		const prev = this.threads[slug];
		this.threads[slug] = { list: prev?.list ?? [], loading: true };
		try {
			const list = await invoke<ReviewThread[]>('worktree_pr_threads', { slug, url: pr.url, number: pr.number });
			if (gen === this.#generation) this.threads[slug] = { list, loading: false };
		} catch (e) {
			if (gen === this.#generation) this.threads[slug] = { list: prev?.list ?? [], error: String(e), loading: false };
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

	/** A view shows worktree `slug`: read it now and keep polling while any view does. Returns the
	 * function that stops watching. */
	watch(slug: string): () => void {
		this.#installFocus();
		const poll = this.#polls.get(slug) ?? { watchers: 0, delay: 0, signature: '' };
		poll.watchers++;
		this.#polls.set(slug, poll);
		void this.refresh(slug);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			poll.watchers--;
			if (poll.watchers > 0) return;
			clearTimeout(poll.timer);
			this.#polls.delete(slug);
		};
	}

	#schedule(slug: string, failed: boolean) {
		const poll = this.#polls.get(slug);
		if (!poll) return;
		clearTimeout(poll.timer);
		const raw = this.bySlug[slug]?.raw ?? null;
		const signature = prSignature(raw);
		const delay = checksPollDelay(failed ? null : raw, { failed, unchanged: signature === poll.signature, prev: poll.delay });
		poll.signature = signature;
		poll.delay = delay ?? 0;
		// null: nothing left to watch (a merged PR whose checks settled); focus still looks again.
		if (delay === null) return;
		poll.timer = setTimeout(() => {
			if (document.visibilityState === 'visible') void this.refresh(slug, { threads: false });
			else this.#schedule(slug, false);
		}, delay);
	}

	#installFocus() {
		if (this.#focusInstalled || typeof window === 'undefined') return;
		this.#focusInstalled = true;
		window.addEventListener('focus', () => {
			for (const slug of this.#polls.keys()) void this.refresh(slug, { threads: false });
		});
	}

	/** Another folder: its worktrees share slugs with the old one's, so nothing of the old stays. */
	#sameFolder() {
		const root = workspace.root;
		if (root === this.#root) return;
		this.#root = root;
		this.#generation++;
		this.#inflight.clear();
		this.bySlug = {};
		this.threads = {};
	}
}

export const prStatuses = new PrStatuses();
