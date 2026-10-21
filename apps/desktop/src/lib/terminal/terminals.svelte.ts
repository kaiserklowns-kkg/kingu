// Terminals of the IDE panel (VS Code's terminal list): the first is a plain shell; New Terminal
// and tasks (`open({ run })`, e.g. a Snap task) add more. Each stays mounted while hidden so its
// shell keeps running. The list belongs to the open folder (`load(tag)`), is kept in localStorage
// per folder, and comes back after a reload, a folder switch or an app restart: each terminal
// re-attaches to its PTY under `panelKey(tag, id)`. Split Terminal (⌘\) puts terminals side by
// side in a group, like VS Code's terminal groups; the panel shows the active terminal's group.

import { untrack } from 'svelte';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { confirmKill } from './confirmKill.ts';
import { cyclePane, equalize, hasLeaf, leaf, leaves, removePane, setRatio, splitPane, type PaneNode, type PanePath, type SplitDirection } from './paneLayout.ts';
import { killPty } from './pty.ts';
import { focusTerminal, type TaskSpawn } from './registry.ts';
import { hideOnStartup, panelKey, parsePanelTerminals, persist, restore, storeName, withoutRun } from './sessions.ts';
import { t as tr } from '#lib/i18n/index.ts';

/** `cwdFrom`: a split starts in that terminal's current directory (not kept across reloads).
 * `task`: a task terminal's launch (tasks.svelte.ts), dropped once the task ended and never kept.
 * `folder`: the root folder it starts in (absolute; a multi-root window asks, see newTerminal.ts),
 * absent for the first folder; kept, so a restored or split terminal stays in its folder. */
export type PanelTerminal = {
	id: number;
	title: string;
	run?: string[];
	cwdFrom?: string;
	task?: TaskSpawn;
	folder?: string;
	/** The terminal profile it started with (New Terminal With Profile); absent: the default profile. */
	profile?: string;
	/** Its tab's icon and color (Change Icon / Change Color: an icon name, a `terminal.ansi*` color id). */
	icon?: string;
	color?: string;
	/** Shown in the editor area (`terminal:<id>` editors, terminalEditor.svelte.ts) instead of a panel group. */
	inEditor?: boolean;
	/** A split's source directory as its shell integration reported it (not kept). */
	reportedCwd?: string;
};

function renameLeaf(node: PaneNode, from: string, to: string): PaneNode {
	if (node.type === 'leaf') return node.id === from ? leaf(to) : node;
	return { ...node, first: renameLeaf(node.first, from, to), second: renameLeaf(node.second, from, to) };
}

const STORE = 'kingu.panelTerminals';

class Terminals {
	list = $state<PanelTerminal[]>([]);
	active = $state(0);
	/** VS Code's terminal groups: pane trees of terminal ids, in tab-list order. */
	groups = $state<PaneNode[]>([]);
	/** Root tag of the folder whose terminals these are; null until loaded (nothing mounts). */
	tag = $state<string | null>(null);
	#seq = $state(0);
	#started = false;

