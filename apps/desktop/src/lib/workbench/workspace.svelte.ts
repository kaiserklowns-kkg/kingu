// This window's workspace (VS Code: IWorkspaceContextService + the Open Folder / Open Recent /
// Add Folder / New Window actions). Rust owns each window's folders (`workspace_*` stop the old
// first folder's language servers and search and move the file watchers); this side resets
// every view that showed the old folder.
//
// A workspace has no folder, one folder, or several root folders (multi-root, VS Code's
// `.code-workspace` `folders`). `root` is the first folder: its files have relative paths, files
// of the other root folders absolute ones (workspaceFolders.ts). Source Control, language
// servers, tasks and terminals cover every folder; the ADE and workspace settings work on the
// first one.

import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { clientLog } from '#lib/client-log.ts';
import { debug } from '#lib/debug/debug.svelte.ts';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { settings, WORKSPACE_SETTINGS_PATH } from '#lib/settings/settings.svelte.ts';
import { parseSettingsText } from '#lib/settings/jsonc.ts';
import { listenWindow, windowLabel } from '#lib/workbench/windowEvents.ts';
import { externalKey } from './externalFiles';
import { isWorkspaceFile, parseCodeWorkspace, workspaceName, type CodeWorkspace } from './workspaceFile';
import { folderOf, keyForPath, watcherPaths, within, workspaceFileText, workspaceLabel, workspaceStateKey, type WorkspaceFolder } from '#lib/workbench/workspaceFolders.ts';
import { editors } from './editors.svelte';
import { explorer } from './explorer.svelte';
import { ideChanges, recentLabel, workspaceFiles } from './fileTree';
import type { RecentFolder } from './menus';
import { navigation } from './navigation.svelte';
import { quick, type PickItem } from './quick.svelte';
import { scm } from './scm.svelte';
import { search } from './search.svelte';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';

type FilesChanged = { root: string; paths: string[] };
type Listener = (paths: string[]) => void;

/** What Rust says this window has open (windows.rs WorkspaceState). */
type WorkspaceState = {
	window: string;
	folders: WorkspaceFolder[];
	file: string | null;
	untitled: string | null;
	identity: string | null;
	/** An empty window's id (an older Rust side sends none). */
	empty?: string | null;
	open_files?: string[];
};

class Workspace {
	/** Absolute path of the first root folder; null shows the Explorer's welcome view. */
	root = $state<string | null>(null);
	/** Every root folder, the first one first (one in a single-folder window). */
	folders = $state.raw<WorkspaceFolder[]>([]);
	/** False until startup has asked Rust which folder is open (no welcome-view flash). */
	ready = $state(false);
	recent = $state<string[]>([]);
	/** Files outside the folder opened with Open File (most recent first), for Open Recent. */
	recentFiles = $state<string[]>([]);
	/** The `.code-workspace` file the folders came from (VS Code's workspace identifier), or null. */
	workspaceFile = $state<string | null>(null);
	/** An untitled multi-root workspace's id (Add Folder to a single folder, Duplicate Workspace). */
	untitled = $state<string | null>(null);
	/** The workspace's identity: per identity the window keeps its terminals and open editors. */
	identity = $state<string | null>(null);
	/** An empty window's own id (VS Code's empty workspace): its layout and terminals are its own. */
	empty = $state<string | null>(null);
	/** This window's label (`main`, `window-1`, …). */
	window = $state('main');
	name = $derived(this.root ? this.root.split('/').pop() || this.root : '');
	/** Several root folders: the Explorer shows each as a root, Search groups by folder. */
	isMultiRoot = $derived(this.folders.length > 1);
	/** The window title's workspace part (VS Code's `${rootName}`). */
	title = $derived(workspaceLabel(this.folders, this.workspaceFile, this.untitled !== null, (name) => t('workspaces.workspaceSuffix', { name }), t('workspaces.untitled')));
	/**
	 * What per-workspace state (layout, terminals, open editors) is stored under: the folder itself
	 * for a single folder, `empty:<id>` for an empty window (null from an older Rust side).
	 */
	stateKey = $derived(workspaceStateKey(this.identity, this.root, this.empty));

