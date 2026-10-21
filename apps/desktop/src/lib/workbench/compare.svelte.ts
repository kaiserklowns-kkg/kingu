// Compare commands (VS Code's files.contribution compare actions): Select for Compare and Compare
// with Selected (Explorer and palette), Compare Selected (two Explorer files), Compare Active File
// With…, Compare with Saved (⌘K D) and Compare with Clipboard (⌘K C). Each opens a `compare://`
// tab (compare.ts) that DiffHost reads.

import { invoke } from '@tauri-apps/api/core';
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { editorKind } from './editorKind';
import { isDiffKey } from './scm';
import { isUntitled } from './untitled';
import { compareKey } from './compare';
import { quick } from './quick.svelte';
import { status } from './status.svelte';
import { t } from '#lib/i18n/index.ts';

/** Clipboard snapshots kept for open Compare with Clipboard tabs (a few; the oldest go first). */
const MAX_CLIPS = 20;

class CompareStore {
	/** The resource chosen with Select for Compare. */
	selected = $state<string | null>(null);
	#clips = new Map<string, string>();
	#nextClip = 1;

	clipboardText(id: string): string {
		return this.#clips.get(id) ?? '';
	}

	select(key: string) {
		this.selected = key;
		status.flash(t('workbench.compare.selected', { name: key.split('/').pop() ?? key }), 3000);
	}

	/** Compare with Selected: the selected resource on the left, `key` on the right. */
	withSelected(key: string) {
		if (!this.selected || this.selected === key) return;
		this.open(this.selected, key);
	}

	open(left: string, right: string) {
		editors.open(compareKey({ kind: 'resource', key: left }, right), { preview: false });
	}

	withSaved(key: string) {
		editors.open(compareKey({ kind: 'saved', key }, key), { preview: false });
	}

	async withClipboard(key: string) {
		let text: string;
		try {
			text = await navigator.clipboard.readText();
		} catch {
			text = '';
		}
		const id = String(this.#nextClip++);
		this.#clips.set(id, text);
		for (const old of this.#clips.keys()) if (this.#clips.size > MAX_CLIPS) this.#clips.delete(old);
		editors.open(compareKey({ kind: 'clipboard', id }, key), { preview: false });
	}

	/** Compare Active File With…: a workspace file, then the active file on the right. */
	async pickAndCompare(key: string) {
		const files = await invoke<string[]>('fs_list_files').catch(() => [] as string[]);
		const items = files.filter((f) => f !== key).map((f) => ({ id: f, label: f.split('/').pop() ?? f, description: f }));
		const pick = await quick.choose({ placeholder: t('workbench.compare.pickPlaceholder'), items });
		if (pick) this.open(pick.id, key);
	}
}

export const compareStore = new CompareStore();

/** The active editor's file, when it is a text file (not a diff, not a preview). */
const activeFile = () => {
	const key = editors.focusedFile;
	return key && editorKind(key) === 'file' && !isDiffKey(key) ? key : null;
};

export function registerCompareCommands(): () => void {
	const all = [
		commands.register({ id: 'selectForCompare', title: 'Select for Compare', category: 'File', when: () => activeFile() !== null, run: () => compareStore.select(activeFile()!) }),
		commands.register({
			id: 'compareFiles',
			title: 'Compare with Selected',
			category: 'File',
			when: () => activeFile() !== null && compareStore.selected !== null && compareStore.selected !== activeFile(),
			run: () => compareStore.withSelected(activeFile()!)
		}),
		commands.register({
			id: 'workbench.files.action.compareFileWith',
			title: 'Compare Active File With...',
			category: 'File',
			when: () => activeFile() !== null,
			run: () => compareStore.pickAndCompare(activeFile()!)
		}),
		commands.register({
			id: 'workbench.files.action.compareWithSaved',
			title: 'Compare Active File with Saved',
			category: 'File',
			key: 'cmd+k d',
			when: () => activeFile() !== null && !isUntitled(activeFile()!),
			run: () => compareStore.withSaved(activeFile()!)
		}),
		commands.register({
			id: 'workbench.files.action.compareWithClipboard',
			title: 'Compare Active File with Clipboard',
			category: 'File',
			key: 'cmd+k c',
			when: () => activeFile() !== null,
			run: () => compareStore.withClipboard(activeFile()!)
		})
	];
	return () => all.forEach((u) => u());
}
