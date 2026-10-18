// Agent CLIs running in task terminals (the Orca way): which task has one, the command it was
// started with, and when it last printed something — that is how a card shows "working" vs
// "waiting for you". The terminal itself lives in the Agents layout (kept mounted). The sessions
// belong to the open folder and are kept in localStorage per folder: after a reload, a folder
// switch or an app restart (the kingu-ptyd daemon keeps the CLIs running) each one whose PTY is
// still alive re-attaches under `cliKey`; the others are gone, and the user continues the task.

import { invoke } from '@tauri-apps/api/core';
import { killPty } from '#lib/terminal/pty.ts';
import { cliKey, liveCliSessions, parseCliSessions, persist, restore, storeName } from '#lib/terminal/sessions.ts';
import { isWorking } from './agentCli';
import { applyHook, initialHookState, type HookState } from './agentHooks';
import { pasteText, promptDue } from '#lib/ade/agentProfiles.ts';

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

	/** Root tag of the folder whose sessions these are; null until loaded. */
	#tag = $state<string | null>(null);
	/** Sessions restored from storage: their terminal only re-attaches, never re-runs the CLI. */
	#restored = new Set<string>();
	/** Prompts to paste once their CLI is up (CLIs that take no prompt argument); kept in memory only. */
	#typePrompts: Record<string, string> = {};
	#sawOutput = new Set<string>();
	/** A session id a CLI reported (codex notify), for the task to save. */
	onSessionId: ((slug: string, id: string) => void) | null = null;

	constructor() {
		$effect.root(() => {
			$effect(() => {
				const state = $state.snapshot(this.sessions);
				if (this.#tag) persist(storeName(STORE, this.#tag), state);
			});
		});
	}

	/** Folder `tag`'s sessions whose PTY is in `live`; hook polling picks up where it was. */
	load(tag: string, live: Set<string>) {
		const { kept, gone } = liveCliSessions(restore(storeName(STORE, tag), parseCliSessions) ?? {}, tag, live);
		for (const s of Object.values(gone)) if (s.hookToken) void invoke('agent_hook_clear', { token: s.hookToken }).catch(() => {});
		this.sessions = kept;
		this.hooks = {};
		this.#offsets = {};
		this.#restored = new Set(Object.keys(kept));
		for (const [slug, s] of Object.entries(kept)) if (s.hookToken) this.hooks[slug] = initialHookState(Date.now());
		this.#tag = tag;
		this.#tick();
	}

	/** Another folder is about to load: its CLIs keep running, unshown. */
	unload() {
		this.#tag = null;
		this.sessions = {};
		this.hooks = {};
		this.#offsets = {};
		this.#last = {};
		this.#typePrompts = {};
		this.#sawOutput.clear();
		this.#restored.clear();
		this.#tick();
	}

	ptyKey(slug: string, startedAt: number): string {
		return cliKey(this.#tag ?? '', slug, startedAt);
	}

	key(slug: string): string | null {
		const s = this.sessions[slug];
		return s ? this.ptyKey(slug, s.startedAt) : null;
	}

	ptyKeys(): string[] {
		return Object.entries(this.sessions).map(([slug, s]) => this.ptyKey(slug, s.startedAt));
	}

	/** The command a session's terminal may type: none for a restored one (it only re-attaches). */
	runOf(slug: string): string[] | undefined {
		return this.#restored.has(slug) ? undefined : this.sessions[slug]?.run;
	}

	start(slug: string, run: string[], hookToken?: string, typePrompt?: string) {
		const old = this.sessions[slug];
		if (old) {
			killPty(this.ptyKey(slug, old.startedAt));
			if (old.hookToken && old.hookToken !== hookToken) void invoke('agent_hook_clear', { token: old.hookToken }).catch(() => {});
		}
		// A new key even within the same millisecond: Rust never re-types `run` for a key it has seen.
		this.sessions[slug] = { run, startedAt: Math.max(Date.now(), (old?.startedAt ?? 0) + 1), hookToken };
		this.#restored.delete(slug);
		this.#sawOutput.delete(slug);
		if (typePrompt) this.#typePrompts[slug] = typePrompt;
		else delete this.#typePrompts[slug];
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
		delete this.#typePrompts[slug];
		this.#sawOutput.delete(slug);
		this.#restored.delete(slug);
		this.#tick();
	}

	has(slug: string) {
		return slug in this.sessions;
	}

	/** Output arrived (throttled: one state write per 500ms per task). */
	output(slug: string) {
		this.#sawOutput.add(slug);
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
				if (!r.events.length) continue;
				const before = this.hooks[slug]?.sessionId;
				this.hooks[slug] = r.events.reduce<HookState>((st, ev) => applyHook(st, ev, Date.now()), this.hooks[slug] ?? initialHookState(Date.now()));
				const id = this.hooks[slug].sessionId;
				if (id && id !== before) this.onSessionId?.(slug, id);
			}
		} finally {
			this.#polling = false;
		}
	}

	/** Pastes `prompt` into the task's running CLI and submits it (a follow-up such as "fix the failing checks"). */
	async paste(slug: string, prompt: string) {
		const key = this.key(slug);
		if (!key) throw new Error('ไม่มี agent CLI ที่รันอยู่ในงานนี้');
		await invoke('pty_write', { key, data: pasteText(prompt) });
		await new Promise((r) => setTimeout(r, 300));
		await invoke('pty_write', { key, data: '\r' });
		this.#last[slug] = Date.now();
	}

	/** Pastes each waiting prompt once its CLI's composer is up, then presses Enter. */
	#typeDuePrompts() {
		for (const [slug, prompt] of Object.entries(this.#typePrompts)) {
			const s = this.sessions[slug];
			if (!s) {
				delete this.#typePrompts[slug];
				continue;
			}
			if (!promptDue(s.startedAt, this.#sawOutput.has(slug), this.#last[slug], Date.now())) continue;
			delete this.#typePrompts[slug];
			const key = this.ptyKey(slug, s.startedAt);
			// Enter apart from the paste: some TUIs drop a key that arrives with it.
			void invoke('pty_write', { key, data: pasteText(prompt) })
				.then(() => new Promise((r) => setTimeout(r, 300)))
				.then(() => invoke('pty_write', { key, data: '\r' }))
				.catch(() => {});
		}
	}

	#tick() {
		const any = Object.keys(this.sessions).length > 0;
		if (any && !this.#timer)
			this.#timer = setInterval(() => {
				this.now = Date.now();
				this.#typeDuePrompts();
				void this.#poll();
			}, 1000);
		else if (!any && this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}
}

export const cliSessions = new CliSessions();
