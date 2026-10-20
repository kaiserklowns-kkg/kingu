// Text models shared by every editor group (VS Code: ITextModelService, one model per resource).
// Two groups showing a file edit the same model, so edits, undo history and dirty state are per
// file, and the language server sees one didOpen/didClose per file. View state (scroll, cursor)
// is per group and file, like VS Code's per-editor view state.
// Each model remembers what VS Code's TextFileEditorModel does: the file's encoding and the disk
// stat it was loaded or last saved with, so saving writes the same encoding and a file changed
// on disk since is reported as a save conflict instead of being overwritten.

import type * as Monaco from 'monaco-editor';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { clientLog } from '#lib/client-log.ts';
import { languageFor } from '#lib/editor/languages.ts';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { eolFor, type SaveReason } from '#lib/settings/mappings.ts';
import { readTextResource, writeTextResource, type FileStat, type ReadOptions, type TextRead } from '#lib/settings/resources.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { diskChangeAction, type AutoSaveMode } from './textFiles';
import { editors } from './editors.svelte';
import { externalKey, isExternalKey } from './externalFiles';
import { invoke } from '@tauri-apps/api/core';
import { runSaveParticipants } from './textFileSave';
import { defaultLanguage, isUntitled, suggestedName } from './untitled';
import { notifications } from './notifications.svelte';
import { t } from '#lib/i18n/index.ts';

type MonacoModule = typeof import('#lib/editor/monaco.ts');
export type ModelEntry = {
	model: Monaco.editor.ITextModel;
	savedVersion: number;
	reloading?: boolean;
	/** VS Code encoding id the file is read and saved with. */
	encoding: string;
	/** The disk state this model is based on (workspace files only). */
	stat?: FileStat;
	/** Some bytes were invalid in `encoding` and became U+FFFD. */
	lossy?: boolean;
	/** Set by Change Language Mode: `files.associations` no longer changes it. */
	explicitLanguage?: boolean;
	/** A save found a newer file on disk; auto save stops until it is resolved (VS Code's conflict mode). */
	inConflict?: boolean;
	/** Saves in flight: their own watcher event is not a change by someone else. */
	saving?: number;
};

/** A file that opens as a placeholder instead of a text editor (VS Code's binary / too large / error editors). */
export class OpenError extends Error {
	constructor(readonly result: Exclude<TextRead, { kind: 'text' }> | { kind: 'error'; message: string }) {
		super(result.kind === 'error' ? result.message : result.kind);
	}
}

/** Hooks the text file service installs (textFileService.svelte.ts), so this module stays free of dialogs. */
export const textFileHooks = {
	/** Read options for `path` beyond the settings ("Open Anyway", a backup's encoding). */
	readOptions: (_path: string): ReadOptions => ({}),
	/** A model was created: restore a backup into it, track it for backups. */
	created: (_path: string, _entry: ModelEntry) => {},
	/** A save hit a newer file on disk. */
	conflict: (_path: string) => {},
	/** A save could not encode a character. */
	unencodable: (_path: string, _ch: string) => {},
	/** The model is saved or reverted: its backup goes. */
	clean: (_path: string) => {}
};

const entries = new Map<string, ModelEntry>();
/** The first line of each open untitled editor (reactive, for its tab label). */
export const untitledFirstLines = new SvelteMap<string, string>();
/** Open untitled editors that are still empty (`workbench.editor.empty.hint`). */
export const emptyUntitled = new SvelteSet<string>();
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

/** Read options from the settings (`files.encoding`, `files.autoGuessEncoding`) plus the service's. */
export function readOptions(path: string, extra: ReadOptions = {}): ReadOptions {
	return {
		defaultEncoding: settings.get<string>('files.encoding'),
		autoGuess: settings.get<boolean>('files.autoGuessEncoding'),
		// workbench.editorLargeFileConfirmation is in MB.
		largeFileLimit: Math.round(settings.get<number>('workbench.editorLargeFileConfirmation') * 1024 * 1024),
		...textFileHooks.readOptions(path),
		...extra
	};
}

async function readText(path: string, extra: ReadOptions = {}) {
	let result: TextRead;
	try {
		result = await readTextResource(path, readOptions(path, extra));
	} catch (e) {
		throw new OpenError({ kind: 'error', message: String(e) });
	}
	if (result.kind !== 'text') throw new OpenError(result);
	return result;
}

