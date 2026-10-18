// Text models shared by every editor group (VS Code: ITextModelService, one model per resource).
// Two groups showing a file edit the same model, so edits, undo history and dirty state are per
// file, and the language server sees one didOpen/didClose per file. View state (scroll, cursor)
// is per group and file, like VS Code's per-editor view state.

import type * as Monaco from 'monaco-editor';
import { clientLog } from '#lib/client-log.ts';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { associatedLanguage, eolFor, type SaveReason } from '#lib/settings/mappings.ts';
import { readResource, writeResource } from '#lib/settings/resources.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from './editors.svelte';
import { invoke } from '@tauri-apps/api/core';
import { runSaveParticipants } from './textFileSave';
import { isUntitled, suggestedName } from './untitled';
import { notifications } from './notifications.svelte';

type MonacoModule = typeof import('#lib/editor/monaco.ts');
export type ModelEntry = { model: Monaco.editor.ITextModel; savedVersion: number; reloading?: boolean };

const entries = new Map<string, ModelEntry>();
const loading = new Map<string, Promise<ModelEntry>>();
const views = new Map<string, Monaco.editor.ICodeEditorViewState | null>();
let api: MonacoModule | undefined;

// Workspace edits (LSP rename, code actions, Search: Replace) go into open files' models.
editors.textModel = (path) => {
	const model = entries.get(path)?.model;
	return model && !model.isDisposed() ? model : null;
};

const viewKey = (group: number, path: string) => `${group}\u0000${path}`;

export function getEntry(path: string): ModelEntry | undefined {
	return entries.get(path);
}

/** The shared model of `path`, read from disk the first time any group shows it. */
export function modelEntry(m: MonacoModule, path: string): Promise<ModelEntry> {
	api = m;
	const existing = entries.get(path);
	if (existing) return Promise.resolve(existing);
	let pending = loading.get(path);
	if (!pending) {
		// readResource: workspace files, or the user settings.json (settings:// key).
		pending = readResource(path)
			.then((text) => {
				// A references peek may already have made a preview model for this file.
				const preview = lsp.adoptPreview(path);
				if (preview && preview.getValue() !== text) preview.setValue(text);
				const model = preview ?? m.monaco.editor.createModel(text, languageOf(m, path), m.monaco.Uri.file('/' + path));
				// files.eol: a file with no line break yet takes the configured one (not counted as an edit).
				if (!/\r?\n/.test(text)) model.setEOL(eolFor(settings.get('files.eol')) === '\n' ? m.monaco.editor.EndOfLineSequence.LF : m.monaco.editor.EndOfLineSequence.CRLF);
				const entry: ModelEntry = { model, savedVersion: model.getAlternativeVersionId() };
				model.onDidChangeContent(() => !entry.reloading && editors.setDirty(path, model.getAlternativeVersionId() !== entry.savedVersion));
				entries.set(path, entry);
				lsp.attach(m.monaco, model, path);
				return entry;
			})
			.finally(() => loading.delete(path));
		loading.set(path, pending);
	}
	return pending;
}

/** `files.associations` over the extension's language, when the associated language exists. */
export function languageOf(m: MonacoModule, path: string): string {
	const id = associatedLanguage(path, settings.get('files.associations'));
	return id && m.monaco.languages.getLanguages().some((l) => l.id === id) ? id : m.languageFor(path);
}

/** Every open model with its path, for settings that follow open files (files.associations). */
export function openModels(): [string, Monaco.editor.ITextModel][] {
	return [...entries].filter(([, e]) => !e.model.isDisposed()).map(([p, e]) => [p, e.model]);
}

/** Runs the save participants (format, trim…), then writes. `reason` is how the save was triggered. */
export async function saveFile(path: string, reason: SaveReason = 'explicit') {
	const entry = entries.get(path);
	if (!entry) return;
	// An untitled editor has no file yet: an explicit save asks where (auto save leaves it alone).
	if (isUntitled(path)) {
		if (reason === 'explicit') await saveAs(path);
		return;
	}
	if (api) await runSaveParticipants(api.monaco, entry.model, reason);
	if (entry.model.isDisposed()) return;
	await writeResource(path, entry.model.getValue());
	entry.savedVersion = entry.model.getAlternativeVersionId();
	editors.setDirty(path, false);
	lsp.didSave(entry.model);
}

