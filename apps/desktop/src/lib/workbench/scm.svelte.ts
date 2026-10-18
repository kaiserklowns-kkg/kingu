// Source Control model (VS Code: ISCMService + the git extension's Repository). Status is
// re-read on view open, after every git operation, after a save and on window focus.

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { groups, type GitStatus } from './scm';
import { status } from './status.svelte';

class Scm {
	repo = $state<GitStatus | null>(null);
	/** False until the first status read; then whether the workspace is a git repository. */
	loaded = $state(false);
	busy = $state(false);
	message = $state('');
	groups = $derived(groups(this.repo?.entries ?? []));
	/** Activity bar badge: resources across both groups, like VS Code's `scm.countBadge: all`. */
	count = $derived(this.groups.staged.length + this.groups.changes.length);

	#inflight: Promise<void> | null = null;
	#again = false;

	/** Coalesces overlapping calls: at most one read in flight plus one queued. */
	refresh(): Promise<void> {
		if (this.#inflight) {
			this.#again = true;
			return this.#inflight;
		}
		this.#inflight = (async () => {
			do {
				this.#again = false;
				try {
					this.repo = await invoke<GitStatus | null>('git_status');
					status.branch = this.repo ? (this.repo.branch ?? this.repo.head) : null;
				} catch (e) {
					clientLog('error', `git status: ${e}`);
				}
				this.loaded = true;
			} while (this.#again);
			this.#inflight = null;
		})();
		return this.#inflight;
	}

	/** Runs a git command, reports failure in the status bar, then re-reads status. */
	async #run(cmd: string, args: Record<string, unknown>): Promise<boolean> {
		this.busy = true;
		try {
			await invoke(cmd, args);
			return true;
		} catch (e) {
			status.error(String(e), 8000);
			clientLog('error', `${cmd}: ${e}`);
			return false;
		} finally {
			this.busy = false;
			await this.refresh();
		}
	}

	stage(paths: string[]) {
		return this.#run('git_stage', { paths });
	}

	/** A staged rename needs its source unstaged too, or the deletion stays staged. */
	unstage(paths: string[]) {
		const all = new Set(paths);
		for (const e of this.repo?.entries ?? []) if (all.has(e.path) && e.orig_path) all.add(e.orig_path);
		return this.#run('git_unstage', { paths: [...all] });
	}

	/** Callers confirm first; `deleteUntracked` is only set after the user agreed to delete. */
	discard(paths: string[], deleteUntracked: boolean) {
		return this.#run('git_discard', { paths, deleteUntracked });
	}

	async commit({ amend = false } = {}) {
		const message = this.message.trim();
		if (!message) {
			status.flash('ใส่ข้อความ commit ก่อน');
			return;
		}
		if (!amend && !this.groups.staged.length) {
			status.flash(this.groups.changes.length ? 'ยังไม่มีไฟล์ที่ stage: กด + ที่ไฟล์ก่อน commit' : 'ไม่มีการเปลี่ยนแปลงให้ commit');
			return;
		}
		if (await this.#run('git_commit', { message, amend })) {
			this.message = '';
			status.flash(amend ? 'แก้ commit ล่าสุดแล้ว' : 'commit แล้ว');
		}
	}
}

export const scm = new Scm();

/** Workbench-level wiring: initial read, refresh on focus and after saves, palette commands. */
export function installScm(): () => void {
	void scm.refresh();
	const onFocus = () => void scm.refresh();
	window.addEventListener('focus', onFocus);

	// A save turns a dirty tab clean; re-read status then (a fall in the dirty count).
	let dirty = 0;
	const stopEffect = $effect.root(() => {
		$effect(() => {
			const now = editors.dirtyCount();
			if (now < dirty) void scm.refresh();
			dirty = now;
		});
	});

	const unregister = [
		commands.register({ id: 'git.refresh', title: 'Git: Refresh', run: () => scm.refresh() }),
		commands.register({ id: 'git.commit', title: 'Git: Commit', when: () => scm.repo !== null, run: () => scm.commit() }),
		commands.register({ id: 'git.commitAmend', title: 'Git: Commit (Amend)', when: () => scm.repo !== null, run: () => scm.commit({ amend: true }) }),
		commands.register({
			id: 'git.stageAll',
			title: 'Git: Stage All Changes',
			when: () => scm.groups.changes.length > 0,
			run: () => scm.stage(scm.groups.changes.map((r) => r.entry.path))
		}),
		commands.register({
			id: 'git.unstageAll',
			title: 'Git: Unstage All Changes',
			when: () => scm.groups.staged.length > 0,
			run: () => scm.unstage(scm.groups.staged.map((r) => r.entry.path))
		})
	];

	return () => {
		window.removeEventListener('focus', onFocus);
		stopEffect();
		unregister.forEach((u) => u());
	};
}
