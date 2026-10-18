// Agent CLIs running in task terminals (the Orca way): which task has one, the command it was
// started with, and when it last printed something — that is how a card shows "working" vs
// "waiting for you". The terminal itself lives in the Agents layout (kept mounted). The sessions
// survive a webview reload (sessionStorage) and their terminals re-attach under `cliKey`; after an
// app restart there are none, so the user continues a task's CLI explicitly.

import { killPty } from '#lib/terminal/pty.ts';
import { cliKey, parseCliSessions, persist, restore } from '#lib/terminal/sessions.ts';
import { isWorking } from './agentCli';

export type CliSession = { run: string[]; startedAt: number };

const STORE = 'kingu.cliSessions';

class CliSessions {
	sessions = $state<Record<string, CliSession>>({});
	#last = $state<Record<string, number>>({});
	/** Ticks every second while a CLI runs, so "working" turns into "waiting" without new output. */
	now = $state(Date.now());
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor() {
		const saved = restore(STORE, parseCliSessions);
		if (saved) this.sessions = saved;
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

	start(slug: string, run: string[]) {
		const old = this.sessions[slug];
		if (old) killPty(cliKey(slug, old.startedAt));
		// A new key even within the same millisecond: Rust never re-types `run` for a key it has seen.
		this.sessions[slug] = { run, startedAt: Math.max(Date.now(), (old?.startedAt ?? 0) + 1) };
		this.#last[slug] = Date.now();
		this.#tick();
	}

	end(slug: string) {
		const key = this.key(slug);
		if (key) killPty(key);
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

	#tick() {
		const any = Object.keys(this.sessions).length > 0;
		if (any && !this.#timer) this.#timer = setInterval(() => (this.now = Date.now()), 1000);
		else if (!any && this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}
}

export const cliSessions = new CliSessions();