type SavedAs = { rel: string | null; path: string };

/**
 * Save As (⇧⌘S), and the first save of an untitled editor: the native save dialog (run by Rust),
 * then the editor switches to the new file like VS Code. The old file keeps what is on disk.
 * Returns the new workspace path, or null when cancelled or saved outside the folder.
 */
export async function saveAs(path: string): Promise<string | null> {
	const entry = entries.get(path);
	if (!entry) return null;
	const text = entry.model.getValue();
	const slash = path.lastIndexOf('/');
	let saved: SavedAs | null;
	try {
		saved = await invoke<SavedAs | null>('fs_save_as', {
			content: text,
			name: suggestedName(path, text),
			dir: !isUntitled(path) && slash > 0 ? path.slice(0, slash) : null
		});
	} catch (e) {
		notifications.error(`บันทึกเป็นไฟล์ใหม่ไม่สำเร็จ (Save As failed): ${e}`);
		return null;
	}
	if (!saved) return null;
	if (!saved.rel) {
		notifications.info(`บันทึกไว้ที่ ${saved.path} ซึ่งอยู่นอกโฟลเดอร์ที่เปิด จึงเปิดเป็นแท็บไม่ได้ (Saved outside the open folder.)`);
		if (isUntitled(path)) {
			editors.setDirty(path, false);
			editors.closeEverywhere(path);
		}
		return null;
	}
	const rel = saved.rel;
	editors.setDirty(path, false);
	if (rel !== path) {
		// The editor now shows the new file; the old model goes once no tab shows it.
		editors.remap((p) => (p === path ? rel : null));
		// An already-loaded model of the target is stale now.
		void reloadClean([rel]);
	} else {
		entry.savedVersion = entry.model.getAlternativeVersionId();
	}
	return rel;
}

/** Revert File: the editor takes the file's contents on disk and is clean again (undoable). */
export async function revertFile(path: string) {
	const entry = entries.get(path);
	if (!entry) return;
	if (isUntitled(path)) {
		entry.model.setValue('');
		entry.savedVersion = entry.model.getAlternativeVersionId();
		editors.setDirty(path, false);
		return;
	}
	const text = await readResource(path);
	if (entry.model.isDisposed()) return;
	entry.reloading = true;
	try {
		entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text }], () => null);
	} finally {
		entry.reloading = false;
	}
	entry.savedVersion = entry.model.getAlternativeVersionId();
	editors.setDirty(path, false);
}

/**
 * The file watcher saw `paths` change on disk: a clean model takes the new contents (undoable, and
 * every group showing it follows); a dirty one keeps the user's version.
 */
export async function reloadClean(paths: string[]) {
	for (const path of paths) {
		const entry = entries.get(path);
		if (!entry || entry.model.getAlternativeVersionId() !== entry.savedVersion) continue;
		let text: string;
		try {
			text = await readResource(path);
		} catch (e) {
			// Deleted: workbench.editor.closeOnFileDelete closes its (clean) tabs, else they keep the last contents.
			if (settings.get<boolean>('workbench.editor.closeOnFileDelete') && /not found|No such file|os error 2/i.test(String(e))) editors.closeEverywhere(path);
			continue;
		}
		const { model } = entry;
		if (model.isDisposed() || model.getValue() === text || model.getAlternativeVersionId() !== entry.savedVersion) continue;
		entry.reloading = true;
		try {
			model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
		} finally {
			entry.reloading = false;
		}
		entry.savedVersion = model.getAlternativeVersionId();
		clientLog('info', `reloaded ${path} (changed on disk)`);
	}
}

export function saveViewState(group: number, path: string, state: Monaco.editor.ICodeEditorViewState | null) {
	views.set(viewKey(group, path), state);
}

export function viewState(group: number, path: string) {
	return views.get(viewKey(group, path)) ?? null;
}

/** Disposes the models (and view states) of files no group or ADE tab has open any more; their unsaved edits go with them. */
export function disposeClosed(open: Set<string>, groups: number[]) {
	for (const [path, entry] of entries) {
		if (open.has(path)) continue;
		editors.setDirty(path, false);
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