	#listeners = new Set<Listener>();
	#raw = new Set<Listener>();
	/** The user's home folder (for `~/…` labels); empty until read. */
	home = $state('');

	async init() {
		this.window = windowLabel();
		let pending: string[] = [];
		try {
			const info = await invoke<WorkspaceState>('workspace_state');
			this.#apply(info);
			pending = info.open_files ?? [];
		} catch {
			// An older Rust side: one folder.
			const info = await invoke<{ workspace: string }>('app_info').catch(() => ({ workspace: '' }));
			this.root = info.workspace || null;
			this.folders = this.root ? [{ path: this.root, name: this.name }] : [];
		} finally {
			this.ready = true;
		}
		homeDir().then((h) => (this.home = h.replace(/\/$/, '')), () => {});
		// Reopened at startup: a workspace that came from a `.code-workspace` file keeps its settings.
		if (this.workspaceFile) {
			const file = this.workspaceFile;
			void this.#loadWorkspaceFile(file).then((w) => w && this.#useWorkspaceSettings(w));
		} else {
			// An older build remembered the file in this page's storage: hand it to Rust.
			const saved = savedWorkspaceFile();
			if (saved && saved.root === this.root) {
				void this.#loadWorkspaceFile(saved.file).then((w) => {
					if (!w) return;
					this.#useWorkspaceSettings(w);
					void this.#setFile(saved.file);
				});
			}
			saveWorkspaceFile(null);
		}
		await this.loadRecent();
		// Open File with window.openFilesInNewWindow: the files this window was opened for.
		for (const path of pending) this.openPath(path);
	}

	#apply(info: WorkspaceState) {
		this.window = info.window || this.window;
		this.folders = info.folders;
		this.root = info.folders[0]?.path ?? null;
		this.workspaceFile = info.file;
		this.untitled = info.untitled;
		this.identity = info.identity;
		this.empty = info.empty ?? null;
		// Language servers know every root folder (didChangeWorkspaceFolders when one is added or removed).
		lsp.setFolders(this.folders);
	}

	async loadRecent() {
		[this.recent, this.recentFiles] = await Promise.all([invoke<string[]>('workspace_recent').catch(() => []), invoke<string[]>('external_recent').catch(() => [])]);
	}

	/** The root folder a workbench path belongs to. */
	folderOf(key: string): WorkspaceFolder | null {
		return folderOf(key, this.folders);
	}

	/** The editor key of an absolute path: a workspace path in any root folder, else an external file. */
	keyFor(absolute: string): string {
		return keyForPath(absolute, this.folders) ?? externalKey(absolute);
	}

	/**
	 * File: Open File… (VS Code opens any file). A file inside a folder opens as a workspace file,
	 * one outside them as an external editor (Rust allows only what the picker returned); a
	 * `.code-workspace` file opens as a workspace. `window.openFilesInNewWindow: on` opens them in a
	 * new window.
	 */
	async openFile() {
		let picked: string[];
		try {
			picked = await invoke<string[]>('external_pick_files', { title: t('workspaces.openFileTitle'), defaultPath: dialogDefaultPath() });
		} catch (e) {
			notifications.error(t('workspaces.openFileFailed', { error: String(e) }));
			return;
		}
		const files = picked.filter((p) => !isWorkspaceFile(p));
		if (files.length && settings.get('window.openFilesInNewWindow') === 'on') {
			await this.newWindow({ files });
			for (const path of picked.filter(isWorkspaceFile)) void this.openWorkspaceFile(path);
		} else for (const path of picked) this.openPath(path);
		await this.loadRecent();
	}

	/** Opens an absolute path that Open File (or Open Recent) allowed. */
	openPath(path: string) {
		if (isWorkspaceFile(path)) void this.openWorkspaceFile(path);
		else editors.open(this.keyFor(path), { preview: false });
	}

	/** File: Open Workspace from File… */
	async pickWorkspaceFile() {
		const [file] = await invoke<string[]>('external_pick_files', { workspace: true, title: t('workspaces.openWorkspaceTitle'), defaultPath: dialogDefaultPath() }).catch((e) => {
			notifications.error(t('workspaces.openFileFailed', { error: String(e) }));
			return [];
		});
		if (file) await this.openWorkspaceFile(file);
	}

	/**
	 * Opens a `.code-workspace` file: all its folders as root folders, with the file's `settings`
	 * under the folders' own. In a new window with `window.openFoldersInNewWindow: on`, or when
	 * `newWindow` says so; a window that already has the file open comes to the front.
	 */
	async openWorkspaceFile(file: string, opts: { newWindow?: boolean } = {}): Promise<boolean> {
		const parsed = await this.#loadWorkspaceFile(file);
		if (!parsed) return false;
		const name = workspaceName(file);
		if (!parsed.folders.length) {
			notifications.error(t('workspaces.noFolders', { name }));
			return false;
		}
		if (file === this.workspaceFile) return true;
		if (opts.newWindow ?? this.#foldersInNewWindow()) {
			await this.newWindow({ folders: parsed.folders, file });
			return true;
		}
		if (!(await confirmDiscard())) return false;
		let info: WorkspaceState;
		try {
			info = await invoke<WorkspaceState>('workspace_open_folders', { folders: parsed.folders, file });
		} catch (e) {
			notifications.error(t('workbench.workspace.openFailed', { error: String(e) }));
			return false;
		}
		if (!info.folders.length) {
			notifications.error(t('workspaces.noFolders', { name }));
			return false;
		}
		const missing = parsed.folders.length - info.folders.length;
		if (missing > 0) notifications.info(t('workspaces.missingFolders', { name, count: missing }));
		this.#switched(info);
		this.#useWorkspaceSettings(parsed);
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

	#useWorkspaceSettings(parsed: CodeWorkspace) {
		settings.workspaceFile = parseSettingsText(JSON.stringify(parsed.settings));
	}

	async #setFile(file: string | null) {
		try {
			this.#apply(await invoke<WorkspaceState>('workspace_set_file', { file }));
		} catch (e) {
			clientLog('error', `workspace_set_file: ${e}`);
		}
	}

	/** File: Save Workspace As… — a `.code-workspace` file listing every root folder (relative to the file) and the workspace file's settings. */
	async saveWorkspaceAs() {
		if (!this.root) return;
		const base = this.workspaceFile ? workspaceName(this.workspaceFile) : this.name || 'workspace';
		let saved: { rel: string | null; path: string } | null;
		try {
			saved = await invoke<{ rel: string | null; path: string } | null>('fs_save_as', { content: workspaceFileText(this.folders, settings.workspaceFile, null), name: `${base}.code-workspace`, dir: null });
		} catch (e) {
			notifications.error(t('workspaces.saveFailed', { error: String(e) }));
			return;
		}
		if (!saved) return;
		// Now that the file's place is known, its folders are written relative to it (VS Code does
		// the same), so the file can move with its folders.
		const relative = workspaceFileText(this.folders, settings.workspaceFile, saved.path);
		const write = saved.rel !== null ? invoke('fs_write_file', { rel: saved.rel, content: relative }) : invoke('external_textfile_write', { path: saved.path, content: relative, encoding: 'utf8' });
		await write.catch((e) => clientLog('info', `workspace file kept absolute paths: ${e}`));
		await this.#setFile(saved.path);
		notifications.info(t('workspaces.saved', { name: saved.path.split('/').pop() ?? saved.path }));
		await this.loadRecent();
	}

	/** File: Add Folder to Workspace… — the folders become root folders of this window (an untitled workspace when it had one folder). */
	async addFolderToWorkspace(paths?: string[]) {
		let dirs = paths;
		if (!dirs) {
			const picked = await open({ directory: true, multiple: true, title: t('workspaces.addFolderTitle'), defaultPath: this.root ?? (dialogDefaultPath() ?? (this.home || undefined)) });
			dirs = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : [];
		}
		dirs = dirs.filter((d) => !this.folders.some((f) => f.path === d));
		if (!dirs.length) return;
		if (!this.root) {
			// An empty window: the first folder simply opens (and the rest are added to it).
			const [first, ...rest] = dirs;
			if ((await this.openFolder(first, { newWindow: false })) && rest.length) await this.addFolderToWorkspace(rest);
			return;
		}
		let info: WorkspaceState;
		try {
			info = await invoke<WorkspaceState>('workspace_add_folders', { paths: dirs });
		} catch (e) {
			notifications.error(t('workspaces.addFailed', { error: String(e) }));
			return;
		}
		this.#foldersChanged(info);
	}

	/** Explorer › Remove Folder from Workspace (VS Code: `removeRootFolder`). */
	async removeFolder(path: string) {
		if (!this.folders.some((f) => f.path === path)) return;
		const first = path === this.root;
		if (first && !(await confirmDiscard())) return;
		let info: WorkspaceState;
		try {
			info = await invoke<WorkspaceState>('workspace_remove_folder', { path });
		} catch (e) {
			notifications.error(t('workspaces.removeFailed', { error: String(e) }));
			return;
		}
		// The first folder carries the language servers, Source Control and tasks: they start over.
		if (first) this.#switched(info);
		else {
			this.#foldersChanged(info);
			// Its saved editors and Explorer rows go with it (an unsaved one stays, to be saved or reverted).
			for (const key of editors.openPaths()) if (within(key, path) && !editors.isDirty(key)) editors.closeEverywhere(key);
			explorer.forgetRoot(path);
		}
	}

	/** Root folders added or removed (not the first one): the views keep what they show. */
	#foldersChanged(info: WorkspaceState) {
		const firstBefore = this.root;
		this.#apply(info);
		if (this.root !== firstBefore) {
			this.#switched(info);
			return;
		}
		search.clear();
		// Each root folder has its own repositories.
		void scm.rescan();
		clientLog('info', `workspace folders: ${this.folders.map((f) => f.path).join(', ')}`);
		void this.loadRecent();
	}

	/** window.openFoldersInNewWindow: `on` opens every folder in a new window; `default` and `off` reuse this one for a folder picked in the app. */
	#foldersInNewWindow(): boolean {
		return settings.get('window.openFoldersInNewWindow') === 'on';
	}

	/** `workbench.action.files.openFolder`: the native folder picker. Several folders picked open as one multi-root workspace. */
	async pickFolder(opts: { newWindow?: boolean } = {}) {
		const picked = await open({ directory: true, multiple: true, title: t('workspaces.openFolderTitle'), defaultPath: this.root ?? (dialogDefaultPath() ?? (this.home || undefined)) });
		const dirs = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : [];
		if (dirs.length === 1) await this.openFolder(dirs[0], opts);
		else if (dirs.length > 1) await this.openFolders(dirs, opts);
	}

	/** Several folders as one untitled multi-root workspace (VS Code: a multi-selection in Open Folder). */
	async openFolders(paths: string[], opts: { newWindow?: boolean } = {}): Promise<boolean> {
		const folders = paths.map((path) => ({ path, name: path.split('/').pop() || path }));
		if (opts.newWindow ?? this.#foldersInNewWindow()) {
			await this.newWindow({ folders });
			return true;
		}
		if (!(await confirmDiscard())) return false;
		try {
			this.#switched(await invoke<WorkspaceState>('workspace_open_folders', { folders, file: null }));
		} catch (e) {
			notifications.error(t('workbench.workspace.openFailed', { error: String(e) }));
			return false;
		}
		return true;
	}

	/**
	 * Opens `path` as this window's only folder, or in a new window (`newWindow`, else
	 * `window.openFoldersInNewWindow: on`). A folder already open in another window brings that
	 * window to the front instead, like VS Code.
	 */
	async openFolder(path: string, opts: { newWindow?: boolean } = {}): Promise<boolean> {
		if (path === this.root && this.folders.length === 1 && !this.workspaceFile && !this.untitled) return true;
		if (opts.newWindow ?? this.#foldersInNewWindow()) {
			await this.newWindow({ folders: [{ path, name: path.split('/').pop() || path }] });
			return true;
		}
		if (await invoke<boolean>('window_focus_folder', { path }).catch(() => false)) return true;
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
		const info = await invoke<WorkspaceState>('workspace_state').catch(() => null);
		this.#switched(info ?? { window: this.window, folders: [{ path: root, name: root.split('/').pop() || root }], file: null, untitled: null, identity: root });
		return true;
	}

	/** Close Folder / Close Workspace: the window stays, empty. */
	async closeFolder() {
		if (this.root === null || !(await confirmDiscard())) return;
		try {
			await invoke('workspace_close');
		} catch (e) {
			notifications.error(e);
			return;
		}
		// The empty window's new id comes from Rust.
		const info = await invoke<WorkspaceState>('workspace_state').catch(() => null);
		this.#switched(info ?? { window: this.window, folders: [], file: null, untitled: null, identity: null });
	}

	/** New Window (⇧⌘N), and opening folders, a workspace file or files in one. A window that already has them comes to the front. */
	async newWindow(options: { folders?: WorkspaceFolder[]; file?: string; files?: string[]; duplicate?: boolean } = {}) {
		try {
			await invoke<string>('window_new', { options });
		} catch (e) {
			notifications.error(t('workspaces.newWindowFailed', { error: String(e) }));
		}
	}

	/** Duplicate As Workspace in New Window: the same folders, as a new untitled workspace. */
	duplicateInNewWindow() {
		if (!this.folders.length) return this.newWindow();
		return this.newWindow({ folders: this.folders, duplicate: true });
	}

	/** Close Window (⇧⌘W): through the close guard, like the window's close button. */
	closeWindow() {
		return invoke('window_close').catch((e) => notifications.error(e));
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

	/** File watcher batches (workspace paths, git internals removed) for editors to reload. */
	onFilesChanged(fn: Listener): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	/** Every watcher batch of the first folder, git internals included (a task worktree's index lives in `.git/worktrees/`). */
	onAnyChange(fn: Listener): () => void {
		this.#raw.add(fn);
		return () => this.#raw.delete(fn);
	}

	/** Every view of the old workspace goes: editors, language servers, tree, search, source control. */
	#switched(info: WorkspaceState) {
		editors.closeAll();
		navigation.clear();
		lsp.reset();
		debug.reset();
		explorer.reset();
		search.clear();
		scm.reset();
		this.#apply(info);
		// The workspace file's settings come back with the file (openWorkspaceFile sets them right after).
		settings.workspaceFile = {};
		// Workspace settings (`.kingu/settings.json`) belong to the first folder.
		void settings.reloadWorkspace();
		clientLog('info', `workspace: ${this.folders.length ? this.folders.map((f) => f.path).join(', ') : '(none)'}`);
		void this.loadRecent();
		// The Explorer re-reads its root when shown; Source Control reads the new repository now.
		if (this.root) void scm.refresh();
	}

	/** Listens to this window's file watchers (one per root folder); returns the uninstaller. */
	install(): () => void {
		let unlisten: (() => void) | undefined;
		let gone = false;
		listenWindow<FilesChanged>('workspace:files-changed', (e) => {
			if (!this.root) return;
			const primary = e.payload.root === this.root;
			// Git internals and task worktrees are filtered on the root-relative paths.
			const own = watcherPaths(e.payload.root, e.payload.paths, this.folders);
			if (!own) return;
			const qualify = (paths: string[]) => watcherPaths(e.payload.root, paths, this.folders) ?? [];
			// Agents writing into `.kingu/worktrees/` do not refresh the IDE's Source Control or Explorer.
			const ide = ideChanges(e.payload.paths);
			// Every root folder's changes re-read Source Control (each folder has its repositories).
			if (ide.length) void scm.refresh();
			if (primary) for (const fn of this.#raw) fn(e.payload.paths);
			const files = workspaceFiles(e.payload.paths);
			if (!files.length) return;
			const ideFiles = workspaceFiles(ide);
			if (ideFiles.length) void explorer.refresh(qualify(ideFiles));
			if (primary && files.includes(WORKSPACE_SETTINGS_PATH)) void settings.load();
			const keys = qualify(files);
			for (const fn of this.#listeners) fn(keys);
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

/** Where a build before multiple windows kept the folder's `.code-workspace` file (read once, to move it to Rust). */
/** `files.dialog.defaultPath`: where a file dialog starts instead of the home folder when no folder gives it one. */
export function dialogDefaultPath(): string | undefined {
	const p = settings.get<string>('files.dialog.defaultPath')?.trim();
	return p && p.startsWith('/') ? p : undefined;
}

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
		// No storage: nothing to move.
	}
}

export const workspace = new Workspace();