/** The shared model of `path`, read from disk the first time any group shows it. Rejects with an {@link OpenError}. */
export function modelEntry(m: MonacoModule, path: string): Promise<ModelEntry> {
	api = m;
	const existing = entries.get(path);
	if (existing) return Promise.resolve(existing);
	let pending = loading.get(path);
	if (!pending) {
		pending = readText(path)
			.then((file) => {
				const text = file.content;
				// A references peek may already have made a preview model for this file.
				const preview = lsp.adoptPreview(path);
				if (preview && preview.getValue() !== text) preview.setValue(text);
				const model = preview ?? m.monaco.editor.createModel(text, languageOf(m, path, text), m.monaco.Uri.file('/' + path));
				if (preview) setLanguage(m, model, languageOf(m, path, text));
				// files.eol: a file with no line break yet takes the configured one (not counted as an edit).
				if (!/\r?\n/.test(text)) model.setEOL(eolFor(settings.get('files.eol')) === '\n' ? m.monaco.editor.EndOfLineSequence.LF : m.monaco.editor.EndOfLineSequence.CRLF);
				const entry: ModelEntry = { model, savedVersion: model.getAlternativeVersionId(), encoding: file.encoding, stat: file.stat, lossy: file.lossy };
				model.onDidChangeContent(() => {
					if (entry.reloading) return;
					const dirty = model.getAlternativeVersionId() !== entry.savedVersion;
					editors.setDirty(path, dirty);
					if (!dirty) textFileHooks.clean(path);
				});
				// workbench.editor.untitled.labelFormat: an untitled tab may be named after its first line.
				if (isUntitled(path)) {
					const sync = () => {
						untitledFirstLines.set(path, model.getLineContent(1));
						if (model.getValueLength() === 0) emptyUntitled.add(path);
						else emptyUntitled.delete(path);
					};
					sync();
					model.onDidChangeContent(sync);
					model.onWillDispose(() => (untitledFirstLines.delete(path), emptyUntitled.delete(path)));
				}
				entries.set(path, entry);
				// Language servers run on the open folder; a file outside it gets no server (like a single file in VS Code without one).
				if (!isExternalKey(path)) lsp.attach(m.monaco, model, path);
				textFileHooks.created(path, entry);
				return entry;
			})
			.finally(() => loading.delete(path));
		loading.set(path, pending);
	}
	return pending;
}

function setLanguage(m: MonacoModule, model: Monaco.editor.ITextModel, language: string) {
	if (model.getLanguageId() !== language) m.monaco.editor.setModelLanguage(model, language);
}

/**
 * The language of `path`: `files.associations`, then the registered associations, then the first
 * line of `text`. A new untitled editor takes `files.defaultLanguage` (`${activeEditorLanguage}`:
 * the language of the editor that was active).
 */
export function languageOf(m: MonacoModule, path: string, text?: string): string {
	const known = new Set(m.monaco.languages.getLanguages().map((l) => l.id));
	if (isUntitled(path) && !text) {
		const wanted = defaultLanguage(settings.get<string>('files.defaultLanguage'), editors.language);
		if (wanted && known.has(wanted)) return wanted;
	}
	const firstLine = text?.slice(0, 1000).split(/\r?\n/, 1)[0];
	return languageFor(path, { associations: settings.get('files.associations'), firstLine, known: (id) => known.has(id) });
}

/** Every open model with its path, for settings that follow open files (files.associations). */
export function openModels(): [string, Monaco.editor.ITextModel][] {
	return [...entries].filter(([, e]) => !e.model.isDisposed()).map(([p, e]) => [p, e.model]);
}

/** Re-resolves the language of open models whose language was not picked by hand (files.associations changed). */
export function refreshLanguages(m: MonacoModule) {
	for (const [path, entry] of entries) {
		if (entry.model.isDisposed() || entry.explicitLanguage) continue;
		setLanguage(m, entry.model, languageOf(m, path, entry.model.getLineContent(1)));
	}
}

export type SaveOptions = { reason?: SaveReason; overwrite?: boolean; encoding?: string };

/**
 * Runs the save participants (format, trim…), then writes with the file's encoding. Resolves to
 * whether the file was saved: a newer file on disk (unless `overwrite`) or a character the
 * encoding cannot hold leave it dirty and go to the text file service hooks.
 */
