// Agent CLIs running in task terminals (the Orca way): which task has one, the command it was
// started with, and when it last printed something — that is how a card shows "working" vs
// "waiting for you". The terminal itself lives in the Agents layout (kept mounted). The sessions
// belong to the open folder and are kept in localStorage per folder: after a reload, a folder
// switch or an app restart (the kingu-ptyd daemon keeps the CLIs running) each one whose PTY is
// still alive re-attaches under `cliKey`; the others are gone, and the user continues the task.
// A CLI that quits without its SessionEnd hook (Ctrl-C, a crash) is found through the PTY list
// (`reconcile`, fed by paneAgents.svelte.ts) and ends; its terminal title is status evidence too.

import { invoke } from '@tauri-apps/api/core';
import { killPty } from '#lib/terminal/pty.ts';
import { cliKey, liveCliSessions, parseCliSessions, persist, restore, storeName } from '#lib/terminal/sessions.ts';
import { isWorking } from './agentCli';
import { applyHook, initialHookState, type HookState } from './agentHooks';
import { checkLiveness, type Liveness, type PtyListing } from './agentPresence';
import { applyTitle, type TitleTrack } from './agentTitle';
import { pasteText, profileOf, promptDue } from '#lib/ade/agentProfiles.ts';
import { askKeysFor, isComplete, typeAskKeys, type AskSelection } from '#lib/agent/ask.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { clientLog } from '#lib/client-log.ts';
import { t } from '#lib/i18n/index.ts';

/** `hookToken`: the session reports its state through Claude Code hooks (claude CLIs). */
export type CliSession = { run: string[]; startedAt: number; hookToken?: string };

/** Per folder in localStorage (`storeName(CLI_SESSIONS_STORE, rootTag(root))`); projects.svelte.ts reads other folders'. */
export const CLI_SESSIONS_STORE = 'kingu.cliSessions';
const STORE = CLI_SESSIONS_STORE;

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
	/** Each session's terminal title as status evidence (agentTitle.ts). */
	titles = $state<Record<string, TitleTrack>>({});
	/** Each session's process liveness from the PTY list (agentPresence.ts). */
	#live: Record<string, Liveness> = {};

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
		// Orca removes its managed hooks when status hooks are turned off (never at startup).
		let statusHooks: boolean | undefined;
		$effect.root(() => {
			$effect(() => {
				const on = settings.get<boolean>('kingu.agent.statusHooks') !== false;
				if (statusHooks === true && !on) void invoke('agent_status_hooks_remove').catch((e) => clientLog('error', `remove status hooks: ${e}`));
				statusHooks = on;
			});
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
		this.titles = {};
		this.#live = {};
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
		this.titles = {};
		this.#live = {};
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
		delete this.titles[slug];
		delete this.#live[slug];
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
		delete this.titles[slug];
		delete this.#live[slug];
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

	/**
	 * Ctrl-C into the task's running CLI: stops the current turn; the session stays open for the
	 * next follow-up. False when no CLI runs or the write fails.
	 */
	async interrupt(slug: string): Promise<boolean> {
		const key = this.key(slug);
		if (!key) return false;
		try {
			await invoke('pty_write', { key, data: '\x03' });
			this.#last[slug] = Date.now();
			return true;
		} catch (e) {
			status.flash(t('ade.cli.sendFailed', { error: String(e) }), 8000);
			return false;
		}
	}

	/**
	 * Types `text` into the task's running CLI as one bracketed paste, then Enter apart from it
	 * (Orca's guarded paste-then-submit). False when no CLI runs or the write fails.
	 */
	async send(slug: string, text: string): Promise<boolean> {
		const key = this.key(slug);
		if (!key) return false;
		try {
			await invoke('pty_write', { key, data: pasteText(text) });
			await new Promise((r) => setTimeout(r, 300));
			await invoke('pty_write', { key, data: '\r' });
			return true;
		} catch (e) {
			status.flash(t('ade.cli.sendFailed', { error: String(e) }), 8000);
			return false;
		}
	}

	/**
	 * Quick reply: answers the question the task's CLI is asking (its hook state's `ask`) by typing
	 * into that task's own CLI terminal — the keystrokes its question UI takes (ask.ts). Stops if
	 * the session changes meanwhile. False when there is no open question or the typing failed.
	 */
	async answer(slug: string, selections: AskSelection[]): Promise<boolean> {
		const s = this.sessions[slug];
		const hook = this.hooks[slug];
		if (!s || !hook?.question || hook.phase !== 'waiting' || !hook.ask || !isComplete(hook.ask, selections)) return false;
		const key = this.ptyKey(slug, s.startedAt);
		const groups = askKeysFor(profileOf(s.run).id, hook.ask, selections);
		try {
			const done = await typeAskKeys(groups, {
				write: (data) => invoke('pty_write', { key, data }),
				paste: pasteText,
				wait: (ms) => new Promise((r) => setTimeout(r, ms)),
				live: () => this.key(slug) === key
			});
			if (!done) return false;
		} catch (e) {
			status.flash(t('ade.cli.answerFailed', { error: String(e) }), 8000);
			return false;
		}
		// The CLI's next hook event takes over; until then the question is answered.
		const now = this.hooks[slug];
		if (now?.question) this.hooks[slug] = { ...now, phase: 'working', question: false, ask: undefined, message: t('ade.cli.answered'), at: Date.now() };
		this.#last[slug] = Date.now();
		return true;
	}

	/** Output arrived (throttled: one state write per 500ms per task). */
	output(slug: string) {
		this.#sawOutput.add(slug);
		const t = Date.now();
		if (t - (this.#last[slug] ?? 0) > 500) this.#last[slug] = t;
	}

	/** The terminal's title changed (OSC 0/2). */
	title(slug: string, title: string) {
		if (!this.sessions[slug]) return;
		this.titles[slug] = applyTitle(this.titles[slug], title, Date.now());
	}

	/**
	 * One PTY listing: a session whose shell is back in front (the CLI quit without its SessionEnd
	 * hook) or gone ends, the way Orca retires a row whose process is certifiably dead.
	 */
	reconcile(list: readonly PtyListing[], foregroundKnown: boolean) {
		const byKey = new Map(list.map((p) => [p.key, p]));
		const now = Date.now();
		for (const [slug, s] of Object.entries(this.sessions)) {
			const was = this.#live[slug];
			const next = checkLiveness(was, byKey.get(this.ptyKey(slug, s.startedAt)), now, foregroundKnown);
			this.#live[slug] = next;
			if (next.ended && !was?.ended && this.hooks[slug]?.phase !== 'ended') {
				clientLog('info', `agent CLI of ${slug} exited without a SessionEnd hook`);
				this.hooks[slug] = applyHook(this.hooks[slug] ?? initialHookState(now), { kingu_hook: 'kingu', event: 'ProcessExit' }, now);
			}
		}
	}

	/** The session's CLI has ended (SessionEnd hook, or its process is gone); its terminal may still show the shell. */
	ended(slug: string): boolean {
		return this.hooks[slug]?.phase === 'ended';
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
				// A CLI whose process is gone reports nothing more.
				if (!s.hookToken || this.#live[slug]?.ended) continue;
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
		if (!key) throw new Error(t('ade.cli.noneRunning'));
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
