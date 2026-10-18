// The ADE's right side bar (Orca's right sidebar), following the selected worktree: the tab in
// front per worktree (Orca's rightSidebarTabByWorktree), the Explorer's Names / Contents mode and
// search per worktree (fileSearchStateByWorktree), the Show Dotfiles / Show Git Ignored Files
// toggles, each task worktree's Source Control, and the shortcuts and palette commands.

import { FileUndo } from './fileUndo.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { scm } from '#lib/workbench/scm.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { adeLayout } from './adeLayout.svelte.ts';
import { cleanTabs, touchesWorktree, toggleTab, visibleTabs, type RightTab } from './rightSidebar.ts';
import { adeTasks } from './tasks.svelte.ts';
import { WorktreeRepo } from './worktreeRepo.svelte.ts';

const KEY = 'kingu.adeRightSidebar';

export type ExplorerView = 'names' | 'contents';
export type ContentOptions = { matchCase: boolean; wholeWord: boolean; regex: boolean; include: string; exclude: string; details: boolean };
export type FindState = { view: ExplorerView; query: string; options: ContentOptions };

const proxied = <T>(value: T): T => {
	const s = $state(value);
	return s;
};

const freshFind = (): FindState => ({ view: 'names', query: '', options: { matchCase: false, wholeWord: false, regex: false, include: '', exclude: '', details: false } });

type Saved = { showDotfiles?: boolean; showIgnored?: boolean; tabs?: Record<string, unknown> };

function readSaved(): Saved {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
	} catch {
		return {};
	}
}

class RightSidebar {
	#tabs = $state<Record<string, RightTab>>({});
	#find = new Map<string, FindState>();
	showDotfiles = $state(true);
	showIgnored = $state(true);
	/** Bumped to focus the Explorer's find box (⌘⇧F). */
	focusFind = $state(0);
	#repos = new Map<string, WorktreeRepo>();
	#undo = new Map<string, FileUndo>();
	/** The folder `#tabs` belongs to, and every other folder's saved tabs (Orca keeps the tab per worktree across restarts). */
	#root: string | null = null;
	#savedTabs: Record<string, unknown> = {};

