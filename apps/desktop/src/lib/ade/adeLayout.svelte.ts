// Agents layout (ADE) state, laid out like Orca: the selected worktree (the folder itself or a
// task's worktree, `appMode.activeSession`), its tabs (the agent session or new-task composer,
// then terminals started in that worktree), the board instead of a worktree, and the right
// side bar's tab. Terminals stay mounted while their worktree is not shown.

import { appMode } from '#lib/workbench/mode.svelte.ts';
import { adeTabs, type AdeTab, type TerminalTab } from './adeTabs.ts';

export type RightTab = 'files' | 'changes';
/** Worktree key: '' for the folder itself (Orca's "primary" worktree), else the task slug. */
export const PRIMARY = '';

class AdeLayout {
	/** The center shows the task board (Tasks in the side bar) instead of a worktree. */
	board = $state(false);
	rightTab = $state<RightTab>('changes');
	/** The side bar's search box: filters worktrees by title or branch. */
	query = $state('');
	terminals = $state<Record<string, TerminalTab[]>>({});
	/** Active tab per worktree ('main' or a terminal id). */
	active = $state<Record<string, string>>({});
	#seq = 0;

	get key(): string {
		return appMode.activeSession ?? PRIMARY;
	}

	tabs(key: string): AdeTab[] {
		return adeTabs(key, this.terminals[key] ?? []);
	}

	activeTab(key: string): string {
		const id = this.active[key] ?? 'main';
		return id === 'main' || this.terminals[key]?.some((t) => t.id === id) ? id : 'main';
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

	newTerminal(key: string) {
		const list = this.terminals[key] ?? [];
		const n = list.reduce((m, t) => Math.max(m, t.n), 0) + 1;
		const tab = { id: `t${++this.#seq}`, n };
		this.terminals[key] = [...list, tab];
		this.active[key] = tab.id;
		this.board = false;
	}

	closeTerminal(key: string, id: string) {
		const list = this.terminals[key] ?? [];
		const i = list.findIndex((t) => t.id === id);
		if (i < 0) return;
		const next = list.filter((t) => t.id !== id);
		// Closing the active tab shows its neighbour (like an editor tab), else the main tab.
		if (this.active[key] === id) this.active[key] = next[Math.min(i, next.length - 1)]?.id ?? 'main';
		this.terminals[key] = next;
	}

	/** A removed task: its terminals go away with it. */
	drop(key: string) {
		delete this.terminals[key];
		delete this.active[key];
	}
}

export const adeLayout = new AdeLayout();
