// Agent CLIs running in task terminals (the Orca way): which task has one, the command it was
// started with, and when it last printed something — that is how a card shows "working" vs
// "waiting for you". The terminal itself lives in the Agents layout (kept mounted).

import { isWorking } from './agentCli';

export type CliSession = { run: string[]; startedAt: number };

class CliSessions {
	sessions = $state<Record<string, CliSession>>({});
	#last = $state<Record<string, number>>({});
	/** Ticks every second while a CLI runs, so "working" turns into "waiting" without new output. */
	now = $state(Date.now());
	#timer: ReturnType<typeof setInterval> | undefined;

	start(slug: string, run: string[]) {
		this.sessions[slug] = { run, startedAt: Date.now() };
		this.#last[slug] = Date.now();
		this.#tick();
	}

	end(slug: string) {
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