	constructor() {
		$effect.root(() => {
			// Showing the terminal view with no terminal (the last one closed) starts one, like VS Code.
			$effect(() => {
				const shown = this.tag !== null && layout.panelVisible && layout.panelTab === 'terminal';
				if (shown) untrack(() => this.groups.length === 0 && this.open());
			});
			$effect(() => {
				const state = { list: $state.snapshot(this.list).map(({ cwdFrom: _, task: __, reportedCwd: ___, ...t }) => t), active: this.active, seq: this.#seq, groups: $state.snapshot(this.groups) };
				if (this.tag) persist(storeName(STORE, this.tag), state);
			});
		});
	}

	/** Shows folder `tag`'s terminals: the saved list, else one shell. */
	load(tag: string) {
		// terminal.integrated.enablePersistentSessions: off, the last list is not restored (its shells are then left over and killed).
		const saved = settings.get<boolean>('terminal.integrated.enablePersistentSessions') ? restore(storeName(STORE, tag), parsePanelTerminals) : null;
		const restored = !!saved && saved.list.length > 0;
		if (!this.#started) {
			this.#started = true;
			if (layout.panelTab === 'terminal' && hideOnStartup(settings.get<string>('terminal.integrated.hideOnStartup'), restored)) layout.panelVisible = false;
		}
		if (saved && restored) {
			this.list = saved.list.map(withoutRun);
			this.active = saved.active;
			this.#seq = saved.seq;
			this.groups = saved.groups;
		} else {
			this.list = [{ id: 1, title: 'zsh' }];
			this.active = 1;
			this.#seq = 1;
			this.groups = [leaf('1')];
		}
		this.tag = tag;
	}

	/** Another folder is about to load: unmount (the shells keep running). */
	unload() {
		this.tag = null;
		this.list = [];
		this.groups = [];
	}

	key(id: number): string {
		return panelKey(this.tag ?? '', id);
	}

	keys(): string[] {
		return this.tag ? this.list.map((t) => this.key(t.id)) : [];
	}

	get(id: number): PanelTerminal | undefined {
		return this.list.find((t) => t.id === id);
	}

	/** The index of the group holding terminal `id` (-1 when none does). */
	groupOf(id: number): number {
		return this.groups.findIndex((g) => hasLeaf(g, String(id)));
	}

	/** Terminal ids in tab-list order (group by group). */
	ordered(): number[] {
		return this.groups.flatMap((g) => leaves(g).map(Number));
	}

	/** A new terminal in the folder root (`folder`: that root folder of a multi-root window), shown in the panel; `run` is typed into its shell. */
	/** The root folder of a terminal opened by code without one (an installer, a code block run
	 * from chat): VS Code's last active workspace root, the active editor's folder in a multi-root
	 * window (newTerminal.ts sets it); null: the first folder. */
	defaultFolder: () => string | null = () => null;

	open(opts: { title?: string; run?: string[]; folder?: string; profile?: string; inEditor?: boolean } = {}): number {
		const id = ++this.#seq;
		const folder = opts.folder ?? this.defaultFolder();
		const title = opts.title ?? opts.profile ?? 'zsh';
		this.list = [...this.list, { id, title, run: opts.run, ...(folder ? { folder } : {}), ...(opts.profile ? { profile: opts.profile } : {}), ...(opts.inEditor ? { inEditor: true } : {}) }];
		if (opts.inEditor) return id;
		this.groups = [...this.groups, leaf(String(id))];
		this.active = id;
		return id;
	}

	/** Terminals shown in the panel (not moved to the editor area). */
	get panelList(): PanelTerminal[] {
		return this.list.filter((t) => !t.inEditor);
	}

	/** Changes terminal `id`'s fields (its tab icon or color). */
	update(id: number, fields: Partial<Pick<PanelTerminal, 'icon' | 'color' | 'title'>>) {
		this.list = this.list.map((t) => (t.id === id ? { ...t, ...fields } : t));
	}

	/** Takes terminal `id` out of its panel group into the editor area; its shell keeps running. */
	detachToEditor(id: number): boolean {
		const t = this.get(id);
		if (!t || t.inEditor) return false;
		this.#removeFromGroups(id);
		this.list = this.list.map((x) => (x.id === id ? { ...x, inEditor: true } : x));
		return true;
	}

	/** Puts editor terminal `id` back into the panel as its own group, active. */
	attachToPanel(id: number): boolean {
		const t = this.get(id);
		if (!t?.inEditor) return false;
		this.list = this.list.map((x) => (x.id === id ? { ...x, inEditor: undefined } : x));
		this.groups = [...this.groups, leaf(String(id))];
		this.active = id;
		return true;
	}

	/** Removes `id` from its group, the active terminal moving like VS Code's close. */
	#removeFromGroups(id: number) {
		const order = this.ordered();
		const g = this.groupOf(id);
		if (g < 0) return;
		const inGroup = leaves(this.groups[g]);
		const rest = removePane(this.groups[g], String(id));
		this.groups = this.groups.flatMap((tree, i) => (i !== g ? [tree] : rest ? [equalize(rest)] : []));
		if (!this.groups.length || this.active !== id) return;
		// VS Code: the pane at the same place in the group, else the neighbouring terminal in the list.
		if (rest) {
			const left = leaves(rest);
			this.active = Number(left[Math.min(inGroup.indexOf(String(id)), left.length - 1)]);
		} else {
			const next = this.ordered();
			this.active = next[Math.min(Math.max(order.indexOf(id), 0), next.length - 1)];
		}
	}

