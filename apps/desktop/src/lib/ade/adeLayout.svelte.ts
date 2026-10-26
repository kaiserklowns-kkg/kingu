// Agents layout (ADE) state, laid out like Orca: the selected worktree (the folder itself or a
// task's worktree, `appMode.activeSession`), its tabs (the agent session or new-task composer,
// then terminals started in that worktree, then files and task diffs opened from the right side
// bar), and the board instead of a worktree (the right side bar's own state: rightSidebar.svelte.ts). Terminals stay mounted
// while their worktree is not shown. File tabs edit the IDE's shared text models (editorModels.ts),
// so dirty state and Save are per file, whichever layout shows it.

import { textFiles } from '#lib/workbench/textFileService.svelte.ts';
import { nextUntitledKey } from '#lib/workbench/untitled.ts';
import { forgetUntitledMarkdown, isMarkdownEditor, markUntitledMarkdown } from './adeMarkdown.ts';
import { editors, type Reveal } from '#lib/workbench/editors.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { isDiffKey } from '#lib/workbench/scm.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { confirmKill } from '#lib/terminal/confirmKill.ts';
import { cyclePane, equalize, leaf, removePane, setRatio, splitPane, type PanePath, type SplitDirection } from '#lib/terminal/paneLayout.ts';
import { killPty } from '#lib/terminal/pty.ts';
import { focusTerminal } from '#lib/terminal/registry.ts';
import { adeKey, parseAdeTerminals, persist, restore, storeName, withoutRun } from '#lib/terminal/sessions.ts';
import {
	activeAfterClose,
	activePane,
	applyTabOrder,
	adeTabs,
	cycleTab,
	fileTabId,
	keyOfTabId,
	mruOrder,
	openFileTab,
	paneOrder,
	pinFileTab,
	pushClosed,
	switcherStep,
	tabAtIndex,
	tabPanes,
	touchMru,
	type AdeTab,
	type BrowserTab,
	type ClosedTab,
	type FileTab,
	type TerminalTab
} from './adeTabs.ts';
import { switcherOrder } from './sidebarView.ts';
import { browserTitle } from '#lib/workbench/floating.ts';
import { t } from '#lib/i18n/index.ts';

export type CenterPage = 'now' | 'board' | 'automations' | 'issues';
/** Worktree key: '' for the folder itself (Orca's "primary" worktree), else the task slug. */
export const PRIMARY = '';
const STORE = 'kingu.adeTerminals';

class AdeLayout {
	/** The center shows a page from the side bar's top (Tasks = the board, Automations or Issues) instead of a worktree. */
	page = $state<CenterPage | null>(null);
	/** The side bar's search box: filters worktrees by title or branch. */
	query = $state('');
	terminals = $state<Record<string, TerminalTab[]>>({});
	/** Files and task diffs opened in each worktree's tab row. */
	files = $state<Record<string, FileTab[]>>({});
	/** Browser tabs of each worktree (Orca's browser tabs); their pages live in the center. */
	browsers = $state<Record<string, BrowserTab[]>>({});
	/** Active tab per worktree ('main', a terminal id or a file tab id). */
	active = $state<Record<string, string>>({});
	/** The user's dragged tab order per worktree (Orca's tab strip); unlisted tabs follow it. */
	order = $state<Record<string, string[]>>({});
	/** Pinned tabs per worktree: no close button, middle-click ignored, bulk closes skip them. */
	pinned = $state<Record<string, string[]>>({});
	/** A tab's color dot (`#rrggbb`), keyed by worktree and tab id. */
	colors = $state<Record<string, string>>({});
	#seq = $state(0);
	/** Root tag of the folder whose terminal tabs these are; null until loaded. */
	#tag = $state<string | null>(null);

