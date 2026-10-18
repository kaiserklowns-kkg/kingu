// Agents layout (ADE) state, laid out like Orca: the selected worktree (the folder itself or a
// task's worktree, `appMode.activeSession`), its tabs (the agent session or new-task composer,
// then terminals started in that worktree, then files and task diffs opened from the right side
// bar), the board instead of a worktree, and the right side bar's tab. Terminals stay mounted
// while their worktree is not shown. File tabs edit the IDE's shared text models (editorModels.ts),
// so dirty state and Save are per file, whichever layout shows it.

import { ask } from '@tauri-apps/plugin-dialog';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { isDiffKey } from '#lib/workbench/scm.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { killPty } from '#lib/terminal/pty.ts';
import { adeKey, parseAdeTerminals, persist, restore } from '#lib/terminal/sessions.ts';
import { activeAfterClose, adeTabs, fileTabId, keyOfTabId, openFileTab, pinFileTab, type AdeTab, type FileTab, type TerminalTab } from './adeTabs.ts';

export type RightTab = 'files' | 'changes';
/** Worktree key: '' for the folder itself (Orca's "primary" worktree), else the task slug. */
export const PRIMARY = '';
const STORE = 'kingu.adeTerminals';

class AdeLayout {
	/** The center shows the task board (Tasks in the side bar) instead of a worktree. */
	board = $state(false);
	rightTab = $state<RightTab>('changes');
	/** The side bar's search box: filters worktrees by title or branch. */
	query = $state('');
	terminals = $state<Record<string, TerminalTab[]>>({});
	/** Files and task diffs opened in each worktree's tab row. */
	files = $state<Record<string, FileTab[]>>({});
	/** Active tab per worktree ('main', a terminal id or a file tab id). */
	active = $state<Record<string, string>>({});
	#seq = $state(0);

	constructor() {
		// Terminal tabs survive a webview reload (their PTYs do too); file tabs start over.
		const saved = restore(STORE, parseAdeTerminals);
		if (saved) {
			this.terminals = saved.terminals;
			this.active = saved.active;
			this.#seq = saved.seq;
		}
		$effect.root(() => {
			$effect(() => persist(STORE, { terminals: $state.snapshot(this.terminals), active: $state.snapshot(this.active), seq: this.#seq }));
		});
	}

	/** PTY keys of every worktree terminal tab. */
	ptyKeys(): string[] {
		return Object.entries(this.terminals).flatMap(([k, list]) => list.map((t) => adeKey(k, t.id)));
	}

	get key(): string {
		return appMode.activeSession ?? PRIMARY;
	}

	tabs(key: string): AdeTab[] {
		return adeTabs(key, this.terminals[key] ?? [], this.files[key] ?? []);
	}

	activeTab(key: string): string {
		const id = this.active[key] ?? 'main';
		const file = keyOfTabId(id);
		if (file !== null) return this.files[key]?.some((f) => f.key === file) ? id : 'main';
		return id === 'main' || this.terminals[key]?.some((t) => t.id === id) ? id : 'main';
	}

	/** The file or task diff key of the shown worktree's active tab, while the Agents layout shows one. */
	activeFile(): string | null {
		if (this.board) return null;
		return keyOfTabId(this.activeTab(this.key));
	}

	/** Every file (not diff) open in any worktree's tabs: their text models must stay alive. */
	openFiles(): string[] {
		return Object.values(this.files).flatMap((list) => list.filter((f) => !isDiffKey(f.key)).map((f) => f.key));
	}

	/** Opens a workspace file or a `taskdiff://` key as a tab of worktree `key` (a preview unless `preview: false`). */
	openFile(key: string, file: string, { preview = true }: { preview?: boolean } = {}) {
		// workbench.editor.enablePreview: false opens every editor pinned, here too.
		if (!settings.get('workbench.editor.enablePreview')) preview = false;
		this.files[key] = openFileTab(this.files[key] ?? [], file, preview, (k) => editors.isDirty(k));
		this.active[key] = fileTabId(file);
		this.board = false;
	}

	/** Double-click on the tab, or an edit: the tab stays when the next preview opens. */
	pin(key: string, file: string) {
		const list = this.files[key];
		if (list) {
			const next = pinFileTab(list, file);
			if (next !== list) this.files[key] = next;
		}
	}

	/** Closes a file tab; asks first when it holds the only view of unsaved edits (they go with the model). */
	async closeFile(key: string, file: string) {
		if (editors.isDirty(file) && !this.#shownElsewhere(key, file)) {
			const name = file.slice(file.lastIndexOf('/') + 1);
			const ok = await ask(`${name} มีการแก้ไขที่ยังไม่บันทึก\n\nปิดแล้วทิ้งการแก้ไข?`, { title: 'ยังไม่ได้บันทึก', kind: 'warning', okLabel: 'ทิ้งการแก้ไข', cancelLabel: 'ยกเลิก' });
			if (!ok) return;
		}
		const list = this.files[key] ?? [];
		if (!list.some((f) => f.key === file)) return;
		const id = fileTabId(file);
		this.active[key] = activeAfterClose(this.tabs(key).map((t) => t.id), id, this.activeTab(key));
		this.files[key] = list.filter((f) => f.key !== file);
	}

	#shownElsewhere(key: string, file: string): boolean {
		return editors.openPaths().has(file) || Object.entries(this.files).some(([k, list]) => k !== key && list.some((f) => f.key === file));
	}

	/** Closes a terminal or file tab. */
	close(key: string, id: string) {
		const file = keyOfTabId(id);
		if (file !== null) void this.closeFile(key, file);
		else this.closeTerminal(key, id);
	}

	select(key: string, tab: string) {
		this.active[key] = tab;
	}

	/** Shows a worktree: the folder itself (`PRIMARY`) or a task. */
	show(key: string) {
		this.board = false;
		if (key === PRIMARY) appMode.activeSession = null;
		else appMode.openSession(key);
	}

	/** A terminal in that worktree; `run` is typed into its shell (an agent CLI, a Snap task). */
	newTerminal(key: string, opts: { title?: string; run?: string[] } = {}): string {
		const list = this.terminals[key] ?? [];
		const n = list.reduce((m, t) => Math.max(m, t.n), 0) + 1;
		const tab: TerminalTab = { id: `t${++this.#seq}`, n, title: opts.title, run: opts.run };
		this.terminals[key] = [...list, tab];
		this.active[key] = tab.id;
		this.board = false;
		return tab.id;
	}

	closeTerminal(key: string, id: string) {
		const list = this.terminals[key] ?? [];
		if (!list.some((t) => t.id === id)) return;
		killPty(adeKey(key, id));
		// Closing the active tab shows its neighbour (like an editor tab), else the main tab.
		this.active[key] = activeAfterClose(this.tabs(key).map((t) => t.id), id, this.activeTab(key));
		this.terminals[key] = list.filter((t) => t.id !== id);
	}

	/** A removed task: its terminals and file tabs go away with it. */
	drop(key: string) {
		for (const t of this.terminals[key] ?? []) killPty(adeKey(key, t.id));
		delete this.terminals[key];
		delete this.files[key];
		delete this.active[key];
	}

	/** Another folder: file tabs of the old one close (the IDE closes its editors too). */
	closeAllFiles() {
		this.files = {};
	}
}

export const adeLayout = new AdeLayout();

// Save, Save All and auto save act on the ADE's file tab while the Agents layout is in front.
editors.adeFile = () => {
	if (!appMode.isAgents) return null;
	const file = adeLayout.activeFile();
	return file && !isDiffKey(file) ? file : null;
};