	/**
	 * A task terminal (VS Code's task terminals): in place of terminal `replace` (a reused one, its
	 * old process killed), split next to `splitWith` (presentation.group), else a new tab.
	 */
	openTask(opts: { title: string; task: TaskSpawn; replace?: number; splitWith?: number; folder?: string }): number {
		const id = ++this.#seq;
		const entry: PanelTerminal = { id, title: opts.title, task: opts.task, ...(opts.folder ? { folder: opts.folder } : {}) };
		const old = opts.replace !== undefined ? this.get(opts.replace) : undefined;
		if (old) {
			killPty(this.key(old.id));
			this.list = this.list.map((t) => (t.id === old.id ? entry : t));
			this.groups = this.groups.map((g) => renameLeaf(g, String(old.id), String(id)));
		} else if (opts.splitWith !== undefined && this.groupOf(opts.splitWith) >= 0) {
			const g = this.groupOf(opts.splitWith);
			this.list = [...this.list, entry];
			this.groups = this.groups.map((tree, i) => (i === g ? equalize(splitPane(tree, String(opts.splitWith), String(id), this.#direction())) : tree));
		} else {
			this.list = [...this.list, entry];
			this.groups = [...this.groups, leaf(String(id))];
		}
		return id;
	}

	/** The task of terminal `id` ended: a remount opens a shell instead of running it again. */
	endTask(id: number) {
		if (this.get(id)?.task) this.list = this.list.map((t) => (t.id === id ? { ...t, task: undefined } : t));
	}

	/** VS Code's panel terminals sit side by side when the panel is at the top or bottom, stacked when it is at a side. */
	#direction(): SplitDirection {
		const at = settings.get<string>('workbench.panel.defaultLocation');
		return at === 'left' || at === 'right' ? 'horizontal' : 'vertical';
	}

	/** Split Terminal: a new shell next to `id` in its group, in `id`'s current directory; sizes are distributed. */
	split(id = this.active): number | null {
		const g = this.groupOf(id);
		const source = this.get(id);
		if (g < 0 || !source) return null;
		const added = ++this.#seq;
		// The split keeps the source's folder and profile: splitCwd `workspaceRoot`, or a source whose shell is gone, starts there.
		const reportedCwd = this.reportedCwd(this.key(id));
		this.list = [
			...this.list,
			{ id: added, title: source.title, cwdFrom: this.key(id), ...(reportedCwd ? { reportedCwd } : {}), ...(source.folder ? { folder: source.folder } : {}), ...(source.profile ? { profile: source.profile } : {}) }
		];
		this.groups = this.groups.map((tree, i) => (i === g ? equalize(splitPane(tree, String(id), String(added), this.#direction())) : tree));
		this.active = added;
		focusTerminal(this.key(added));
		return added;
	}

	/** Focus Next/Previous Terminal in Terminal Group (wraps around). */
	focusPane(step: 1 | -1) {
		const g = this.groupOf(this.active);
		if (g < 0) return;
		const order = leaves(this.groups[g]);
		if (order.length < 2) return;
		this.active = Number(cyclePane(order, String(this.active), step));
		focusTerminal(this.key(this.active));
	}

	/** The active terminal's group has more than one terminal. */
	get splitActive(): boolean {
		const g = this.groupOf(this.active);
		return g >= 0 && this.groups[g].type === 'split';
	}

	resize(group: number, path: PanePath, ratio: number) {
		this.groups = this.groups.map((tree, i) => (i === group ? setRatio(tree, path, ratio) : tree));
	}

	/** Rename… (VS Code's input box with the current name; empty keeps it). */
	async rename(id = this.active) {
		const t = this.get(id);
		if (!t) return;
		const name = await quick.input({ placeholder: tr('tools.terminal.rename.placeholder', { title: t.title }), hint: (v) => (v.trim() ? tr('tools.terminal.rename.hint', { name: v.trim() }) : tr('tools.terminal.rename.empty')) });
		const title = name?.trim();
		if (title) this.list = this.list.map((x) => (x.id === id ? { ...x, title } : x));
	}

	/** Kill Terminal: asks first while a command runs in it and terminal.integrated.confirmOnKill covers the panel. */
	async kill(id: number) {
		const t = this.get(id);
		if (!t) return;
		if (!(await confirmKill([this.key(id)], 'panel', t.title))) return;
		this.close(id);
	}

	close(id: number) {
		const t = this.get(id);
		if (!t) return;
		killPty(this.key(id));
		const wasInPanel = !t.inEditor;
		this.#removeFromGroups(id);
		this.list = this.list.filter((x) => x.id !== id);
		if (wasInPanel && !this.groups.length) {
			// The terminal view stays empty (VS Code); terminal.integrated.hideOnLastClosed also hides the
			// panel. Showing it again, or New Terminal, starts a terminal.
			if (settings.get<boolean>('terminal.integrated.hideOnLastClosed') && layout.panelTab === 'terminal') layout.panelVisible = false;
		}
	}

	/** The directory terminal `key`'s shell integration last reported (set by the terminal page). */
	reportedCwd: (key: string) => string | undefined = () => undefined;
}

export const terminals = new Terminals();
