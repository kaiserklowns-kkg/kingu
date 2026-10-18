// Editor groups, reactive (VS Code: IEditorGroupsService). The model lives in editorGroups.ts;
// this wraps it in `$state` and keeps the single-group API the rest of the workbench uses:
// `editors.active`, `editors.tabs`, `open`, `close`… all mean "in the active group".
// Text models are shared between groups (editorModels.ts), one Monaco editor per group.

import type * as Monaco from 'monaco-editor';
import { SvelteSet } from 'svelte/reactivity';
import { diffKey } from './scm';
import * as G from './editorGroups';
import { settings } from '#lib/settings/settings.svelte.ts';
import { appMode } from './mode.svelte';

export type { EditorTab, EditorGroup, GridNode, SplitDirection } from './editorGroups';
export type Cursor = { line: number; column: number };
/** Where to put the cursor once a file is shown (Search results, go to definition). */
export type Reveal = { line: number; column: number; endColumn?: number; focus?: boolean };

/** What a group's editor host exposes to commands that act on "the active editor". */
export type EditorHostHandle = {
	gotoLine: (line: number, column?: number) => void;
	selectionText: () => string;
	focus: () => void;
	/** Runs a Monaco editor action (`actions.find`, `undo`…) on the shown file; false when none is shown. */
	trigger: (actionId: string) => boolean;
};

class Editors {
	model = $state<G.GroupsModel>(G.createGroupsModel());
	cursor = $state<Cursor>({ line: 1, column: 1 });
	language = $state('');
	indent = $state('');
	eol = $state('');
	/** Consumed by the editor host of `group` once `path`'s model is shown there. */
	pendingReveal = $state<(Reveal & { path: string; group: number }) | null>(null);
	/** A group whose editor should take keyboard focus once it shows a model. */
	focusRequest = $state<number | null>(null);
	#hosts = new Map<number, EditorHostHandle>();
	/** Set by editorModels.ts: the shared text model of `path` when it is open in any group, else
	 * null. Edits from rename, code actions and Search: Replace go into it (undoable, left dirty)
	 * instead of to disk, so unsaved changes are never clobbered. */
	textModel: (path: string) => Monaco.editor.ITextModel | null = () => null;
	/** Files whose shared model has unsaved edits, wherever they are shown (an IDE group or an ADE tab). */
	#dirty = new SvelteSet<string>();
	/** Set by the Agents layout: the file of its active tab while it is in front, else null. */
	adeFile: () => string | null = () => null;

	get groups() {
		return this.model.groups;
	}
	get activeGroupId() {
		return this.model.activeGroup;
	}
	get activeGroup() {
		return G.activeGroupOf(this.model);
	}
	/** Tabs of the active group. */
	get tabs() {
		return this.activeGroup.tabs;
	}
	/** The active editor of the active group. */
	get active(): string | null {
		return this.activeGroup.active;
	}
	set active(path: string | null) {
		if (path) G.setActiveEditor(this.model, this.model.activeGroup, path);
	}

