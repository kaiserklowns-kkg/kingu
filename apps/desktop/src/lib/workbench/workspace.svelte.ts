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
import { parseSettingsText } from '#lib/settings/jsonc.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { editorKeyFor } from './externalFiles';
import { isWorkspaceFile, parseCodeWorkspace, workspaceName, type CodeWorkspace } from './workspaceFile';
import { editors } from './editors.svelte';
import { explorer } from './explorer.svelte';
import { ideChanges, recentLabel, workspaceFiles } from './fileTree';
import type { RecentFolder } from './menus';
import { navigation } from './navigation.svelte';
import { quick, type PickItem } from './quick.svelte';
import { scm } from './scm.svelte';
import { search } from './search.svelte';
import { status } from './status.svelte';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';

type FilesChanged = { root: string; paths: string[] };
type Listener = (paths: string[]) => void;

class Workspace {
	/** Absolute root of the open folder; null shows the Explorer's welcome view. */
	root = $state<string | null>(null);
	/** False until startup has asked Rust which folder is open (no welcome-view flash). */
	ready = $state(false);
	recent = $state<string[]>([]);
	/** Files outside the folder opened with Open File (most recent first), for Open Recent. */
	recentFiles = $state<string[]>([]);
	/** The `.code-workspace` file the open folder came from (VS Code's workspace identifier), or null. */
	workspaceFile = $state<string | null>(null);
	name = $derived(this.root ? this.root.split('/').pop() || this.root : '');

	#listeners = new Set<Listener>();
	#raw = new Set<Listener>();
	/** The user's home folder (for `~/…` labels); empty until read. */
	home = $state('');

	async init() {
		try {
			const info = await invoke<{ workspace: string }>('app_info');
			this.root = info.workspace || null;
		} finally {
			this.ready = true;
		}
		homeDir().then((h) => (this.home = h.replace(/\/$/, '')), () => {});
		// Reopened at startup: a folder that came from a `.code-workspace` file keeps its settings.
		const saved = savedWorkspaceFile();
		if (saved && saved.root === this.root) void this.#loadWorkspaceFile(saved.file).then((w) => w && this.#useWorkspaceFile(saved.file, w));
		await this.loadRecent();
	}

	async loadRecent() {
		[this.recent, this.recentFiles] = await Promise.all([invoke<string[]>('workspace_recent').catch(() => []), invoke<string[]>('external_recent').catch(() => [])]);
	}

	/**
	 * File: Open File… (VS Code opens any file). A file inside the folder opens as a workspace file,
	 * one outside it as an external editor (Rust allows only what the picker returned); a
	 * `.code-workspace` file opens as a workspace.
	 */
	async openFile() {
		let picked: string[];
		try {
			picked = await invoke<string[]>('external_pick_files', { title: t('workspaces.openFileTitle') });
		} catch (e) {
			notifications.error(t('workspaces.openFileFailed', { error: String(e) }));
			return;
		}
		for (const path of picked) this.openPath(path);
		await this.loadRecent();
	}

	/** Opens an absolute path that Open File (or Open Recent) allowed. */
	openPath(path: string) {
		if (isWorkspaceFile(path)) void this.openWorkspaceFile(path);
		else editors.open(editorKeyFor(path, this.root), { preview: false });
	}

	/** File: Open Workspace from File… */
	async pickWorkspaceFile() {
		const [file] = await invoke<string[]>('external_pick_files', { workspace: true, title: t('workspaces.openWorkspaceTitle') }).catch((e) => {
			notifications.error(t('workspaces.openFileFailed', { error: String(e) }));
			return [];
		});
		if (file) await this.openWorkspaceFile(file);
	}

	/**
	 * Opens a `.code-workspace` file: its folder (Kingu's Rust workspace has one root, so a
	 * multi-root file asks which folder), with the file's `settings` under the folder's own.
	 */
	async openWorkspaceFile(file: string): Promise<boolean> {
		const parsed = await this.#loadWorkspaceFile(file);
		if (!parsed) return false;
		const name = workspaceName(file);
		const existing = parsed.folders;
		if (!existing.length) {
			notifications.error(t('workspaces.noFolders', { name }));
			return false;
		}
		let folder = existing[0];
		if (existing.length > 1) {
			const item = await quick.choose({
				placeholder: t('workspaces.pickFolder', { name, count: existing.length }),
				items: existing.map((f) => ({ id: f.path, label: f.name, description: recentLabel(f.path, this.home).detail }))
			});
			const chosen = existing.find((f) => f.path === item?.id);
			if (!chosen) return false;
			folder = chosen;
		}
		const sameFolder = folder.path === this.root;
		if (!(await this.openFolder(folder.path))) return false;
		// Open Folder clears the workspace file (a plain folder); this one came from the file.
		this.#useWorkspaceFile(file, parsed);
		if (sameFolder) void settings.load();
		return true;
	}

