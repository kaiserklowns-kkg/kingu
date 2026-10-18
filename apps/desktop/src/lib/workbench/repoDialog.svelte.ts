// Clone Repository and New Project (Orca's Add Project dialog: clone and create steps). Rust
// clones (`git_clone`, cancellable, progress over a channel) or creates the folder with
// `git init` and an empty first commit (`project_create`); the result opens as the folder.

import { Channel, invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { ask } from './messageBox.ts';
import { afterClone, cloneParent, cloneUrlError, defaultParents, projectNameError, type CloneProgress } from './repoDialog.ts';
import { status } from './status.svelte.ts';
import { workspace } from './workspace.svelte.ts';

export type RepoDialogMode = 'clone' | 'create';

class RepoDialog {
	mode = $state<RepoDialogMode | null>(null);
	url = $state('');
	name = $state('');
	parent = $state('');
	busy = $state(false);
	error = $state<string | null>(null);
	progress = $state<CloneProgress | null>(null);
	/** A clone the user cancelled: its error is expected, not shown. */
	#cancelled = false;

	async show(mode: RepoDialogMode) {
		if (this.busy) {
			this.mode = this.mode ?? mode;
			return;
		}
		this.mode = mode;
		this.url = '';
		this.name = '';
		this.error = null;
		this.progress = null;
		const home = await homeDir().catch(() => '');
		const d = defaultParents(home);
		this.parent = mode === 'clone' ? cloneParent(settings.get<string | null>('git.defaultCloneDirectory'), home) : d.project;
	}

	close() {
		if (this.busy) return;
		this.mode = null;
	}

	async pickParent() {
		const dir = await open({ directory: true, multiple: false, title: this.mode === 'clone' ? 'Clone ไปที่โฟลเดอร์' : 'สร้างโปรเจกต์ในโฟลเดอร์', defaultPath: this.parent || undefined });
		if (typeof dir === 'string') {
			this.parent = dir;
			this.error = null;
		}
	}

	async clone() {
		const bad = cloneUrlError(this.url) ?? (this.parent.trim() ? null : 'เลือกโฟลเดอร์ปลายทาง');
		if (bad) {
			this.error = bad;
			return;
		}
		this.busy = true;
		this.error = null;
		this.progress = null;
		this.#cancelled = false;
		const onProgress = new Channel<CloneProgress>();
		onProgress.onmessage = (p) => (this.progress = p);
		let path: string | null = null;
		try {
			path = await invoke<string>('git_clone', { url: this.url.trim(), destination: this.parent.trim(), onProgress });
		} catch (e) {
			if (!this.#cancelled) this.error = String(e);
			clientLog('error', `git clone: ${e}`);
		} finally {
			this.busy = false;
		}
		if (this.#cancelled) {
			this.mode = null;
			status.flash('ยกเลิก clone แล้ว');
			return;
		}
		if (!path) return;
		this.mode = null;
		status.flash(`clone แล้ว: ${path}`);
		// git.openAfterClone
		const then = afterClone(settings.get<string>('git.openAfterClone'), workspace.root !== null);
		if (then === 'stay') return;
		if (then === 'ask' && !(await ask(`เปิด repository ที่ clone มาไหม? (Would you like to open the cloned repository?)\n${path}`, { title: 'Git', okLabel: 'Open', cancelLabel: 'Cancel' }))) return;
		await workspace.openFolder(path);
	}

	async cancelClone() {
		this.#cancelled = true;
		await invoke<boolean>('git_clone_cancel').catch(() => false);
	}

	async create() {
		const bad = projectNameError(this.name) ?? (this.parent.trim() ? null : 'เลือกโฟลเดอร์ที่จะสร้างโปรเจกต์');
		if (bad) {
			this.error = bad;
			return;
		}
		this.busy = true;
		this.error = null;
		let path: string | null = null;
		try {
			path = await invoke<string>('project_create', { parent: this.parent.trim(), name: this.name.trim() });
		} catch (e) {
			this.error = String(e);
		} finally {
			this.busy = false;
		}
		if (!path) return;
		this.mode = null;
		status.flash(`สร้างโปรเจกต์แล้ว: ${path}`);
		await workspace.openFolder(path);
	}
}

export const repoDialog = new RepoDialog();
