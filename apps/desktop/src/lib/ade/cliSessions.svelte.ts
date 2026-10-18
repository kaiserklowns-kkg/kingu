// Agent CLIs running in task terminals (the Orca way): which task has one, the command it was
// started with, and when it last printed something — that is how a card shows "working" vs
// "waiting for you". The terminal itself lives in the Agents layout (kept mounted). The sessions
// survive a webview reload (sessionStorage) and their terminals re-attach under `cliKey`; after an
// app restart there are none, so the user continues a task's CLI explicitly.

import { invoke } from '@tauri-apps/api/core';
import { killPty } from '#lib/terminal/pty.ts';
import { cliKey, parseCliSessions, persist, restore } from '#lib/terminal/sessions.ts';
import { isWorking } from './agentCli';
import { applyHook, initialHookState, type HookState } from './agentHooks';

/** `hookToken`: the session reports its state through Claude Code hooks (claude CLIs). */
export type CliSession = { run: string[]; startedAt: number; hookToken?: string };

const STORE = 'kingu.cliSessions';

class CliSessions {
	sessions = $state<Record<string, CliSession>>({});
	#last = $state<Record<string, number>>({});
	/** Ticks every second while a CLI runs, so "working" turns into "waiting" without new output. */
	now = $state(Date.now());
	#timer: ReturnType<typeof setInterval> | undefined;

	/** State from hook events, for sessions started with hooks (rebuilt from the hook file after a reload). */
	hooks = $state<Record<string, HookState>>({});
	#offsets: Record<string, number> = {};
	#polling = false;

	constructor() {
		const saved = restore(STORE, parseCliSessions);
		if (saved) {
			this.sessions = saved;
			for (const [slug, s] of Object.entries(saved)) if (s.hookToken) this.hooks[slug] = initialHookState(Date.now());
		}
		this.#tick();
		$effect.root(() => {
			$effect(() => persist(STORE, $state.snapshot(this.sessions)));
		});
	}

	key(slug: string): string | null {
		const s = this.sessions[slug];
		return s ? cliKey(slug, s.startedAt) : null;
	}

	ptyKeys(): string[] {
		return Object.entries(this.sessions).map(([slug, s]) => cliKey(slug, s.startedAt));
	}

	start(slug: string, run: string[], hookToken?: string) {
		const old = this.sessions[slug];
		if (old) {
			killPty(cliKey(slug, old.startedAt));
			if (old.hookToken && old.hookToken !== hookToken) void invoke('agent_hook_clear', { token: old.hookToken }).catch(() => {});
		}
		// A new key even within the same millisecond: Rust never re-types `run` for a key it has seen.
		this.sessions[slug] = { run, startedAt: Math.max(Date.now(), (old?.startedAt ?? 0) + 1), hookToken };
		this.#offsets[slug] = 0;
		if (hookToken) this.hooks[slug] = initialHookState(Date.now());
		else delete this.hooks[slug];
		this.#last[slug] = Date.now();
		this.#tick();
	}

	end(slug: string) {
		const key = this.key(slug);
		if (key) killPty(key);
		const token = this.sessions[slug]?.hookToken;
		if (token) void invoke('agent_hook_clear', { token }).catch(() => {});
		delete this.hooks[slug];
		delete this.#offsets[slug];
		delete this.sessions[slug];
		delete this.#last[slug];
		this.#tick();
	}

	has(slug: string) {
		return slug in this.sessions;
	}

	/** Output arrived (throttled: one state write per 500ms per task). */
	output(slug: string) {
		const t = Date.now();
		if (t - (this.#last[slug] ?? 0) > 500) this.#last[slug] = t;
	}

	lastOutput(slug: string): number | undefined {
		return this.#last[slug];
	}

	working(slug: string): boolean {
		return isWorking(this.#last[slug], this.now);
	}

	/** New hook events of every session that has hooks (one read per session, never overlapping). */
	async #poll() {
		if (this.#polling) return;
		this.#polling = true;
		try {
			for (const [slug, s] of Object.entries(this.sessions)) {
				if (!s.hookToken) continue;
				const r = await invoke<{ events: object[]; offset: number }>('agent_hook_read', { token: s.hookToken, offset: this.#offsets[slug] ?? 0 }).catch(() => null);
				if (!r || !this.sessions[slug]) continue;
				this.#offsets[slug] = r.offset;
				if (r.events.length) this.hooks[slug] = r.events.reduce<HookState>((st, ev) => applyHook(st, ev, Date.now()), this.hooks[slug] ?? initialHookState(Date.now()));
			}
		} finally {
			this.#polling = false;
		}
	}

	#tick() {
		const any = Object.keys(this.sessions).length > 0;
		if (any && !this.#timer)
			this.#timer = setInterval(() => {
				this.now = Date.now();
				void this.#poll();
			}, 1000);
		else if (!any && this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}
}

export const cliSessions = new CliSessions();
