// Editor history per folder (VS Code: IHistoryService's recently opened editors), which Quick Open
// lists first. Kept in localStorage per workspace root, like VS Code's workspace storage.

import { untrack } from 'svelte';
import { persist, restore, rootTag, storeName } from '#lib/terminal/sessions.ts';
import { editors } from './editors.svelte';
import { isRestorable } from './openEditors';
import { pushHistory } from './quickAccess';
import { workspace } from './workspace.svelte';

const STORE = 'kingu.editorHistory';

const parse = (raw: unknown): string[] | null => (Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && isRestorable(p)) : null);

class RecentFiles {
	list = $state<string[]>([]);
	#root: string | null = null;

	install(): () => void {
		return $effect.root(() => {
			$effect(() => {
				const root = workspace.root;
				untrack(() => {
					this.#root = root;
					this.list = root ? (restore(storeName(STORE, rootTag(root)), parse) ?? []) : [];
				});
			});
			$effect(() => {
				const active = editors.active;
				if (!active || !isRestorable(active)) return;
				untrack(() => this.record(active));
			});
		});
	}

	record(path: string) {
		if (this.list[0] === path) return;
		this.list = pushHistory(this.list, path);
		if (this.#root) persist(storeName(STORE, rootTag(this.#root)), this.list);
	}

	/** Files deleted or renamed away leave the history (VS Code removes them on file events). */
	forget(path: string) {
		this.list = this.list.filter((p) => p !== path);
		if (this.#root) persist(storeName(STORE, rootTag(this.#root)), this.list);
	}

	clear() {
		this.list = [];
		if (this.#root) persist(storeName(STORE, rootTag(this.#root)), []);
	}
}

export const recentFiles = new RecentFiles();
