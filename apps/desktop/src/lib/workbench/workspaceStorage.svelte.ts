// Per-workspace UI state (VS Code's StorageScope.WORKSPACE): which parts of the workbench and of
// the Agents layout are shown, the side bar's view, Zen Mode, the centered layout, the views'
// state (Outline, Problems, Search, the Explorer's expanded folders) and the like belong to the
// workspace a window has open, not to every window. Sizes stay shared (VS Code keeps them per
// profile). A window that opens a folder gets that folder's state, a new empty window the
// defaults (each empty window has its own id, see workspaceStateKey).
//
// A store registers the keys it keeps per workspace; switchTo() hands it the saved state of the
// window's workspace (null: the defaults) and save() keeps it there. Nothing is saved before the
// window knows its workspace, nor while it is switching to another one (a view cleared for the
// switch must not overwrite the old workspace's state). The state an older build kept for every
// window goes, once, to the first workspace this page opens that has none of its own.
//
// Like VS Code's storage cleaner, a while after startup the state of workspaces no window can
// show again (an empty window or untitled workspace that is gone, a folder that no longer
// exists) is deleted, and beyond MAX_WORKSPACES the least recently opened ones go.

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { persist, restore } from '#lib/terminal/sessions.ts';
import { namesOfTags, parseIndex, pick, scopedName, tagsToDrop, touched } from './workspaceState';

type Loader = (saved: Record<string, unknown> | null) => void;
type Entry = { keys: readonly string[]; load: Loader; legacy: Record<string, unknown> | null };

const INDEX = 'kingu.workspaceStorage.index';
/** VS Code's cleaner runs 30 s after startup. */
const CLEANUP_DELAY = 30_000;

class WorkspaceStorage {
	/** The workspace the scoped state belongs to; undefined until the window knows it. */
	scope = $state<string | undefined>(undefined);
	#entries = new Map<string, Entry>();
	/** The window's workspace as it is right now (it changes before switchTo runs). */
	#current: () => string | undefined = () => this.scope;

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
		persist(INDEX, touched(parseIndex(restore(INDEX, (raw) => raw)), scope, Date.now()));
	}

	/** Saves `value` as `base`'s state in the current workspace (nothing before it is known or while switching). */
	save(base: string, value: Record<string, unknown>) {
		if (this.scope !== undefined && this.#current() === this.scope) persist(scopedName(base, this.scope), value);
	}

	/** Where the window's workspace comes from (installWorkspaceStorage). */
	follow(current: () => string | undefined) {
		this.#current = current;
	}

	#load(base: string, entry: Entry, scope: string) {
		const saved = restore(scopedName(base, scope), (raw) => pick(raw, entry.keys));
		entry.load(saved ?? entry.legacy);
		entry.legacy = null;
	}
}

export const workspaceStorage = new WorkspaceStorage();

/** Deletes the state of workspaces no window can show again, and of the oldest beyond the limit. */
export async function cleanUpWorkspaceStorage(): Promise<void> {
	const index = parseIndex(restore(INDEX, (raw) => raw));
	const scopes = Object.values(index).map((e) => e.scope);
	if (!scopes.length) return;
	const stale = new Set(await invoke<string[]>('workspace_storage_stale', { scopes }));
	const keep = new Set([workspaceStorage.scope].filter((s): s is string => s !== undefined));
	const drop = tagsToDrop(index, stale, keep);
	if (!drop.length) return;
	try {
		const names: string[] = [];
		for (let i = 0; i < localStorage.length; i++) names.push(localStorage.key(i) ?? '');
		const tags = new Set(drop);
		for (const name of namesOfTags(names, tags)) localStorage.removeItem(name);
		// Another window may have opened one of them meanwhile: only the dropped entries go.
		const now = parseIndex(restore(INDEX, (raw) => raw));
		for (const tag of drop) delete now[tag];
		persist(INDEX, now);
		clientLog('info', `workspace storage: removed the state of ${drop.length} workspace(s)`);
	} catch {
		// Storage unavailable: nothing to clean.
	}
}

/** Follows the window's workspace (`scope()`, undefined until it is known); returns the uninstaller. */
export function installWorkspaceStorage(scope: () => string | undefined): () => void {
	workspaceStorage.follow(scope);
	const timer = setTimeout(() => void cleanUpWorkspaceStorage().catch((e) => clientLog('error', `workspace storage cleanup: ${e}`)), CLEANUP_DELAY);
	const stop = $effect.root(() => {
		$effect(() => {
			const s = scope();
			if (s !== undefined) untrack(() => workspaceStorage.switchTo(s));
		});
	});
	return () => {
		clearTimeout(timer);
		stop();
	};
}
