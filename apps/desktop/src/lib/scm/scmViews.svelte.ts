// The code editors Source Control draws into (quick diff, blame, merge conflicts) and the
// versions of their files it compares against: the index for the quick diff and "Changes", HEAD
// for "Staged Changes" and unstaging. Versions are read once per git status read (every stage,
// commit, checkout, save and window focus re-reads status), so they follow the repository.

import { invoke } from '@tauri-apps/api/core';
import { untrack } from 'svelte';
import type * as Monaco from 'monaco-editor';
import { clientLog } from '#lib/client-log.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { scm } from '#lib/workbench/scm.svelte.ts';
import { isDiffKey } from '#lib/workbench/scm.ts';
import { isUntitled } from '#lib/workbench/untitled.ts';

export type MonacoApi = typeof Monaco;

/** A code editor showing a workspace file. */
export type ScmView = {
	monaco: MonacoApi;
	ed: Monaco.editor.IStandaloneCodeEditor;
	path(): string | null;
};

const views = new Set<ScmView>();

export function addView(v: ScmView): () => void {
	views.add(v);
	return () => views.delete(v);
}

/** The focused editor, else the active group's editor when it shows the active file. */
export function activeView(): ScmView | undefined {
	const all = [...views].filter((v) => v.path() !== null);
	return all.find((v) => v.ed.hasTextFocus() || v.ed.hasWidgetFocus()) ?? all.find((v) => v.path() === editors.active);
}

export const viewsOf = (path: string) => [...views].filter((v) => v.path() === path);

/** A file of the open folder that git may know (not untitled, a diff tab or one of Kingu's own resources). */
export const isRepoFile = (path: string | null): path is string => !!path && !isUntitled(path) && !isDiffKey(path) && !path.includes(':') && !path.startsWith('/');

type Version = { gen: number; text: string | null };

class ScmVersions {
	/** Bumped by every git status read. */
	gen = $state(0);
	/** Loaded versions by `index:<path>` / `head:<path>` (reactive, so editors redraw when one arrives). */
	#loaded = $state<Record<string, Version>>({});
	#pending = new Map<string, Promise<string | null>>();

	constructor() {
		$effect.root(() => {
			$effect(() => {
				void scm.repo;
				untrack(() => this.gen++);
			});
		});
	}

	/** The status entry of `path`, if it changed. */
	entry(path: string) {
		return scm.repo?.entries.find((e) => e.path === path);
	}

	/**
	 * The index version of `path` for the current status: a string, null when git has none (untracked,
	 * in conflict, outside a repository), undefined while it loads (a read is scheduled).
	 */
	index(path: string): string | null | undefined {
		return this.#get(`index:${path}`, () => this.#readIndex(path));
	}

	/** HEAD's version of `path` (a staged rename's source); '' when not in HEAD. */
	head(path: string): string | null | undefined {
		return this.#get(`head:${path}`, () => invoke<string>('git_show_head', { rel: this.entry(path)?.orig_path ?? path }));
	}

	/** {@link index} awaited. */
	loadIndex(path: string): Promise<string | null> {
		return this.#load(`index:${path}`, () => this.#readIndex(path));
	}

	loadHead(path: string): Promise<string | null> {
		return this.#load(`head:${path}`, () => invoke<string>('git_show_head', { rel: this.entry(path)?.orig_path ?? path }));
	}

	async #readIndex(path: string): Promise<string | null> {
		if (!scm.repo) return null;
		const e = this.entry(path);
		// Untracked files have no original (VS Code draws no quick diff for them).
		if (e?.worktree === '?') return null;
		return invoke<string | null>('scm_show_index', { rel: path });
	}

	#get(key: string, read: () => Promise<string | null>): string | null | undefined {
		const gen = this.gen;
		const v = this.#loaded[key];
		if (v && v.gen === gen) return v.text;
		if (!this.#pending.has(key)) queueMicrotask(() => void this.#load(key, read));
		return v?.text;
	}

	#load(key: string, read: () => Promise<string | null>): Promise<string | null> {
		const gen = this.gen;
		const v = this.#loaded[key];
		if (v && v.gen === gen) return Promise.resolve(v.text);
		const running = this.#pending.get(key);
		if (running) return running;
		const p = (async () => {
			let text: string | null = null;
			try {
				text = scm.repo ? await read() : null;
			} catch (e) {
				clientLog('info', `scm version ${key}: ${e}`);
			}
			this.#loaded[key] = { gen, text };
			return text;
		})().finally(() => this.#pending.delete(key));
		this.#pending.set(key, p);
		return p;
	}
}

export const versions = new ScmVersions();
