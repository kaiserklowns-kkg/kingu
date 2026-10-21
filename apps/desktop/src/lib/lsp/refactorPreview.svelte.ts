// The Refactor Preview panel's state (VS Code's BulkEditPane): one WorkspaceEdit waiting for Apply
// or Discard, its checked edits, and the documents' text before it (for the edit lines and the
// diff tabs, `refactorpreview:<rel>`). The pure parts are in refactorPreview.ts.
//
// Rename with ⇧Enter (or ⌘Enter, Monaco's key) in the rename input asks for a preview first
// (`editor.rename.enablePreview`): the key is caught before Monaco, noted, and the rename accepted.

import { SvelteMap } from 'svelte/reactivity';
import type { WorkspaceEdit } from './protocol';
import { filterWorkspaceEdit, initialChecked, isRefactorPreviewKey, previewText, previewTree, refactorPreviewKey, toggleEdits, type PreviewCategory, type PreviewEdit } from './refactorPreview.ts';
import { activeCodeEditor } from '#lib/editor/activeEditor.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout, type PanelTab } from '#lib/workbench/layout.svelte.ts';

/** How the preview reaches the documents: their text now, and their editor key (null: outside the workspace). */
export type PreviewSource = { read(uri: string): Promise<string>; keyOf(uri: string): string | null };

type Pending = { edit: WorkspaceEdit; label: string; source: PreviewSource; resolve: (edit: WorkspaceEdit | null) => void; restore: { tab: PanelTab; visible: boolean } };

class RefactorPreview {
	pending = $state.raw<Pending | null>(null);
	checked = $state.raw<Set<string>>(new Set());
	/** The documents' text before the edit, per URI (loaded when the preview opens). */
	originals = new SvelteMap<string, string>();
	tree = $derived<PreviewCategory[]>(this.pending ? previewTree(this.pending.edit) : []);

	/** Shows `edit` in the panel; resolves with the checked part on Apply, null on Discard (or when
	 * another preview replaces this one). */
	request(edit: WorkspaceEdit, label: string, source: PreviewSource): Promise<WorkspaceEdit | null> {
		const restore = this.pending?.restore ?? { tab: layout.panelTab, visible: layout.panelVisible };
		this.#finish(null, false);
		return new Promise((resolve) => {
			this.pending = { edit, label, source, resolve, restore };
			this.checked = initialChecked(edit);
			this.originals.clear();
			const uris = new Set(previewTree(edit).flatMap((c) => c.files.map((f) => f.uri)));
			for (const uri of uris)
				void source
					.read(uri)
					.catch(() => '')
					.then((text) => this.pending?.edit === edit && this.originals.set(uri, text));
			layout.showPanel('refactorPreview');
		});
	}

	isChecked = (id: string) => this.checked.has(id);

	/** Toggles one edit, or every edit of a file or category. */
	toggle(edits: PreviewEdit[]) {
		this.checked = toggleEdits(edits, this.checked);
	}

	apply() {
		if (this.pending) this.#finish(filterWorkspaceEdit(this.pending.edit, this.checked));
	}

	discard() {
		this.#finish(null);
	}

	/** The editor key of a URI, when it is in the workspace. */
	keyOf(uri: string): string | null {
		return this.pending?.source.keyOf(uri) ?? null;
	}

	/** Opens the diff of a file: as it is ↔ with the checked edits. */
	openDiff(uri: string) {
		const rel = this.keyOf(uri);
		if (rel !== null) editors.open(refactorPreviewKey(rel), { preview: true });
	}

	/** The two sides of a `refactorpreview:<rel>` tab (DiffHost). */
	sides(rel: string): [string, string] {
		const p = this.pending;
		const uri = p && [...this.originals.keys()].find((u) => p.source.keyOf(u) === rel);
		if (!p || !uri) return ['', ''];
		const original = this.originals.get(uri) ?? '';
		return [original, previewText(p.edit, uri, original, this.checked)];
	}

	#finish(result: WorkspaceEdit | null, restorePanel = true) {
		const p = this.pending;
		if (!p) return;
		this.pending = null;
		this.checked = new Set();
		this.originals.clear();
		for (const key of [...editors.openPaths()]) if (isRefactorPreviewKey(key)) editors.closeEverywhere(key);
		if (restorePanel && layout.panelTab === 'refactorPreview') {
			layout.panelTab = p.restore.tab;
			layout.panelVisible = p.restore.visible;
		}
		p.resolve(result);
	}
}

export const refactorPreview = new RefactorPreview();

/** Apply / Discard in the palette (VS Code's refactorPreview.apply / refactorPreview.discard). */
export function installRefactorPreviewCommands(): () => void {
	const when = () => refactorPreview.pending !== null;
	const unregister = [
		commands.register({ id: 'refactorPreview.apply', title: 'Apply Refactoring', category: 'Refactor Preview', scope: 'ide', when, run: () => refactorPreview.apply() }),
		commands.register({ id: 'refactorPreview.discard', title: 'Discard Refactoring', category: 'Refactor Preview', scope: 'ide', when, run: () => refactorPreview.discard() })
	];
	return () => unregister.forEach((u) => u());
}

let renamePreview = false;

/** Whether the rename just accepted asked for a preview (one-shot). */
export function takeRenamePreview(): boolean {
	const v = renamePreview;
	renamePreview = false;
	return v;
}

if (typeof window !== 'undefined')
	window.addEventListener(
		'keydown',
		(e) => {
			if (e.key !== 'Enter' || e.isComposing || !(e.shiftKey || e.metaKey || e.ctrlKey) || e.altKey) return;
			if (!(e.target instanceof Element) || !e.target.closest('.rename-box')) return;
			if (settings.get<boolean>('editor.rename.enablePreview') === false) return;
			const editor = activeCodeEditor();
			if (!editor) return;
			e.preventDefault();
			e.stopPropagation();
			renamePreview = true;
			editor.trigger('keyboard', 'acceptRenameInput', null);
			// A rename that never reaches the provider (rejected input) must not leave the flag set.
			setTimeout(() => (renamePreview = false), 2000);
		},
		true
	);
