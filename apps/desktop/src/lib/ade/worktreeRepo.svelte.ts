// Source Control of one task worktree for the ADE's right side bar: the same status, stage,
// unstage, discard and commit as the IDE's `scm`, run by Rust in `.kingu/worktrees/<slug>`
// (`slug` on the git_* commands). The folder itself (the primary worktree) uses `scm` directly.

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { groups, type GitStatus, type ScmSource } from '#lib/workbench/scm.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';

export class WorktreeRepo implements ScmSource {
	readonly slug: string;
	repo = $state<GitStatus | null>(null);
	loaded = $state(false);
	busy = $state(false);
	message = $state('');
	error = $state('');
	groups = $derived(groups(this.repo?.entries ?? []));
	#inflight: Promise<void> | null = null;
	#again = false;
	/** Runs after every git operation (the task's review stat follows the worktree). */
	onChange: (() => void) | null = null;

	constructor(slug: string) {
		this.slug = slug;
	}

	refresh(): Promise<void> {
		if (this.#inflight) {
			this.#again = true;
			return this.#inflight;
		}
		this.#inflight = (async () => {
			do {
				this.#again = false;
				try {
					this.repo = await invoke<GitStatus | null>('git_status', { slug: this.slug });
					this.error = '';
				} catch (e) {
					this.repo = null;
					this.error = String(e);
				}
				this.loaded = true;
			} while (this.#again);
			this.#inflight = null;
		})();
		return this.#inflight;
	}

	async #run(cmd: string, args: Record<string, unknown>): Promise<boolean> {
		this.busy = true;
		try {
			await invoke(cmd, { ...args, slug: this.slug });
			return true;
		} catch (e) {
			notifications.error(e);
			clientLog('error', `${cmd} (${this.slug}): ${e}`);
			return false;
		} finally {
			this.busy = false;
			await this.refresh();
			this.onChange?.();
		}
	}

	stage(paths: string[]) {
		return this.#run('git_stage', { paths });
	}

	unstage(paths: string[]) {
		const all = new Set(paths);
		for (const e of this.repo?.entries ?? []) if (all.has(e.path) && e.orig_path) all.add(e.orig_path);
		return this.#run('git_unstage', { paths: [...all] });
	}

	discard(paths: string[], deleteUntracked: boolean) {
		return this.#run('git_discard', { paths, deleteUntracked });
	}

	/** Push (publishing the task branch to origin the first time), pull, fetch or sync, in the worktree. */
	async remote(op: 'push' | 'pull' | 'fetch' | 'sync'): Promise<boolean> {
		const rebase = settings.get<boolean>('git.pullRebase') === true;
		const args = op === 'pull' || op === 'sync' ? { rebase } : {};
		const ok = await this.#run(`git_${op}`, args);
		if (ok) status.flash(`${op} ${this.repo?.branch ?? this.slug} แล้ว`);
		return ok;
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
			status.flash(amend ? `แก้ commit ล่าสุดใน ${this.repo?.branch ?? this.slug} แล้ว` : `commit ใน ${this.repo?.branch ?? this.slug} แล้ว`);
		}
	}
}