export async function saveFile(path: string, reasonOrOptions: SaveReason | SaveOptions = 'explicit'): Promise<boolean> {
	const opts = typeof reasonOrOptions === 'string' ? { reason: reasonOrOptions } : reasonOrOptions;
	const entry = entries.get(path);
	if (!entry) return false;
	// An untitled editor has no file yet: an explicit save asks where (auto save leaves it alone).
	if (isUntitled(path)) return (opts.reason ?? 'explicit') === 'explicit' && (await saveAs(path)) !== null;
	if (entry.inConflict && (opts.reason ?? 'explicit') !== 'explicit' && !opts.overwrite) return false;
	if (api) await runSaveParticipants(api.monaco, entry.model, opts.reason ?? 'explicit');
	if (entry.model.isDisposed()) return false;
	const version = entry.model.getAlternativeVersionId();
	const encoding = opts.encoding ?? entry.encoding;
	// files.saveConflictResolution `overwriteFileOnDisk`: a newer file on disk is overwritten without asking.
	const overwrite = opts.overwrite || settings.get<string>('files.saveConflictResolution') === 'overwriteFileOnDisk';
	entry.saving = (entry.saving ?? 0) + 1;
	const result = await writeTextResource(path, entry.model.getValue(), encoding, overwrite ? undefined : entry.stat).finally(() => entry.saving!--);
	if (result.kind === 'conflict') {
		entry.inConflict = true;
		textFileHooks.conflict(path);
		return false;
	}
	if (result.kind === 'unencodable') {
		textFileHooks.unencodable(path, result.ch);
		return false;
	}
	entry.encoding = encoding;
	entry.stat = result.stat ?? entry.stat;
	entry.lossy = false;
	entry.inConflict = false;
	entry.savedVersion = version;
	const dirty = entry.model.getAlternativeVersionId() !== version;
	editors.setDirty(path, dirty);
	if (!dirty) textFileHooks.clean(path);
	lsp.didSave(entry.model);
	return true;
}

/** Replaces a model's text with what is on disk (undoable) and marks it saved. */
function replaceWithDisk(entry: ModelEntry, file: Extract<TextRead, { kind: 'text' }>) {
	const { model } = entry;
	entry.reloading = true;
	try {
		if (model.getValue() !== file.content) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: file.content }], () => null);
	} finally {
		entry.reloading = false;
	}
	entry.savedVersion = model.getAlternativeVersionId();
	entry.encoding = file.encoding;
	entry.stat = file.stat;
	entry.lossy = file.lossy;
	entry.inConflict = false;
}

/** VS Code's Revert File: the disk contents replace unsaved edits. `encoding` reopens with another encoding. */
export async function revertFile(path: string, encoding?: string): Promise<void> {
	const entry = entries.get(path);
	if (!entry) return;
	if (isUntitled(path)) {
		entry.model.setValue('');
		entry.savedVersion = entry.model.getAlternativeVersionId();
		editors.setDirty(path, false);
		return;
	}
	const file = await readText(path, { encoding: encoding ?? entry.encoding, acceptBinary: true, acceptLarge: true });
	if (entry.model.isDisposed()) return;
	replaceWithDisk(entry, file);
	editors.setDirty(path, false);
	textFileHooks.clean(path);
}

/** The disk contents of an open file, decoded with its encoding (the save conflict compare). */
export async function diskText(path: string): Promise<string> {
	const entry = entries.get(path);
	return (await readText(path, { encoding: entry?.encoding, acceptBinary: true, acceptLarge: true })).content;
}

/** Puts unsaved text from a backup into the model of `path`, leaving it dirty against `stat`. */
export function restoreText(entry: ModelEntry, text: string, meta: { encoding?: string; stat?: FileStat }) {
	const { model } = entry;
	if (meta.encoding) entry.encoding = meta.encoding;
	if (meta.stat) entry.stat = meta.stat;
	if (model.getValue() === text) return;
	model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
}

type SavedAs = { rel: string | null; path: string };

/**
 * Save As (⇧⌘S), and the first save of an untitled editor: the native save dialog (run by Rust),
 * then the editor switches to the new file like VS Code. The old file keeps what is on disk.
 * Returns the new editor key (a workspace path, or `external:` outside the folder), or null when cancelled.
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
		notifications.error(t('workbench.editorModels.saveAsFailed', { error: String(e) }));
		return null;
	}
	if (!saved) return null;
	// Saved outside the folder: the editor goes on with the file there (an external editor, as in VS Code).
	const rel = saved.rel ?? externalKey(saved.path);
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


/**
 * The file watcher saw `paths` change on disk: a clean model takes the new contents (undoable, and
 * every group showing it follows); a dirty one keeps the user's version, and when the disk really
 * changed (an agent editing a task worktree file that is open here) auto save pauses for it and
 * the save conflict flow shows (`diskChangeAction`).
 */
