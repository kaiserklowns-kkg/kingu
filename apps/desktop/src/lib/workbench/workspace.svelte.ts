// The open folder (VS Code: IWorkspaceContextService + the Open Folder / Open Recent actions).
// Rust owns the root (`workspace_open` stops the old folder's language servers and search and
// moves the file watcher); this side resets every view that showed the old folder.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { homeDir } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { clientLog } from '#lib/client-log.ts';
import { debug } from '#lib/debug/debug.svelte.ts';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { settings, WORKSPACE_SETTINGS_PATH } from '#lib/settings/settings.svelte.ts';
import { editors } from './editors.svelte';
import { explorer } from './explorer.svelte';
import { recentLabel, workspaceFiles } from './fileTree';
import type { RecentFolder } from './menus';
import { navigation } from './navigation.svelte';
import { quick, type PickItem } from './quick.svelte';
import { scm } from './scm.svelte';
import { search } from './search.svelte';
import { status } from './status.svelte';
import { notifications } from '#lib/workbench/notifications.svelte.ts';

type FilesChanged = { root: string; paths: string[] };
type Listener = (paths: string[]) => void;

class Workspace {
	/** Absolute root of the open folder; null shows the Explorer's welcome view. */
	root = $state<string | null>(null);
	/** False until startup has asked Rust which folder is open (no welcome-view flash). */
	ready = $state(false);
	recent = $state<string[]>([]);
	name = $derived(this.root ? this.root.split('/').pop() || this.root : '');

	#listeners = new Set<Listener>();
	#raw = new Set<Listener>();
	#home = '';

	async init() {
		try {
			const info = await invoke<{ workspace: string }>('app_info');
			this.root = info.workspace || null;
		} finally {
			this.ready = true;
		}
		homeDir().then((h) => (this.#home = h.replace(/\/$/, '')), () => {});
		await this.loadRecent();
	}

	async loadRecent() {
		this.recent = await invoke<string[]>('workspace_recent').catch(() => []);
	}

	/** `workbench.action.files.openFolder`: the native folder picker. */
	async pickFolder() {
		const dir = await open({ directory: true, multiple: false, title: 'Open Folder', defaultPath: this.root ?? (this.#home || undefined) });
		if (typeof dir === 'string') await this.openFolder(dir);
	}

	async openFolder(path: string): Promise<boolean> {
		if (path === this.root) return true;
		if (!(await confirmDiscard())) return false;
		let root: string;
		try {
			root = await invoke<string>('workspace_open', { path });
		} catch (e) {
			notifications.error(`เปิดโฟลเดอร์ไม่ได้: ${e}`);
			// VS Code drops a recent entry that no longer opens.
			if (this.recent.includes(path)) await invoke('workspace_recent_remove', { path }).catch(() => {});
			await this.loadRecent();
			return false;
		}
		this.#switched(root);
		return true;
	}

	async closeFolder() {
		if (this.root === null || !(await confirmDiscard())) return;
		try {
			await invoke('workspace_close');
		} catch (e) {
			notifications.error(e);
			return;
		}
		this.#switched(null);
	}

	/** Recent folders other than the open one, labelled like the Open Recent picker. */
	recentFolders(): RecentFolder[] {
		return this.recent.filter((p) => p !== this.root).map((path) => ({ path, ...recentLabel(path, this.#home) }));
	}

	async clearRecent() {
		await invoke('workspace_recent_clear').catch((e) => notifications.error(e));
		await this.loadRecent();
	}

	/** "File: Open Recent" quick pick. */
	async showRecent() {
		await this.loadRecent();
		const OPEN = '\0open', CLEAR = '\0clear';
		const items: PickItem[] = this.recent
			.filter((p) => p !== this.root)
			.map((path) => {
				const { label, detail } = recentLabel(path, this.#home);
				return { id: path, label, description: detail };
			});
		items.push({ id: OPEN, label: 'Open Folder...' });
		if (this.recent.length) items.push({ id: CLEAR, label: 'Clear Recently Opened' });
		quick.pick({
			placeholder: 'เลือกโฟลเดอร์ที่จะเปิด',
			items,
			onAccept: (item) => {
				if (item.id === OPEN) void this.pickFolder();
				else if (item.id === CLEAR) void this.clearRecent();
				else void this.openFolder(item.id);
			}
		});
	}

	/** File watcher batches (workspace-relative paths, git internals removed) for editors to reload. */
	onFilesChanged(fn: Listener): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	/** Every watcher batch, git internals included (a task worktree's index lives in `.git/worktrees/`). */
	onAnyChange(fn: Listener): () => void {
		this.#raw.add(fn);
		return () => this.#raw.delete(fn);
	}

	/** Every view of the old folder goes: editors, language servers, tree, search, source control. */
	#switched(root: string | null) {
		editors.closeAll();
		navigation.clear();
		lsp.reset();
		debug.reset();
		explorer.reset();
		search.clear();
		scm.repo = null;
		scm.loaded = false;
		scm.message = '';
		status.branch = null;
		this.root = root;
		// Workspace settings (`.kingu/settings.json`) belong to the folder.
		void settings.reloadWorkspace();
		clientLog('info', `workspace: ${root ?? '(none)'}`);
		void this.loadRecent();
		// The Explorer re-reads its root when shown; Source Control reads the new repository now.
		if (root) void scm.refresh();
	}

	/** Listens to the Rust file watcher; returns the uninstaller. */
	install(): () => void {
		let unlisten: (() => void) | undefined;
		let gone = false;
		listen<FilesChanged>('workspace:files-changed', (e) => {
			if (!this.root || e.payload.root !== this.root) return;
			void scm.refresh();
			for (const fn of this.#raw) fn(e.payload.paths);
			const files = workspaceFiles(e.payload.paths);
			if (!files.length) return;
			void explorer.refresh(files);
			if (files.includes(WORKSPACE_SETTINGS_PATH)) void settings.load();
			for (const fn of this.#listeners) fn(files);
		}).then((u) => (gone ? u() : (unlisten = u)));
		return () => {
			gone = true;
			unlisten?.();
		};
	}
}

/** Unsaved editors before the folder changes: backed up (`files.hotExit: onExitAndWindowClose`) or asked about. */
async function confirmDiscard(): Promise<boolean> {
	if (!editors.hasDirty()) return true;
	const { textFiles } = await import('./textFileService.svelte');
	return textFiles.beforeShutdown('load');
}

export const workspace = new Workspace();
