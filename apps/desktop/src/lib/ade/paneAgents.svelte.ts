// Agents in any terminal pane of a task's worktree (Orca's per-pane agent status), not only the
// CLI Kingu launched: a `claude` or `codex` typed by hand in a second tab or a split shows on the
// task card and moves its status. Evidence per pane: its own status hook file (every task
// terminal gets `KINGU_AGENT_HOOK_FILE`, Rust lib.rs pty_spawn), its terminal title
// (agentTitle.ts) and the job in front of its shell (`pty_list`).
//
// The same PTY listing (every 2s while any agent terminal exists) is how the launched CLIs learn
// that their process is gone (cliSessions.reconcile). Pure decisions live in agentPresence.ts.

import { invoke } from '@tauri-apps/api/core';
import { applyHook, initialHookState, type HookState } from './agentHooks';
import { paneRow, type AgentRow, type PtyListing } from './agentPresence';
import { applyTitle, type TitleTrack } from './agentTitle';
import { adeLayout } from './adeLayout.svelte';
import { tabPanes } from './adeTabs';
import { cliSessions } from './cliSessions.svelte';
import { PRIMARY } from './adeLayout.svelte';

const POLL_MS = 2000;

/** The platform reports the job in front of a shell (procinfo.rs: macOS and Linux). */
const foregroundKnown = () => typeof navigator === 'undefined' || !/win/i.test(navigator.platform);

type Pane = { title?: TitleTrack; hook?: HookState; hookAgent?: string; foreground?: string | null; lastOutput?: number };

class PaneAgents {
	/** Per PTY key of an ADE terminal pane. */
	panes = $state<Record<string, Pane>>({});
	/** Set every poll, so output timing and stale hooks are judged again without new events. */
	now = $state(Date.now());
	#offsets: Record<string, number> = {};
	#polling = false;
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor() {
		if (typeof window !== 'undefined') this.#timer = setInterval(() => void this.#poll(), POLL_MS);
	}

	/** A pane's terminal title changed (OSC 0/2). */
	title(key: string, title: string) {
		const p = this.panes[key];
		const next = applyTitle(p?.title, title, Date.now());
		// Shell titles (`zsh`, `~/repo`) of a pane that never ran an agent need no state.
		if (!p && next.status === null) return;
		this.panes[key] = { ...p, title: next };
	}

	/** Output arrived (throttled: one state write per 500ms per pane). */
	output(key: string) {
		const p = this.panes[key];
		if (!p?.foreground) return;
		const now = Date.now();
		if (now - (p.lastOutput ?? 0) > 500) this.panes[key] = { ...p, lastOutput: now };
	}

	/** The agents of a task's terminal panes (its launched CLI is not one: that is cliSessions'). */
	rows(slug: string): AgentRow[] {
		if (slug === PRIMARY) return [];
		const now = Math.max(this.now, cliSessions.now);
		const out: AgentRow[] = [];
		for (const tab of adeLayout.terminals[slug] ?? [])
			for (const pane of tabPanes(tab)) {
				const key = adeLayout.ptyKey(slug, pane);
				const p = this.panes[key];
				const row = p && paneRow({ id: key, ...p }, now);
				if (row) out.push(row);
			}
		return out;
	}

	/** The tab id of a pane's PTY key in task `slug`, for labels. */
	tabOf(slug: string, key: string): string | undefined {
		return (adeLayout.terminals[slug] ?? []).find((t) => tabPanes(t).some((p) => adeLayout.ptyKey(slug, p) === key))?.id;
	}

	/** Task panes by PTY key. */
	#taskPanes(): Map<string, string> {
		const out = new Map<string, string>();
		for (const [slug, list] of Object.entries(adeLayout.terminals)) {
			if (slug === PRIMARY) continue;
			for (const t of list) for (const p of tabPanes(t)) out.set(adeLayout.ptyKey(slug, p), slug);
		}
		return out;
	}

	async #poll() {
		if (this.#polling) return;
		const panes = this.#taskPanes();
		if (!panes.size && !Object.keys(cliSessions.sessions).length) return;
		this.#polling = true;
		try {
			// An error is not "every terminal is gone": skip this round.
			const list = await invoke<PtyListing[]>('pty_list').catch(() => null);
			if (!list) return;
			this.now = Date.now();
			cliSessions.reconcile(list, foregroundKnown());
			const byKey = new Map(list.map((p) => [p.key, p]));
			for (const key of Object.keys(this.panes)) if (!panes.has(key)) delete this.panes[key];
			for (const key of panes.keys()) {
				const info = byKey.get(key);
				if (!info) continue;
				const foreground = info.alive && foregroundKnown() ? (info.foreground?.name ?? null) : undefined;
				const p = this.panes[key];
				if (foreground === null) {
					// Back at the prompt: whatever ran there exited; its hooks and title no longer count.
					if (p && (p.foreground !== null || p.hook || p.title?.status)) this.panes[key] = { foreground: null };
					continue;
				}
				if (!p || p.foreground !== foreground) this.panes[key] = { ...p, foreground };
				await this.#readHooks(key);
			}
		} finally {
			this.#polling = false;
		}
	}

	/** New events of a pane's hook file (an agent CLI with Kingu's status hooks runs there). */
	async #readHooks(key: string) {
		const r = await invoke<{ events: object[]; offset: number }>('agent_pane_hook_read', { key, offset: this.#offsets[key] ?? 0 }).catch(() => null);
		if (!r) return;
		this.#offsets[key] = r.offset;
		if (!r.events.length) return;
		const p = this.panes[key];
		if (!p) return;
		const now = Date.now();
		const hook = r.events.reduce<HookState>((st, ev) => applyHook(st, ev, now), p.hook ?? initialHookState(now));
		const last = r.events.at(-1) as { kingu_hook?: unknown } | undefined;
		this.panes[key] = { ...p, hook, hookAgent: typeof last?.kingu_hook === 'string' ? last.kingu_hook : p.hookAgent };
	}

	dispose() {
		clearInterval(this.#timer);
	}
}

export const paneAgents = new PaneAgents();