	constructor() {
		$effect.root(() => {
			$effect(() => {
				const state = { terminals: $state.snapshot(this.terminals), active: $state.snapshot(this.active), seq: this.#seq };
				if (this.#tag) persist(storeName(STORE, this.#tag), state);
			});
		});
	}

	/** Terminal tabs of folder `tag` come back (their PTYs outlive reloads, folder switches and
	 *  restarts); file tabs start over. A restored tab never re-runs its command. */
	loadTerminals(tag: string) {
		const saved = restore(storeName(STORE, tag), parseAdeTerminals);
		this.terminals = saved ? Object.fromEntries(Object.entries(saved.terminals).map(([k, list]) => [k, list.map(withoutRun)])) : {};
		this.browsers = {};
		this.order = {};
		this.pinned = {};
		this.colors = {};
		this.active = saved?.active ?? {};
		this.#seq = saved?.seq ?? 0;
		this.mru = {};
		this.closed = {};
		this.switcher = null;
		this.#tag = tag;
	}

	/** Another folder is about to load: unmount its terminals (the shells keep running). */
	unloadTerminals() {
		this.#tag = null;
		this.terminals = {};
		this.browsers = {};
		this.order = {};
		this.pinned = {};
		this.colors = {};
		this.active = {};
	}

	/** PTY key of a worktree terminal tab. */
	ptyKey(key: string, id: string): string {
		return adeKey(this.#tag ?? '', key, id);
	}

	/** PTY keys of every pane of every worktree terminal tab. */
	ptyKeys(): string[] {
		return Object.entries(this.terminals).flatMap(([k, list]) => list.flatMap((t) => tabPanes(t).map((p) => this.ptyKey(k, p))));
	}

	/** Most recently shown tabs per worktree, for Ctrl+Tab (not kept across reloads). */
	mru = $state<Record<string, string[]>>({});
	/** Closed tabs per worktree, for Reopen Closed Tab. */
	closed = $state<Record<string, ClosedTab[]>>({});
	/** Ctrl+Tab's switcher while Ctrl is held: the rows (tab ids) and the selected one. */
	switcher = $state<{ key: string; ids: string[]; index: number } | null>(null);
	/** A new split pane's source pane (PTY key): it starts in that shell's directory. */
	#cwdFrom = new Map<string, string>();

	cwdFrom(key: string, pane: string): string | undefined {
		return this.#cwdFrom.get(this.ptyKey(key, pane));
	}

	terminalTab(key: string, id: string): TerminalTab | undefined {
		return this.terminals[key]?.find((t) => t.id === id);
	}

	#updateTab(key: string, id: string, change: (t: TerminalTab) => TerminalTab) {
		const list = this.terminals[key];
		if (list) this.terminals[key] = list.map((t) => (t.id === id ? change(t) : t));
	}

	/** The shown worktree's active terminal tab, if a terminal tab is active. */
	activeTerminal(): { key: string; tab: TerminalTab } | null {
		if (this.board) return null;
		const key = this.key;
		const tab = this.terminalTab(key, this.activeTab(key));
		return tab ? { key, tab } : null;
	}

	/** Orca's Split Terminal Right / Down: a new pane next to the focused one, in its current directory. */
	split(key: string, id: string, direction: SplitDirection) {
		const tab = this.terminalTab(key, id);
		if (!tab) return;
		const source = activePane(tab);
		const pane = `t${++this.#seq}`;
		this.#cwdFrom.set(this.ptyKey(key, pane), this.ptyKey(key, source));
		this.#updateTab(key, id, (t) => ({ ...t, layout: splitPane(t.layout ?? leaf(t.id), source, pane, direction), pane, expanded: undefined }));
		focusTerminal(this.ptyKey(key, pane));
	}

	/** Shows pane `pane` as the focused one of its tab. */
	focusPaneOf(key: string, id: string, pane: string) {
		const tab = this.terminalTab(key, id);
		if (tab && tab.pane !== pane && tabPanes(tab).includes(pane)) this.#updateTab(key, id, (t) => ({ ...t, pane }));
	}

	/** Orca's Focus Next / Previous Pane: creation order, wrapping; an expanded pane collapses first. */
	focusPane(key: string, id: string, step: 1 | -1) {
		const tab = this.terminalTab(key, id);
		if (!tab || tabPanes(tab).length < 2) return;
		const pane = cyclePane(paneOrder(tab), activePane(tab), step);
		this.#updateTab(key, id, (t) => ({ ...t, pane, expanded: undefined }));
		focusTerminal(this.ptyKey(key, pane));
	}

	equalize(key: string, id: string) {
		const tab = this.terminalTab(key, id);
		if (tab?.layout && !tab.expanded) this.#updateTab(key, id, (t) => ({ ...t, layout: t.layout && equalize(t.layout) }));
	}

	/** Orca's Expand / Collapse Pane: the focused pane takes the whole tab, again restores the split. */
	toggleExpand(key: string, id: string) {
		const tab = this.terminalTab(key, id);
		if (!tab || tabPanes(tab).length < 2) return;
		const pane = activePane(tab);
		this.#updateTab(key, id, (t) => ({ ...t, expanded: t.expanded ? undefined : pane }));
		focusTerminal(this.ptyKey(key, pane));
	}

	resizePane(key: string, id: string, path: PanePath, ratio: number) {
		this.#updateTab(key, id, (t) => (t.layout ? { ...t, layout: setRatio(t.layout, path, ratio) } : t));
	}

	/** Close Pane: the last pane closes the tab; asks first while a command runs in it. */
	async closePane(key: string, id: string, pane?: string) {
		const tab = this.terminalTab(key, id);
		if (!tab) return;
		const target = pane ?? activePane(tab);
		if (tabPanes(tab).length < 2 || !tab.layout) return this.closeTerminal(key, id);
		if (!(await confirmKill([this.ptyKey(key, target)], 'editor', this.#label(key, id)))) return;
		const now = this.terminalTab(key, id);
		const layout = now?.layout && removePane(now.layout, target);
		if (!now || !layout) return;
		killPty(this.ptyKey(key, target));
		this.#updateTab(key, id, (t) => {
			const next: TerminalTab = { ...t, layout, expanded: t.expanded === target ? undefined : t.expanded };
			// Orca: the first pane (creation order) takes focus.
			return { ...next, pane: t.pane === target || !t.pane ? paneOrder(next)[0] : t.pane };
		});
		const after = this.terminalTab(key, id);
		if (after) focusTerminal(this.ptyKey(key, activePane(after)));
	}

	#label(key: string, id: string): string {
		return this.tabs(key).find((t) => t.id === id)?.label ?? 'Terminal';
	}

	/** Rename Tab (Orca: Set Title…): the input starts from the current name; empty restores "Terminal n". */
	async rename(key: string, id: string) {
		const tab = this.terminalTab(key, id);
		if (!tab) return;
		const current = this.#label(key, id);
		const name = await quick.input({ placeholder: t('ade.tabs.renamePlaceholder', { name: current }), hint: (v) => (v.trim() ? t('ade.tabs.renameTo', { name: v.trim() }) : t('ade.tabs.renameKeep', { n: tab.n })) });
		if (name === undefined) return;
		this.#updateTab(key, id, (t) => ({ ...t, title: name.trim() || undefined }));
	}

	/** Reopen Closed Tab (Orca): a terminal comes back as a fresh shell in the worktree with its title and place; a file reopens pinned. */
	reopenClosed(key: string) {
		const stack = this.closed[key] ?? [];
		const last = stack.at(-1);
		if (!last) return;
		this.closed[key] = stack.slice(0, -1);
		if (last.kind === 'file') this.openFile(key, last.key, { preview: false });
		else if (last.kind === 'browser') this.newBrowser(key, last.url);
		else this.newTerminal(key, { title: last.title, index: last.index });
	}

	/** Next / Previous Tab, optionally only among tabs of one kind (`same`: the active tab's kind; 'terminal'). */
	cycle(key: string, step: 1 | -1, only?: 'same' | 'terminal') {
		const tabs = this.tabs(key);
		const active = this.activeTab(key);
		const kind = only === 'same' ? tabs.find((t) => t.id === active)?.kind : only;
		const sameKind = (k: AdeTab['kind']) => (kind === 'file' || kind === 'diff' ? k === 'file' || k === 'diff' : k === kind);
		const ids = tabs.filter((t) => !kind || sameKind(t.kind)).map((t) => t.id);
		this.select(key, cycleTab(ids, active, step), true);
	}

	/** Orca's Select Tab n. */
	selectIndex(key: string, n: number) {
		const id = tabAtIndex(this.tabs(key).map((t) => t.id), n);
		if (id) this.select(key, id, true);
	}

	/** Ctrl+Tab (Shift reverses): opens the switcher on the previous recent tab, or moves its selection. */
	switchRecent(step: 1 | -1) {
		const key = this.key;
		if (!this.switcher) {
			const all = this.tabs(key).map((t) => t.id);
			// kingu.tabs.ctrlTabOrder (Orca's ctrlTabOrderMode): by recent use, or the strip order from the active tab.
			const ids = switcherOrder(settings.get<string>('kingu.tabs.ctrlTabOrder'), mruOrder(this.mru[key] ?? [], all, this.activeTab(key)), all);
			if (ids.length < 2) return;
			this.switcher = { key, ids, index: switcherStep(0, step, ids.length) };
		} else this.switcher = { ...this.switcher, index: switcherStep(this.switcher.index, step, this.switcher.ids.length) };
	}

	/** Releasing Ctrl shows the selected tab. */
	commitSwitcher() {
		const s = this.switcher;
		this.switcher = null;
		if (s && s.key === this.key) this.select(s.key, s.ids[s.index], true);
	}

	/** A page (the board or Automations) covers the worktree; false shows the worktree again. */
	get board(): boolean {
		return this.page !== null;
	}
	set board(on: boolean) {
		this.page = on ? 'board' : null;
	}

	/** Shows a page, or the worktree again when it is already shown. */
	togglePage(page: CenterPage) {
		this.page = this.page === page ? null : page;
	}

	get key(): string {
		return appMode.activeSession ?? PRIMARY;
	}

	tabs(key: string): AdeTab[] {
		return applyTabOrder(adeTabs(key, this.terminals[key] ?? [], this.files[key] ?? [], this.browsers[key] ?? []), this.order[key] ?? []);
	}

	/** Drag reorder: `id` moves before `before` (null: to the end). */
	moveTab(key: string, id: string, before: string | null) {
		const ids = this.tabs(key).map((t) => t.id).filter((x) => x !== id);
		const at = before === null ? ids.length : Math.max(0, ids.indexOf(before));
		const next = [...ids.slice(0, at), id, ...ids.slice(at)];
		if (next.join() !== this.tabs(key).map((t) => t.id).join()) this.order[key] = next;
	}

	isPinned(key: string, id: string): boolean {
		return this.pinned[key]?.includes(id) ?? false;
	}

	/** Orca's Pin Tab: no close button, survives bulk closes. */
	togglePin(key: string, id: string) {
		const list = this.pinned[key] ?? [];
		this.pinned[key] = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
	}

	colorOf(key: string, id: string): string | undefined {
		return this.colors[`${key}\u0000${id}`];
	}

	/** Orca's Tab Color; `undefined` clears it. */
	setColor(key: string, id: string, color: string | undefined) {
		const k = `${key}\u0000${id}`;
		if (!color) delete this.colors[k];
		else this.colors[k] = color;
	}

	browserTab(key: string, id: string): BrowserTab | undefined {
		return this.browsers[key]?.find((b) => b.id === id);
	}

	/** The shown worktree's active browser tab, if a browser tab is active. */
	activeBrowser(): { key: string; tab: BrowserTab } | null {
		if (this.board) return null;
		const key = this.key;
		const tab = this.browserTab(key, this.activeTab(key));
		return tab ? { key, tab } : null;
	}

	/** A new browser tab in `key`, loaded with `url` (`''`: New Tab); `background` opens it without showing it. */
	newBrowser(key: string, url = '', { background = false }: { background?: boolean } = {}): string {
		const id = `b${++this.#seq}`;
		const tab: BrowserTab = { id, url, title: browserTitle(url) };
		this.browsers[key] = [...(this.browsers[key] ?? []), tab];
		if (background) return id;
		this.select(key, id);
		this.board = false;
		return id;
	}

	/** The page's title (Orca names the tab after it). */
	renameBrowser(key: string, id: string, title: string) {
		const list = this.browsers[key];
		if (!list || !title.trim()) return;
		const tab = list.find((b) => b.id === id);
		if (!tab || tab.title === title) return;
		this.browsers[key] = list.map((b) => (b.id === id ? { ...b, title: title.trim() } : b));
	}

	closeBrowser(key: string, id: string) {
		const list = this.browsers[key] ?? [];
		const tab = list.find((b) => b.id === id);
		if (!tab) return;
		const index = list.findIndex((b) => b.id === id);
		this.closed[key] = pushClosed(this.closed[key] ?? [], { kind: 'browser', url: tab.url, title: tab.title, index });
		this.active[key] = activeAfterClose(this.tabs(key).map((t) => t.id), id, this.activeTab(key));
		this.browsers[key] = list.filter((b) => b.id !== id);
	}

	activeTab(key: string): string {
		const id = this.active[key] ?? 'main';
		const file = keyOfTabId(id);
		if (file !== null) return this.files[key]?.some((f) => f.key === file) ? id : 'main';
		return id === 'main' || this.terminals[key]?.some((t) => t.id === id) || this.browsers[key]?.some((b) => b.id === id) ? id : 'main';
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

	/** Where the next editor that shows `path` puts the cursor (a Contents search hit). */
	pendingReveal = $state<(Reveal & { path: string }) | null>(null);

	/** Opens a workspace file or a `taskdiff://` key as a tab of worktree `key` (a preview unless `preview: false`). */
	openFile(key: string, file: string, { preview = true, reveal }: { preview?: boolean; reveal?: Reveal } = {}) {
		this.pendingReveal = reveal ? { ...reveal, path: file } : null;
		// workbench.editor.enablePreview: false opens every editor pinned, here too.
		if (!settings.get('workbench.editor.enablePreview')) preview = false;
		this.files[key] = openFileTab(this.files[key] ?? [], file, preview, (k) => editors.isDirty(k));
		this.active[key] = fileTabId(file);
		this.board = false;
	}

	/** Orca's New Markdown (⇧⌘M): an untitled Markdown buffer in this worktree, saved with Save As. */
	newMarkdown(key: string): string {
		const file = nextUntitledKey([...editors.allTabs().map((t) => t.path), ...this.openFiles()]);
		markUntitledMarkdown(file);
		this.openFile(key, file, { preview: false });
		return file;
	}

	/** Orca's Open Markdown… (⇧⌘O): a Markdown file from the disk, as a tab of this worktree. */
	async openMarkdown(key: string) {
		const { open } = await import('@tauri-apps/plugin-dialog');
		const picked = await open({
			multiple: false,
			filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }],
			defaultPath: workspace.root ?? undefined
		});
		if (!picked || Array.isArray(picked)) return;
		this.openFile(key, workspace.keyFor(picked), { preview: false });
	}

	/** The active tab renders its Markdown instead of editing it (Orca's markdown-preview mode). */
	markdownPreview(key: string): boolean {
		const file = this.activeFile();
		return !!file && isMarkdownEditor(file) && !!this.files[key]?.find((f) => f.key === file)?.mdPreview;
	}

	/** ⇧⌘V: preview ↔ source of the active Markdown tab. */
	toggleMarkdownPreview(key: string) {
		const file = this.activeFile();
		const list = this.files[key];
		if (!file || !list || !isMarkdownEditor(file)) return;
		this.files[key] = list.map((f) => (f.key === file ? { ...f, mdPreview: !f.mdPreview } : f));
	}

	/** Double-click on the tab, or an edit: the tab stays when the next preview opens. */
	pin(key: string, file: string) {
		const list = this.files[key];
		if (list) {
			const next = pinFileTab(list, file);
			if (next !== list) this.files[key] = next;
		}
	}

	/**
	 * Closes a file tab. When it holds the only view of unsaved edits it asks Save / Don't Save /
	 * Cancel through the IDE's text file service (auto save and hot exit backups included), as
	 * VS Code and Orca do. `discard` closes without asking.
	 */
	async closeFile(key: string, file: string, { discard = false }: { discard?: boolean } = {}) {
		const ok = await textFiles.confirmClose([file], (f) => this.#shownElsewhere(key, f), { discard, reveal: (f) => this.select(key, fileTabId(f)) });
		if (!ok.includes(file)) return;
		const list = this.files[key] ?? [];
		if (!list.some((f) => f.key === file)) return;
		const id = fileTabId(file);
		this.active[key] = activeAfterClose(this.tabs(key).map((t) => t.id), id, this.activeTab(key));
		this.files[key] = list.filter((f) => f.key !== file);
		if (!editors.openPaths().has(file)) forgetUntitledMarkdown(file);
		this.closed[key] = pushClosed(this.closed[key] ?? [], { kind: 'file', key: file });
	}

	#shownElsewhere(key: string, file: string): boolean {
		return editors.openPaths().has(file) || Object.entries(this.files).some(([k, list]) => k !== key && list.some((f) => f.key === file));
	}

	/** Closes a terminal or file tab. */
	close(key: string, id: string) {
		const file = keyOfTabId(id);
		if (file !== null) void this.closeFile(key, file);
		else if (this.browserTab(key, id)) this.closeBrowser(key, id);
		else void this.closeTerminal(key, id);
	}

	/** Shows a tab; `focus` also puts the keyboard in it when it is a terminal (a shortcut, not a click). */
	select(key: string, tab: string, focus = false) {
		this.active[key] = tab;
		this.mru[key] = touchMru(this.mru[key] ?? [], tab);
		const t = focus ? this.terminalTab(key, tab) : undefined;
		if (t) focusTerminal(this.ptyKey(key, activePane(t)));
	}

	/** Shows a worktree: the folder itself (`PRIMARY`) or a task. */
	show(key: string) {
		this.board = false;
		if (key === PRIMARY) appMode.activeSession = null;
		else appMode.openSession(key);
	}

	/** A terminal in that worktree; `run` is typed into its shell (an agent CLI, a Snap task). `background`: open it without switching to it. */
	newTerminal(key: string, opts: { title?: string; run?: string[]; background?: boolean; index?: number; color?: string } = {}): string {
		const list = this.terminals[key] ?? [];
		const n = list.reduce((m, t) => Math.max(m, t.n), 0) + 1;
		const tab: TerminalTab = { id: `t${++this.#seq}`, n, title: opts.title, run: opts.run, ...(opts.color ? { color: opts.color } : {}) };
		const at = opts.index === undefined ? list.length : Math.min(Math.max(opts.index, 0), list.length);
		this.terminals[key] = [...list.slice(0, at), tab, ...list.slice(at)];
		if (opts.background) return tab.id;
		this.select(key, tab.id, true);
		this.board = false;
		return tab.id;
	}

	/** Closes a terminal tab and every pane in it; asks first while a command runs in one of them. */
	async closeTerminal(key: string, id: string) {
		const tab = this.terminalTab(key, id);
		if (!tab) return;
		const keys = tabPanes(tab).map((p) => this.ptyKey(key, p));
		if (!(await confirmKill(keys, 'editor', this.#label(key, id)))) return;
		const list = this.terminals[key] ?? [];
		const index = list.findIndex((t) => t.id === id);
		if (index < 0) return;
		keys.forEach(killPty);
		this.closed[key] = pushClosed(this.closed[key] ?? [], { kind: 'terminal', title: tab.title, index });
		// Closing the active tab shows its neighbour (like an editor tab), else the main tab.
		this.active[key] = activeAfterClose(this.tabs(key).map((t) => t.id), id, this.activeTab(key));
		this.terminals[key] = list.filter((t) => t.id !== id);
	}

	/** ⌘W in the Agents layout (Orca): the focused pane of a split terminal, else the active tab. */
	closeActive() {
		if (this.board) return;
		const key = this.key;
		const id = this.activeTab(key);
		const tab = this.terminalTab(key, id);
		if (tab && tabPanes(tab).length > 1) void this.closePane(key, id);
		else if (id !== 'main') this.close(key, id);
	}

	/** A removed task: its terminals and file tabs go away with it. */
	drop(key: string) {
		for (const t of this.terminals[key] ?? []) for (const p of tabPanes(t)) killPty(this.ptyKey(key, p));
		delete this.terminals[key];
		delete this.files[key];
		delete this.browsers[key];
		delete this.active[key];
		delete this.mru[key];
		delete this.closed[key];
	}

	/** A rename in the right side bar's tree: file tabs follow it (`move` returns the new key or null). */
	remapFiles(move: (key: string) => string | null) {
		for (const [k, list] of Object.entries(this.files)) {
			if (!list.some((f) => move(f.key) !== null)) continue;
			this.files[k] = list.map((f) => ({ ...f, key: move(f.key) ?? f.key }));
			const active = keyOfTabId(this.active[k] ?? '');
			const moved = active !== null ? move(active) : null;
			if (moved !== null) this.active[k] = fileTabId(moved);
		}
	}

	/** A delete in the right side bar's tree: its file tabs close without asking (the file is in the Trash). */
	dropFiles(keys: string[]) {
		const gone = new Set(keys);
		for (const [k, list] of Object.entries(this.files)) {
			if (!list.some((f) => gone.has(f.key))) continue;
			const active = keyOfTabId(this.active[k] ?? '');
			if (active !== null && gone.has(active)) this.active[k] = 'main';
			this.files[k] = list.filter((f) => !gone.has(f.key));
		}
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
