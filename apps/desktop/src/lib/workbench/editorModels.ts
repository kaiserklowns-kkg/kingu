// Text models shared by every editor group (VS Code: ITextModelService, one model per resource).
// Two groups showing a file edit the same model, so edits, undo history and dirty state are per
// file, and the language server sees one didOpen/didClose per file. View state (scroll, cursor)
// is per group and file, like VS Code's per-editor view state.

import { invoke } from '@tauri-apps/api/core';
import type * as Monaco from 'monaco-editor';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { editors } from './editors.svelte';

type MonacoModule = typeof import('#lib/editor/monaco.ts');
export type ModelEntry = { model: Monaco.editor.ITextModel; savedVersion: number };

const entries = new Map<string, ModelEntry>();
const loading = new Map<string, Promise<ModelEntry>>();
const views = new Map<string, Monaco.editor.ICodeEditorViewState | null>();

const viewKey = (group: number, path: string) => `${group}\u0000${path}`;

export function getEntry(path: string): ModelEntry | undefined {
	return entries.get(path);
}

/** The shared model of `path`, read from disk the first time any group shows it. */
export function modelEntry(api: MonacoModule, path: string): Promise<ModelEntry> {
	const existing = entries.get(path);
	if (existing) return Promise.resolve(existing);
	let pending = loading.get(path);
	if (!pending) {
		pending = invoke<string>('read_workspace_file', { rel: path })
			.then((text) => {
				const model = api.monaco.editor.createModel(text, api.languageFor(path), api.monaco.Uri.file('/' + path));
				const entry: ModelEntry = { model, savedVersion: model.getAlternativeVersionId() };
				model.onDidChangeContent(() => editors.setDirty(path, model.getAlternativeVersionId() !== entry.savedVersion));
				entries.set(path, entry);
				lsp.attach(api.monaco, model, path);
				return entry;
			})
			.finally(() => loading.delete(path));
		loading.set(path, pending);
	}
	return pending;
}

export async function saveFile(path: string) {
	const entry = entries.get(path);
	if (!entry) return;
	await invoke('fs_write_file', { rel: path, content: entry.model.getValue() });
	entry.savedVersion = entry.model.getAlternativeVersionId();
	editors.setDirty(path, false);
	lsp.didSave(entry.model);
}

export function saveViewState(group: number, path: string, state: Monaco.editor.ICodeEditorViewState | null) {
	views.set(viewKey(group, path), state);
}

export function viewState(group: number, path: string) {
	return views.get(viewKey(group, path)) ?? null;
}

/** Disposes the models (and view states) of files no group has open any more. */
export function disposeClosed(open: Set<string>, groups: number[]) {
	for (const [path, entry] of entries) {
		if (open.has(path)) continue;
		entry.model.dispose();
		entries.delete(path);
	}
	const live = new Set(groups);
	for (const key of views.keys()) {
		const [group, path] = key.split('\u0000');
		if (!open.has(path) || !live.has(Number(group))) views.delete(key);
	}
}

export function disposeAll() {
	for (const e of entries.values()) e.model.dispose();
	entries.clear();
	views.clear();
}
