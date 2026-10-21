// Per-workspace UI state (VS Code's StorageScope.WORKSPACE): which parts of the workbench and of
// the Agents layout are shown, the side bar's view, Zen Mode and the centered layout belong to
// the workspace a window has open, not to every window. Sizes stay shared (VS Code keeps them per
// profile). A window that opens a folder gets that folder's state, a new empty window the
// defaults (each empty window has its own id, see workspaceStateKey).
//
// A store registers the keys it keeps per workspace; switchTo() hands it the saved state of the
// window's workspace (null: the defaults) and save() keeps it there. Nothing is saved before the
// window knows its workspace. The state an older build kept for every window goes, once, to the
// first workspace this page opens that has none of its own.

import { untrack } from 'svelte';
import { persist, restore } from '#lib/terminal/sessions.ts';
import { pick, scopedName } from './workspaceState';

type Loader = (saved: Record<string, unknown> | null) => void;
type Entry = { keys: readonly string[]; load: Loader; legacy: Record<string, unknown> | null };

class WorkspaceStorage {
	/** The workspace the scoped state belongs to; undefined until the window knows it. */
	scope = $state<string | undefined>(undefined);
	#entries = new Map<string, Entry>();

	/** `base`'s `keys` follow the workspace; `legacy`: what an older build saved for every window. */
	register(base: string, keys: readonly string[], load: Loader, legacy: unknown = null) {
		const entry: Entry = { keys, load, legacy: pick(legacy, keys) };
		this.#entries.set(base, entry);
		if (this.scope !== undefined) this.#load(base, entry, this.scope);
	}

	/** The window's workspace is now `scope`: every store shows that workspace's state. */
	switchTo(scope: string) {
		if (scope === this.scope) return;
		for (const [base, entry] of this.#entries) this.#load(base, entry, scope);
		this.scope = scope;
	}

	/** Saves `value` as `base`'s state in the current workspace (nothing before it is known). */
	save(base: string, value: Record<string, unknown>) {
		if (this.scope !== undefined) persist(scopedName(base, this.scope), value);
	}

	#load(base: string, entry: Entry, scope: string) {
		const saved = restore(scopedName(base, scope), (raw) => pick(raw, entry.keys));
		entry.load(saved ?? entry.legacy);
		entry.legacy = null;
	}
}

export const workspaceStorage = new WorkspaceStorage();

/** Follows the window's workspace (`scope()`, undefined until it is known); returns the uninstaller. */
export function installWorkspaceStorage(scope: () => string | undefined): () => void {
	return $effect.root(() => {
		$effect(() => {
			const s = scope();
			if (s !== undefined) untrack(() => workspaceStorage.switchTo(s));
		});
	});
}
