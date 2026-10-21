// Restores a workspace's editor area when it opens (at startup, after Open Folder, after a
// reload) and keeps it up to date while it is open, like VS Code's EditorPart state: the groups
// and their grid, each group's editors with their pinned and preview state, the active editor
// and group, and each editor's scroll, cursor and folding (editorLayout.ts). With nothing to
// restore, `workbench.startupEditor` opens the folder's README (`readme`), a new untitled file
// (`newUntitledFile`) or a new terminal (`terminal`, in the panel: Kingu's terminals live there).

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import { persist, restore, rootTag, storeName } from '#lib/terminal/sessions.ts';
import { editors } from './editors.svelte';
import { commands } from './commands.svelte';
import { allViewStates, loadViewStates } from './editorModels';
import { fromOpenEditors, isRestorableKey, parseLayout, serializeLayout, withOpen, type SavedLayout } from './editorLayout';
import { parseOpenEditors, readmeOf } from './openEditors';
import type { HotExit } from './textFiles';
import { workspace } from './workspace.svelte';

const STORE = 'kingu.editorLayout';
/** What an older build kept: the open files only. */
const LEGACY_STORE = 'kingu.openEditors';
/** View states are saved this long after the cursor last moved (and when the window loses focus). */
const VIEW_SAVE_DELAY = 1000;

/** Untitled editors come back only while hot exit keeps their text. */
const keep = (key: string) => isRestorableKey(key, settings.get<HotExit>('files.hotExit') !== 'off');

/** Saves the shown workspace's editors now (the window is closing); set while installed. */
let saveNow: () => void = () => {};
export const saveEditorLayout = () => saveNow();

export function installEditorRestore(): () => void {
	/** The workspace whose editors are shown (and saved); null while one is being restored. */
	let tag: string | null = null;
	let generation = 0;
	let shownKey: string | null | undefined;

	function saved(key: string): SavedLayout | null {
		const t = rootTag(key);
		const layout = restore(storeName(STORE, t), (raw) => raw as SavedLayout);
		if (layout) return layout;
		const old = restore(storeName(LEGACY_STORE, t), parseOpenEditors);
		return old?.paths.length ? fromOpenEditors(old.paths, old.active) : null;
	}

	async function show(key: string, hasFolder: boolean) {
		const mine = ++generation;
		tag = null;
		// workbench.editor.restoreEditors: off leaves only the editors with unsaved changes (hot exit restores those).
		const layout = settings.get<boolean>('workbench.editor.restoreEditors') ? parseLayout(saved(key), keep) : null;
		if (layout && layout.model.groups.some((g) => g.tabs.length)) {
			loadViewStates(layout.views);
			editors.restoreModel(withOpen(layout.model, editors.model));
		} else if (hasFolder) {
			const startup = settings.get<string>('workbench.startupEditor');
			if (startup === 'readme') {
				const entries = await invoke<{ name: string; is_dir: boolean }[]>('fs_list_dir', { rel: '' }).catch(() => []);
				const readme = readmeOf(entries.filter((e) => !e.is_dir).map((e) => e.name));
				if (mine === generation && readme && editors.openPaths().size === 0) editors.open(readme, { preview: true });
			} else if (startup === 'newUntitledFile' && editors.openPaths().size === 0) void commands.run('workbench.action.files.newUntitledFile');
			else if (startup === 'terminal') void commands.run('workbench.action.terminal.new');
		}
		if (mine === generation) tag = rootTag(key);
	}

	/** The shown workspace's editors, with their view states (`workbench.editor.restoreViewState` off: the open ones' only). */
	function state(): SavedLayout {
		const all = allViewStates();
		const layout = serializeLayout(editors.model, keep, all);
		if (!settings.get<boolean>('workbench.editor.restoreViewState')) {
			const open = new Set(layout.groups.flatMap((g) => g.tabs.map((t) => `${g.id}\u0000${t.path}`)));
			layout.views = Object.fromEntries(Object.entries(layout.views ?? {}).filter(([k]) => open.has(k)));
		}
		return layout;
	}

	// Closing the old workspace's editors happens with the switch: never save that under the old one.
	const current = () => (workspace.ready && workspace.stateKey ? rootTag(workspace.stateKey) : null);
	function save() {
		if (!tag || tag !== current()) return;
		editors.flushViewStates();
		persist(storeName(STORE, tag), state());
	}
	saveNow = save;

	let timer: ReturnType<typeof setTimeout> | undefined;
	const later = () => {
		clearTimeout(timer);
		timer = setTimeout(save, VIEW_SAVE_DELAY);
	};
	const onHide = () => save();
	window.addEventListener('blur', onHide);
	window.addEventListener('pagehide', onHide);

	const stop = $effect.root(() => {
		$effect(() => {
			if (!workspace.ready || !settings.loaded) return;
			// Per workspace (the folder itself for a single folder); an empty window has its own too.
			const key = workspace.stateKey;
			if (key === shownKey) return;
			shownKey = key;
			const hasFolder = workspace.root !== null;
			untrack(() => {
				tag = null;
				if (key) void show(key, hasFolder);
			});
		});
		$effect(() => {
			// Any change to the groups, their editors or the active one is saved at once.
			JSON.stringify(serializeLayout(editors.model, keep));
			untrack(save);
		});
		$effect(() => {
			// Moving the cursor: the view states, a moment later.
			void editors.cursor;
			untrack(later);
		});
	});
	return () => {
		stop();
		clearTimeout(timer);
		window.removeEventListener('blur', onHide);
		window.removeEventListener('pagehide', onHide);
		saveNow = () => {};
	};
}
