// A preview's text: the open editor's model (live, unsaved edits included) or else the file.
import { invoke } from '@tauri-apps/api/core';
import { editors } from './editors.svelte';

/** Calls `onText` now and on every edit; returns the cleanup for an `$effect`. */
export function watchSource(rel: string, onText: (text: string) => void, onError: (message: string) => void): () => void {
	const model = editors.textModel(rel);
	if (model) {
		onText(model.getValue());
		const sub = model.onDidChangeContent(() => onText(model.getValue()));
		return () => sub.dispose();
	}
	let live = true;
	invoke<string>('read_workspace_file', { rel })
		.then((text) => live && onText(text))
		.catch((e) => live && onError(String(e)));
	return () => (live = false);
}
