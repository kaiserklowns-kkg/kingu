// Sleeping terminal panes (per-pane agent hibernation, hibernation.ts): an agent in a terminal
// pane of a task's worktree that the coordinator (attempts.svelte.ts) closed keeps a record here
// — which CLI, which session, since when, its folder and launch — per folder in localStorage. The
// agent's job is ended but its shell stays, so the pane keeps the agent's last screen above the
// prompt and its scrollback (in the terminal daemon, also across a restart of Kingu; Orca keeps
// the pane's frozen frame and history). The tab shows a sleeping mark (AdeTabBar.svelte). When it
// comes back on screen the resume is typed into that shell; when the shell is gone (a restart
// without the daemon) the pane's new shell types it (AgentsLayout.svelte passes `typeOf`). Pure
// decisions live in hibernation.ts.

import { invoke } from '@tauri-apps/api/core';
import { persist, restore, storeName } from '#lib/terminal/sessions.ts';
import { terminalHandle } from '#lib/terminal/registry.ts';
import { clientLog } from '#lib/client-log.ts';
import { adeLayout } from './adeLayout.svelte';
import { tabPanes } from './adeTabs';
import { foregroundProgram } from './agentProfiles';
import {
	emptyPaneSleep,
	paneAgent,
	paneConnected,
	paneResumeLine,
	paneSleepFailed,
	paneSlept,
	panesPruned,
	paneWakes,
	paneWoken,
	parseSleepingPanes,
	serializeSleepingPanes,
	SLEEPING_PANES_STORE,
	type PaneSleepState,
	type SleepingPane
} from './hibernation';

/**
 * Orca's POST_REPLAY_MODE_RESET, written to the pane's screen once its agent is gone: a TUI killed
 * mid-frame can leave mouse reporting, focus reports, bracketed paste, the Kitty keyboard protocol
 * or a hidden cursor on, which would garble the shell's input.
 */
const MODE_RESET = '\x1b[0m\x1b[0 q\x1b[<99u\x1b[=0u\x1b[>4m\x1b[?25h\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?1004l\x1b[?2004l\x1b7';

class PaneSleep {
	state = $state.raw<PaneSleepState>(emptyPaneSleep);
	/** Root tag of the folder whose panes these are; null until loaded. */
	#tag = $state<string | null>(null);
	/** Closes still in flight: a wake waits for its own, so the resume cannot land in the dying agent. */
	#closing = new Map<string, Promise<boolean>>();
	/** The panes on screen at the last look. */
	#shown: ReadonlySet<string> = new Set();

