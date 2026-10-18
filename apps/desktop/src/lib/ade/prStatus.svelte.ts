// Pull request + CI checks per task (Orca's Checks), fetched with `gh` through Rust. Refreshed when a
// task page shows it, then every 30s while a check is still running and the window is visible.

import { invoke } from '@tauri-apps/api/core';
import { summarizeChecks, type PrStatus } from './prChecks';

type Entry = { pr: PrStatus | null; error?: string; at: number; loading: boolean };

class PrStatuses {
	bySlug = $state<Record<string, Entry>>({});
	#timers: Record<string, ReturnType<typeof setTimeout>> = {};

	async refresh(slug: string) {
		const prev = this.bySlug[slug];
		this.bySlug[slug] = { pr: prev?.pr ?? null, at: prev?.at ?? 0, loading: true };
		try {
			const pr = await invoke<PrStatus | null>('worktree_pr_status', { slug });
			this.bySlug[slug] = { pr, at: Date.now(), loading: false };
		} catch (e) {
			this.bySlug[slug] = { pr: prev?.pr ?? null, error: String(e), at: Date.now(), loading: false };
		}
		this.#schedule(slug);
	}

	/** Keep polling while checks run; stop when none are pending or nobody is watching. */
	#schedule(slug: string) {
		clearTimeout(this.#timers[slug]);
		const pr = this.bySlug[slug]?.pr;
		if (!pr || pr.state !== 'OPEN' || summarizeChecks(pr.checks).pending === 0) return;
		this.#timers[slug] = setTimeout(() => {
			if (document.visibilityState === 'visible') void this.refresh(slug);
			else this.#schedule(slug);
		}, 30_000);
	}

	stop(slug: string) {
		clearTimeout(this.#timers[slug]);
		delete this.#timers[slug];
	}
}

export const prStatuses = new PrStatuses();
