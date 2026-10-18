// Restores a folder's open editors when it opens (at startup, after Open Folder, after a reload)
// and keeps the list up to date while it is open. With nothing to restore,
// `workbench.startupEditor: readme` opens the folder's README.

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import { persist, restore, rootTag, storeName } from '#lib/terminal/sessions.ts';
import { editors } from './editors.svelte';
import { openEditorsState, parseOpenEditors, readmeOf } from './openEditors';
import { workspace } from './workspace.svelte';

const STORE = 'kingu.openEditors';

export function installEditorRestore(): () => void {
	/** The folder whose editors are shown (and saved); null while one is being restored. */
	let tag: string | null = null;
	let generation = 0;
	let shownRoot: string | null | undefined;

	async function show(root: string) {
		const mine = ++generation;
		tag = null;
		const saved = restore(storeName(STORE, rootTag(root)), parseOpenEditors);
		if (saved?.paths.length) {
			for (const path of saved.paths) editors.open(path, { preview: false });
			if (saved.active) editors.open(saved.active, { preview: false });
		} else if (settings.get('workbench.startupEditor') === 'readme') {
			const entries = await invoke<{ name: string; is_dir: boolean }[]>('fs_list_dir', { rel: '' }).catch(() => []);
			const readme = readmeOf(entries.filter((e) => !e.is_dir).map((e) => e.name));
			if (mine === generation && readme && editors.openPaths().size === 0) editors.open(readme, { preview: true });
		}
		if (mine === generation) tag = rootTag(root);
	}

	const stop = $effect.root(() => {
		$effect(() => {
			if (!workspace.ready || !settings.loaded) return;
			const root = workspace.root;
			if (root === shownRoot) return;
			shownRoot = root;
			untrack(() => {
				tag = null;
				if (root) void show(root);
			});
		});
		$effect(() => {
			const state = openEditorsState(editors.allTabs(), editors.active);
			// Closing the old folder's editors happens with the switch: never save that under the old folder.
			const current = workspace.root && rootTag(workspace.root);
			untrack(() => {
				if (tag && tag === current) persist(storeName(STORE, tag), state);
			});
		});
	});
	return stop;
}