	constructor() {
		$effect.root(() => {
			$effect(() => {
				const panes = this.state.panes;
				if (this.#tag) persist(storeName(SLEEPING_PANES_STORE, this.#tag), serializeSleepingPanes(panes));
			});
		});
	}

	/** Folder `tag`'s sleeping panes come back (after adeLayout loaded its terminal tabs). */
	load(tag: string) {
		const panes = restore(storeName(SLEEPING_PANES_STORE, tag), (raw) => parseSleepingPanes(raw, tag)) ?? {};
		this.state = panesPruned({ panes, live: [], waking: [] }, new Set(adeLayout.ptyKeys()));
		this.#shown = new Set();
		this.#tag = tag;
	}

	/** Another folder is about to load: its records stay in storage. */
	unload() {
		this.#tag = null;
		this.state = emptyPaneSleep;
		this.#shown = new Set();
	}

	has(key: string): boolean {
		return key in this.state.panes;
	}

	/** The line a new shell of the pane types while it sleeps (its shell was gone): the agent's resume. */
	typeOf(key: string): string | undefined {
		return paneResumeLine(this.state, key, false) ?? undefined;
	}

	/** The sleeping pane of a terminal tab (its first, for a split tab), for the tab's mark. */
	tab(slug: string, tabId: string): SleepingPane | undefined {
		const tab = (adeLayout.terminals[slug] ?? []).find((t) => t.id === tabId);
		if (!tab) return undefined;
		for (const pane of tabPanes(tab)) {
			const r = this.state.panes[adeLayout.ptyKey(slug, pane)];
			if (r) return r;
		}
		return undefined;
	}

	/**
	 * Ends the pane's agent (job `pid` in front of its shell), keeping `record` first. False when a
	 * close of it is in flight already, the job is no longer in front, or the close failed (then
	 * nothing sleeps there).
	 */
	async hibernate(key: string, record: SleepingPane, pid: number): Promise<boolean> {
		if (this.#closing.has(key) || !this.#tag) return false;
		this.state = paneSlept(this.state, key, record);
		const done = invoke<boolean>('pty_stop_job', { key, pid }).then(
			(stopped) => {
				if (!stopped) this.state = paneSleepFailed(this.state, key);
				return stopped;
			},
			(e) => {
				clientLog('error', `hibernating ${key}: ${e}`);
				this.state = paneSleepFailed(this.state, key);
				return false;
			}
		);
		this.#closing.set(key, done);
		const ok = await done;
		this.#closing.delete(key);
		if (ok) {
			terminalHandle(key)?.print?.(MODE_RESET);
			// Its status hook file goes too (the resumed agent writes a fresh one): the dead agent's last events must not read as a live one.
			void invoke('agent_pane_hook_clear', { key }).catch(() => {});
			// The pane came on screen while its agent was closing: it owes a wake now (Orca consumes the wake after the exit).
			if (this.#shown.has(key)) this.#wake(new Set([...this.#shown].filter((k) => k !== key)), this.#shown);
		}
		return ok;
	}

	/** The panes on screen now: those that just came back and sleep wake, once per return. */
	shown(now: ReadonlySet<string>) {
		const prev = this.#shown;
		this.#shown = new Set(now);
		this.#wake(prev, now);
	}

	#wake(prev: ReadonlySet<string>, now: ReadonlySet<string>) {
		const { state, wake } = paneWakes(this.state, prev, now);
		if (state !== this.state) this.state = state;
		for (const key of wake) void this.#resume(key);
	}

	/** Types the resume into the pane's shell, if the shell is at its prompt. */
	async #resume(key: string) {
		const ok = await (this.#closing.get(key) ?? Promise.resolve(true));
		const line = ok ? paneResumeLine(this.state, key, true) : null;
		if (!line) return;
		let how: 'typed' | 'taken' | 'failed' = 'failed';
		try {
			const jobs = await invoke<Record<string, { name: string; args?: string[] }>>('pty_foreground', { keys: [key] });
			const job = jobs[key];
			if (job) {
				// Something runs in front of the shell already: the agent itself (started again by hand) means nothing sleeps here any more.
				how = paneAgent(foregroundProgram(job)) ? 'taken' : 'failed';
				clientLog('info', `not resuming the hibernated agent of ${key}: ${job.name} runs there`);
			} else if (key in this.state.panes) {
				clientLog('info', `resuming the hibernated agent of ${key}`);
				await invoke('pty_write', { key, data: `${line}\r` });
				how = 'typed';
			}
		} catch (e) {
			clientLog('error', `resuming the hibernated agent of ${key}: ${e}`);
		}
		this.state = paneWoken(this.state, key, how);
	}

	/** A pane's terminal came up (Terminal.svelte `onconnect`). */
	connected(key: string, how: 'spawned' | 'attached' | 'failed') {
		const next = paneConnected(this.state, key, how);
		if (next === this.state) return;
		this.state = next;
		// A sleeping pane on screen as its live shell is found (a restart: Orca resumes a visible restored pane at once).
		if (how === 'attached' && this.#shown.has(key)) this.#wake(new Set([...this.#shown].filter((k) => k !== key)), this.#shown);
	}

	/** Panes that were closed take their record along. */
	prune(open: ReadonlySet<string>) {
		if (!this.#tag) return;
		const next = panesPruned(this.state, open);
		if (next !== this.state) this.state = next;
	}
}

export const paneSleep = new PaneSleep();
