// Single editor group (VS Code: EditorGroupModel). At most one preview tab, shown in italics;
// opening another file unpinned replaces it. Editing or double-clicking pins.
// A tab's `path` is a workspace file, or `diff:<file>` for a HEAD ↔ working tree diff (scm.ts).

import { diffKey } from './scm';
import { settings } from '#lib/settings/settings.svelte.ts';

export type EditorTab = { path: string; preview: boolean; dirty: boolean };
export type Cursor = { line: number; column: number };
/** Where to put the cursor once a file is shown (Search results, go to definition). */
export type Reveal = { line: number; column: number; endColumn?: number; focus?: boolean };

class Editors {
	tabs = $state<EditorTab[]>([]);
	active = $state<string | null>(null);
	cursor = $state<Cursor>({ line: 1, column: 1 });
	language = $state('');
	indent = $state('');
	eol = $state('');
	/** Set by the editor host once Monaco is up. */
	gotoLine: (line: number, column?: number) => void = () => {};
	/** Set by the editor host: the active editor's selected text, '' when none. */
	selectionText: () => string = () => '';
	/** Consumed by the editor host once `path`'s model is shown. */
	pendingReveal = $state<(Reveal & { path: string }) | null>(null);

	/** Opens `path` with the cursor at `line`:`column` (Problems, Go to Definition). */
	openAt(path: string, line: number, column = 1, opts: { preview?: boolean } = {}) {
		this.open(path, { ...opts, reveal: { line, column, focus: true } });
	}

	open(path: string, { preview = true, reveal }: { preview?: boolean; reveal?: Reveal } = {}) {
		// workbench.editor.enablePreview: false opens every editor pinned.
		if (!settings.get('workbench.editor.enablePreview')) preview = false;
		if (reveal) this.pendingReveal = { ...reveal, path };
		const existing = this.tabs.find((t) => t.path === path);
		if (existing) {
			if (!preview) existing.preview = false;
		} else {
			const tab = { path, preview, dirty: false };
			const previewIdx = preview ? this.tabs.findIndex((t) => t.preview && !t.dirty) : -1;
			if (previewIdx >= 0) this.tabs[previewIdx] = tab;
			else {
				const at = this.active ? this.tabs.findIndex((t) => t.path === this.active) + 1 : this.tabs.length;
				this.tabs.splice(at, 0, tab);
			}
		}
		this.active = path;
	}

	/** Opens the Source Control diff of `rel` (HEAD vs working tree) as its own tab. */
	openDiff(rel: string, options: { preview?: boolean } = {}) {
		this.open(diffKey(rel), options);
	}

	pin(path: string) {
		const tab = this.tabs.find((t) => t.path === path);
		if (tab) tab.preview = false;
	}

	setDirty(path: string, dirty: boolean) {
		const tab = this.tabs.find((t) => t.path === path);
		if (!tab || tab.dirty === dirty) return;
		tab.dirty = dirty;
		if (dirty) tab.preview = false;
	}

	/** Returns false when the tab is dirty (the caller asks before discarding). */
	close(path: string, { force = false } = {}): boolean {
		const i = this.tabs.findIndex((t) => t.path === path);
		if (i < 0) return true;
		if (this.tabs[i].dirty && !force) return false;
		this.tabs.splice(i, 1);
		if (this.active === path) this.active = this.tabs[Math.min(i, this.tabs.length - 1)]?.path ?? null;
		return true;
	}
}

export const editors = new Editors();