	async #loadWorkspaceFile(file: string): Promise<CodeWorkspace | null> {
		try {
			return parseCodeWorkspace(await invoke<string>('workspace_file_read', { path: file }), file);
		} catch (e) {
			notifications.error(t('workspaces.readFailed', { name: workspaceName(file), error: String(e) }));
			if (this.recentFiles.includes(file)) await invoke('external_forget', { path: file }).catch(() => {});
			return null;
		}
	}

	#useWorkspaceFile(file: string, parsed: CodeWorkspace) {
		this.workspaceFile = file;
		settings.workspaceFile = parseSettingsText(JSON.stringify(parsed.settings));
		saveWorkspaceFile(this.root ? { root: this.root, file } : null);
	}

	/** File: Save Workspace As… — a `.code-workspace` file listing the open folder (and the workspace file's settings). */
	async saveWorkspaceAs() {
		if (!this.root) return;
		const content = JSON.stringify({ folders: [{ path: this.root }], settings: settings.workspaceFile }, null, '\t') + '\n';
		let saved: { rel: string | null; path: string } | null;
		try {
			saved = await invoke<{ rel: string | null; path: string } | null>('fs_save_as', { content, name: `${this.name || 'workspace'}.code-workspace`, dir: null });
		} catch (e) {
			notifications.error(t('workspaces.saveFailed', { error: String(e) }));
			return;
		}
		if (!saved) return;
		this.workspaceFile = saved.path;
		saveWorkspaceFile({ root: this.root, file: saved.path });
		notifications.info(t('workspaces.saved', { name: saved.path.split('/').pop() ?? saved.path }));
		await this.loadRecent();
	}

	/** File: Add Folder to Workspace… — Kingu has one folder per window, so it offers to open the folder instead. */
	async addFolderToWorkspace() {
		const dir = await open({ directory: true, multiple: false, title: 'Add Folder to Workspace', defaultPath: this.root ?? (this.home || undefined) });
		if (typeof dir !== 'string' || dir === this.root) return;
		const name = dir.split('/').pop() || dir;
		if (await ask(t('workspaces.addFolder', { name }), { okLabel: t('workspaces.openInstead') })) await this.openFolder(dir);
	}

	/** `workbench.action.files.openFolder`: the native folder picker. */
	async pickFolder() {
		const dir = await open({ directory: true, multiple: false, title: 'Open Folder', defaultPath: this.root ?? (this.home || undefined) });
		if (typeof dir === 'string') await this.openFolder(dir);
	}

	async openFolder(path: string): Promise<boolean> {
		if (path === this.root) return true;
		if (!(await confirmDiscard())) return false;
		let root: string;
		try {
			root = await invoke<string>('workspace_open', { path });
		} catch (e) {
			notifications.error(t('workbench.workspace.openFailed', { error: String(e) }));
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
		return this.recent.filter((p) => p !== this.root).map((path) => ({ path, ...recentLabel(path, this.home) }));
	}

	async clearRecent() {
		await Promise.all([invoke('workspace_recent_clear'), invoke('external_clear')]).catch((e) => notifications.error(e));
		await this.loadRecent();
	}

	/** "File: Open Recent" quick pick. */
	async showRecent() {
		await this.loadRecent();
		const OPEN = '\0open', CLEAR = '\0clear', FILE = '\0file:';
		// VS Code's Open Recent: folders and workspaces, then files.
		const workspaceFiles = this.recentFiles.filter(isWorkspaceFile);
		const folders: PickItem[] = [
			...this.recent.filter((p) => p !== this.root).map((path) => ({ id: path, ...recentLabel(path, this.home) })),
			...workspaceFiles.filter((p) => p !== this.workspaceFile).map((path) => ({ id: FILE + path, label: t('workspaces.workspaceSuffix', { name: workspaceName(path) }), detail: recentLabel(path, this.home).detail }))
		].map(({ id, label, detail }) => ({ id, label, description: detail }));
		const files: PickItem[] = this.recentFiles
			.filter((p) => !isWorkspaceFile(p))
			.map((path) => ({ id: FILE + path, label: path.split('/').pop() ?? path, description: recentLabel(path, this.home).detail, icon: path }));
		if (folders.length) folders[0].separator = t('workspaces.recentFolders');
		if (files.length) files[0].separator = t('workspaces.recentFiles');
		const items: PickItem[] = [...folders, ...files];
		items.push({ id: OPEN, label: 'Open Folder...' });
		if (this.recent.length) items.push({ id: CLEAR, label: 'Clear Recently Opened' });
		quick.pick({
			placeholder: t('workbench.workspace.pickFolder'),
			items,
			onAccept: (item) => {
				if (item.id === OPEN) void this.pickFolder();
				else if (item.id === CLEAR) void this.clearRecent();
				else if (item.id.startsWith(FILE)) this.openPath(item.id.slice(FILE.length));
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
		// A plain folder has no workspace file (openWorkspaceFile sets it again right after).
		this.workspaceFile = null;
		settings.workspaceFile = {};
		saveWorkspaceFile(null);
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
			// Agents writing into `.kingu/worktrees/` do not refresh the IDE's Source Control or Explorer.
			const ide = ideChanges(e.payload.paths);
			if (ide.length) void scm.refresh();
			for (const fn of this.#raw) fn(e.payload.paths);
			const files = workspaceFiles(e.payload.paths);
			if (!files.length) return;
			const ideFiles = workspaceFiles(ide);
			if (ideFiles.length) void explorer.refresh(ideFiles);
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

const WORKSPACE_FILE_KEY = 'kingu.workspace.file';

/** The folder last opened from a `.code-workspace` file, so its settings come back after a restart. */
function savedWorkspaceFile(): { root: string; file: string } | null {
	try {
		const v = JSON.parse(localStorage.getItem(WORKSPACE_FILE_KEY) ?? 'null');
		return v && typeof v.root === 'string' && typeof v.file === 'string' ? v : null;
	} catch {
		return null;
	}
}

function saveWorkspaceFile(v: { root: string; file: string } | null) {
	try {
		if (v) localStorage.setItem(WORKSPACE_FILE_KEY, JSON.stringify(v));
		else localStorage.removeItem(WORKSPACE_FILE_KEY);
	} catch {
		// No storage: the workspace file's settings apply until the next restart.
	}
}

export const workspace = new Workspace();