	group(id: number) {
		return G.getGroup(this.model, id);
	}
	/** Group ids in grid order (left→right, top→bottom). */
	order() {
		return G.groupOrder(this.model);
	}
	openPaths() {
		return G.openPaths(this.model);
	}
	/** The file that Save and auto save act on: the Agents layout's file tab when it is in front, else the active editor. */
	get focusedFile(): string | null {
		return this.adeFile() ?? this.active;
	}
	isDirty(path: string) {
		return this.#dirty.has(path);
	}
	/** Dirty files, including ones open only in the Agents layout. */
	dirtyPaths(): string[] {
		return [...this.#dirty];
	}
	hasDirty() {
		return this.#dirty.size > 0;
	}
	/** Distinct dirty files across groups and the Agents layout. */
	dirtyCount() {
		return this.#dirty.size;
	}

	activateGroup(id: number) {
		if (this.model.activeGroup !== id) G.activateGroup(this.model, id);
	}

	/** Called by each group's editor host while it is mounted. */
	registerHost(id: number, handle: EditorHostHandle): () => void {
		this.#hosts.set(id, handle);
		return () => {
			if (this.#hosts.get(id) === handle) this.#hosts.delete(id);
		};
	}

	/** The editor of the Agents layout's active file tab, while it is mounted. */
	#ade: EditorHostHandle | null = null;
	registerAdeEditor(handle: EditorHostHandle): () => void {
		this.#ade = handle;
		return () => {
			if (this.#ade === handle) this.#ade = null;
		};
	}
	/** Go to Line, menu actions and the selection act on what is in front: the ADE's editor in Agents. */
	#target(): EditorHostHandle | undefined {
		return (appMode.isAgents && this.#ade) || this.#hosts.get(this.model.activeGroup);
	}

	gotoLine(line: number, column = 1) {
		this.#target()?.gotoLine(line, column);
	}
	/** Runs a Monaco action in the active group's editor (menu items such as Find, Go to Definition). */
	trigger(actionId: string): boolean {
		return this.#target()?.trigger(actionId) ?? false;
	}
	/** The active editor's selected text, '' when none. */
	selectionText(): string {
		return this.#target()?.selectionText() ?? '';
	}
	focusGroup(id: number) {
		this.activateGroup(id);
		const host = this.#hosts.get(id);
		if (host && this.group(id)?.active) host.focus();
		else this.focusRequest = id;
	}

	/** Opens `path` with the cursor at `line`:`column` (Problems, Go to Definition). */
	openAt(path: string, line: number, column = 1, opts: { preview?: boolean } = {}) {
		this.open(path, { ...opts, reveal: { line, column, focus: true } });
	}

	open(path: string, { preview = true, reveal, group }: { preview?: boolean; reveal?: Reveal; group?: number } = {}) {
		// workbench.editor.enablePreview: false opens every editor pinned.
		if (!settings.get('workbench.editor.enablePreview')) preview = false;
		G.openEditor(this.model, path, { preview, group });
		// The file may be dirty in the Agents layout only.
		if (this.#dirty.has(path)) G.setDirty(this.model, path, true);
		if (reveal) this.pendingReveal = { ...reveal, path, group: this.model.activeGroup };
	}

	/** Opens the Source Control diff of `rel` (HEAD vs working tree) as its own tab. */
	openDiff(rel: string, options: { preview?: boolean } = {}) {
		this.open(diffKey(rel), options);
	}

	pin(path: string, group = this.model.activeGroup) {
		G.pinEditor(this.model, group, path);
	}

	setDirty(path: string, dirty: boolean) {
		if (dirty) this.#dirty.add(path);
		else this.#dirty.delete(path);
		G.setDirty(this.model, path, dirty);
	}

	/** Returns false when the tab is dirty (the caller asks before discarding). */
	close(path: string, { force = false, group = this.model.activeGroup }: { force?: boolean; group?: number } = {}): boolean {
		return G.closeEditor(this.model, group, path, { force });
	}

	/** Closes `path` in every group (e.g. a diff that failed to load). */
	closeEverywhere(path: string) {
		for (const g of [...this.model.groups]) G.closeEditor(this.model, g.id, path, { force: true });
	}

	/** Returns the dirty paths it left open. */
	closeAllInGroup(group = this.model.activeGroup): string[] {
		return G.closeAllInGroup(this.model, group);
	}

	/** Every tab of every group (a file's tab appears once per group showing it). */
	allTabs(): G.EditorTab[] {
		return this.model.groups.flatMap((g) => g.tabs);
	}

	/** A file or folder was renamed: its tabs follow it in every group. */
	remap(remap: (path: string) => string | null) {
		G.remapEditors(this.model, remap);
	}

	/** Closes everything, discarding unsaved changes (the caller already asked). */
	closeAll() {
		G.closeAllGroups(this.model);
	}

	removeGroup(group = this.model.activeGroup) {
		G.removeGroup(this.model, group);
	}

	split(direction: G.SplitDirection) {
		const id = G.splitEditor(this.model, direction);
		if (id !== null) this.focusRequest = id;
		return id;
	}

	focusGroupAt(index: number) {
		const id = G.focusGroupAt(this.model, index);
		if (id !== null) this.focusGroup(id);
	}

	moveEditor(from: number, path: string, to: number, index?: number) {
		G.moveEditor(this.model, from, path, to, index);
		this.focusRequest = to;
	}

	moveActiveEditorToNextGroup() {
		if (G.moveActiveEditorToNextGroup(this.model)) this.focusRequest = this.model.activeGroup;
	}

	resize(splitId: number, index: number, delta: number) {
		G.resizeSplit(this.model, splitId, index, delta);
	}

	evenSplit(splitId: number) {
		G.evenSplit(this.model, splitId);
	}
}

export const editors = new Editors();