	constructor() {
		const s = readSaved();
		if (typeof s.showDotfiles === 'boolean') this.showDotfiles = s.showDotfiles;
		if (typeof s.showIgnored === 'boolean') this.showIgnored = s.showIgnored;
		if (s.tabs && typeof s.tabs === 'object') this.#savedTabs = s.tabs;
		$effect.root(() => {
			$effect(() => {
				const all = { ...this.#savedTabs };
				if (this.#root) (delete all[this.#root], (all[this.#root] = { ...this.#tabs }));
				// The 50 most recently opened folders.
				const tabs = Object.fromEntries(Object.entries(all).slice(-50));
				const snapshot = { showDotfiles: this.showDotfiles, showIgnored: this.showIgnored, tabs };
				try {
					localStorage.setItem(KEY, JSON.stringify(snapshot));
				} catch {
					// Storage can be unavailable; the toggles reset on the next launch.
				}
			});
		});
	}

	/** Whether worktree `key` is a git repository (Source Control and Checks show only then). */
	isGit(key: string): boolean {
		return key ? !!adeTasks.find(key) : scm.repo !== null;
	}

	/** The tabs worktree `key` shows and the one in front (Explorer until another is chosen there). */
	tabs(key: string) {
		return visibleTabs(this.isGit(key), this.#tabs[key] ?? 'files', !!key && !!adeTasks.find(key));
	}

	tab(key: string): RightTab {
		return this.tabs(key).active;
	}

	setTab(key: string, tab: RightTab) {
		// Re-inserted so the saved map keeps the most recently used worktrees last (see `cleanTabs`).
		delete this.#tabs[key];
		this.#tabs[key] = tab;
	}

	/** Created on first use (also while rendering, so the map itself is not reactive; each state is). */
	find(key: string): FindState {
		let f = this.#find.get(key);
		if (!f) {
			f = proxied(freshFind());
			this.#find.set(key, f);
		}
		return f;
	}

	/** A tab shortcut on the shown worktree: shows the tab, or hides the side bar when it is already in front. */
	toggle(tab: RightTab) {
		const key = adeLayout.key;
		const next = toggleTab({ visible: appMode.panelVisible, tab: this.tab(key) }, tab);
		appMode.panelVisible = next.visible;
		this.setTab(key, next.tab);
	}

	/** ⌘⇧F: Explorer in Contents mode with its box focused (`include` scopes it, Find in Folder). */
	searchContents(include?: string) {
		const key = adeLayout.key;
		appMode.panelVisible = true;
		this.setTab(key, 'files');
		const f = this.find(key);
		f.view = 'contents';
		if (include !== undefined) {
			f.options.include = include;
			f.options.details = true;
		}
		this.focusFind++;
	}

	/** Git status of task worktree `slug` ('' = the folder itself), kept while the app runs and
	 * re-read on watcher batches that touch it: the one source for the Explorer's decorations and
	 * the Source Control tab. */
	repo(slug: string): WorktreeRepo {
		let r = this.#repos.get(slug);
		if (!r) {
			r = new WorktreeRepo(slug);
			if (slug) r.onChange = () => void adeTasks.refreshStat(slug);
			this.#repos.set(slug, r);
		}
		return r;
	}

	/** Watcher batch: re-read the git status and review of task worktrees it touches (the folder's own `scm` refreshes itself). */
	changed(paths: string[]) {
		for (const [slug, r] of this.#repos) {
			if (!r.loaded || !touchesWorktree(paths, slug)) continue;
			void r.refresh();
			if (slug) void adeTasks.refreshStat(slug);
		}
	}

	/** The Explorer's undo / redo history of worktree `slug` ('' = the folder itself). */
	undo(slug: string): FileUndo {
		let h = this.#undo.get(slug);
		if (!h) this.#undo.set(slug, (h = new FileUndo()));
		return h;
	}

	/** Another folder: nothing of the old one's worktrees stays, except the tabs saved for it. */
	reset(root: string | null = workspace.root) {
		if (this.#root) this.#savedTabs = { ...this.#savedTabs, [this.#root]: { ...this.#tabs } };
		this.#root = root;
		this.#tabs = root ? cleanTabs(this.#savedTabs[root]) : {};
		this.#find.clear();
		this.#repos.clear();
		this.#undo.clear();
	}
}

export const rightSidebar = new RightSidebar();

/** Shortcuts as in Orca (⌘L, ⌘⇧E, ⌘⇧F, ⌘⇧G), palette commands, and the watcher hook. */
export function installRightSidebar(): () => void {
	const agents = () => appMode.isAgents;
	const unregister = [
		commands.register({ id: 'kingu.agents.toggleRightSidebar', title: 'Toggle Right Side Bar', category: 'Agents', key: 'cmd+l', scope: 'agents', when: agents, run: () => (appMode.panelVisible = !appMode.panelVisible) }),
		commands.register({ id: 'kingu.agents.rightSidebar.explorer', title: 'Right Side Bar: Explorer', category: 'Agents', key: 'cmd+shift+e', scope: 'agents', when: agents, run: () => rightSidebar.toggle('files') }),
		commands.register({ id: 'kingu.agents.rightSidebar.search', title: 'Right Side Bar: Search File Contents', category: 'Agents', key: 'cmd+shift+f', scope: 'agents', when: agents, run: () => rightSidebar.searchContents() }),
		commands.register({ id: 'kingu.agents.rightSidebar.agents', title: 'Right Side Bar: Agents', category: 'Agents', when: agents, run: () => rightSidebar.toggle('agents') }),
		commands.register({
			id: 'kingu.agents.rightSidebar.sourceControl',
			title: 'Right Side Bar: Source Control',
			category: 'Agents',
			key: 'cmd+shift+g',
			scope: 'agents',
			when: () => agents() && rightSidebar.isGit(adeLayout.key),
			run: () => rightSidebar.toggle('changes')
		}),
		commands.register({ id: 'kingu.agents.rightSidebar.ports', title: 'Right Side Bar: Ports', category: 'Agents', when: agents, run: () => rightSidebar.toggle('ports') }),
		commands.register({ id: 'kingu.agents.rightSidebar.checks', title: 'Right Side Bar: Checks', category: 'Agents', when: () => agents() && rightSidebar.isGit(adeLayout.key), run: () => rightSidebar.toggle('checks') })
	];
	const unwatch = workspace.onAnyChange((paths) => rightSidebar.changed(paths));
	let root = workspace.root;
	rightSidebar.reset(root);
	const stop = $effect.root(() => {
		$effect(() => {
			if (workspace.root !== root) rightSidebar.reset(workspace.root);
			root = workspace.root;
		});
	});
	return () => {
		unregister.forEach((u) => u());
		unwatch();
		stop();
	};
}