export async function reloadClean(paths: string[]) {
	for (const path of paths) {
		const entry = entries.get(path);
		if (!entry) continue;
		if (entry.model.getAlternativeVersionId() !== entry.savedVersion) {
			await pauseIfChangedOnDisk(path, entry);
			continue;
		}
		let file: Extract<TextRead, { kind: 'text' }>;
		try {
			file = await readText(path, { encoding: entry.encoding, acceptBinary: true, acceptLarge: true });
		} catch (e) {
			// Deleted: workbench.editor.closeOnFileDelete closes its (clean) tabs, else they keep the last contents.
			if (settings.get<boolean>('workbench.editor.closeOnFileDelete') && /not found|No such file|os error 2/i.test(String(e))) editors.closeEverywhere(path);
			continue;
		}
		const { model } = entry;
		if (model.isDisposed() || model.getAlternativeVersionId() !== entry.savedVersion) continue;
		const changed = model.getValue() !== file.content;
		replaceWithDisk(entry, file);
		if (changed) clientLog('info', `reloaded ${path} (changed on disk)`);
	}
}

/** A dirty model whose file changed on disk: conflict mode (auto save stops), prompting when auto save is on. */
async function pauseIfChangedOnDisk(path: string, entry: ModelEntry) {
	if (entry.inConflict || entry.saving || !entry.stat || isUntitled(path)) return;
	let disk: Extract<TextRead, { kind: 'text' }>;
	try {
		disk = await readText(path, { encoding: entry.encoding, acceptBinary: true, acceptLarge: true });
	} catch {
		return; // deleted: saving recreates it, as before
	}
	if (entry.saving || entry.model.isDisposed()) return;
	const action = diskChangeAction({
		dirty: entry.model.getAlternativeVersionId() !== entry.savedVersion,
		inConflict: !!entry.inConflict,
		diskDiffers: !!disk.stat && disk.stat.hash !== entry.stat?.hash,
		autoSave: settings.get<AutoSaveMode>('files.autoSave')
	});
	if (action !== 'conflict' && action !== 'pause') return;
	entry.inConflict = true;
	clientLog('info', `${path} changed on disk while it has unsaved changes; auto save paused`);
	if (action === 'conflict') textFileHooks.conflict(path);
}

/** The most recent view state of each file in any group (`workbench.editor.sharedViewState`). */
const sharedViews = new Map<string, Monaco.editor.ICodeEditorViewState>();
/** View states kept for closed editors (`workbench.editor.restoreViewState`), oldest first. */
const MAX_VIEW_STATES = 500;

export function saveViewState(group: number, path: string, state: Monaco.editor.ICodeEditorViewState | null) {
	const key = viewKey(group, path);
	views.delete(key);
	views.set(key, state);
	if (state) {
		sharedViews.delete(path);
		sharedViews.set(path, state);
	}
	for (const map of [views, sharedViews] as Map<string, unknown>[]) while (map.size > MAX_VIEW_STATES) map.delete(map.keys().next().value!);
}

/** The view state to restore for `path` in `group`: the group's own, else (with `workbench.editor.sharedViewState`) the latest from any group. */
export function viewState(group: number, path: string) {
	const own = views.get(viewKey(group, path));
	if (own) return own;
	return settings.get<boolean>('workbench.editor.sharedViewState') ? (sharedViews.get(path) ?? null) : null;
}

/**
 * Forgets the view states of editors that are no longer open in their group, unless
 * `workbench.editor.restoreViewState` keeps them for when the editor is opened again (VS Code
 * restores scroll and cursor of a reopened editor). Groups that are gone always go.
 */
export function pruneViewStates(openByGroup: ReadonlyMap<number, ReadonlySet<string>>) {
	const keep = settings.get<boolean>('workbench.editor.restoreViewState');
	for (const key of [...views.keys()]) {
		const [group, path] = key.split('\u0000');
		const open = openByGroup.get(Number(group));
		if (!open || (!keep && !open.has(path))) views.delete(key);
	}
	if (!keep) {
		const anywhere = new Set([...openByGroup.values()].flatMap((s) => [...s]));
		for (const path of [...sharedViews.keys()]) if (!anywhere.has(path)) sharedViews.delete(path);
	}
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
	for (const key of [...views.keys()]) if (!live.has(Number(key.split('\u0000')[0]))) views.delete(key);
	// Closed editors' view states are pruneViewStates' (workbench.editor.restoreViewState).
}

export function disposeAll() {
	for (const e of entries.values()) e.model.dispose();
	entries.clear();
	views.clear();
	sharedViews.clear();
}
