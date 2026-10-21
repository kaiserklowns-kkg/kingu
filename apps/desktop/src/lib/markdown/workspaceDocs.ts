// The workspace's Markdown documents for the language features: the file list and parsed
// documents, from the open editor's model when there is one (unsaved text counts), else from disk.
// Short-lived caches: language features ask often, and nothing reports file changes here.

import { invoke } from '@tauri-apps/api/core';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { FileIndex, isMarkdownFile } from './links.ts';
import { parseMarkdown, type MdDocument } from './parse.ts';

const TTL_MS = 5000;
/** Workspace-wide features read at most this many Markdown files. */
const MAX_DOCS = 2000;
const READ_BATCH = 32;

let index: { at: number; value: Promise<FileIndex> } | null = null;
const disk = new Map<string, { at: number; value: Promise<MdDocument | null> }>();
const parsed = new WeakMap<object, { version: number; doc: MdDocument }>();

/** Files of the first root folder (others have absolute keys and are left out). */
export function fileIndex(): Promise<FileIndex> {
	if (!index || Date.now() - index.at > TTL_MS)
		index = {
			at: Date.now(),
			value: invoke<string[]>('fs_list_files')
				.then((files) => new FileIndex(files.filter((f) => !f.startsWith('/'))))
				.catch(() => new FileIndex([]))
		};
	return index.value;
}

/** Forgets cached files and documents (after a move, a save, a link update). */
export function invalidate() {
	index = null;
	disk.clear();
}

/** A model's text parsed, cached per model version. */
export function modelDocument(model: { getVersionId(): number; getValue(): string }): MdDocument {
	const hit = parsed.get(model);
	if (hit && hit.version === model.getVersionId()) return hit.doc;
	const doc = parseMarkdown(model.getValue());
	parsed.set(model, { version: model.getVersionId(), doc });
	return doc;
}

export function documentOf(rel: string): Promise<MdDocument | null> {
	const model = editors.textModel(rel);
	if (model && !model.isDisposed()) return Promise.resolve(modelDocument(model));
	const hit = disk.get(rel);
	if (hit && Date.now() - hit.at <= TTL_MS) return hit.value;
	const value = invoke<string>('read_workspace_file', { rel })
		.then(parseMarkdown)
		.catch(() => null);
	disk.set(rel, { at: Date.now(), value });
	return value;
}

/** Every Markdown document of the workspace (up to MAX_DOCS), by path. */
export async function allDocuments(): Promise<Map<string, MdDocument>> {
	const files = [...(await fileIndex()).files].filter(isMarkdownFile).slice(0, MAX_DOCS);
	const out = new Map<string, MdDocument>();
	// A few reads at a time rather than thousands of IPC calls at once.
	for (let i = 0; i < files.length; i += READ_BATCH) {
		const batch = files.slice(i, i + READ_BATCH);
		const docs = await Promise.all(batch.map(documentOf));
		batch.forEach((rel, j) => docs[j] && out.set(rel, docs[j]));
	}
	return out;
}
