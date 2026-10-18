// Live usage state: Claude's rate-limit windows, updated from every agent run's `rate_limit_event`
// and kept across restarts (until each window resets), plus Kingu's spend from saved runs.
//   usage.start()      subscribe to agent events and tick the clock; returns a stop function
//   usage.windows      live windows, in Claude's order
//   usage.spend        today / 7 days / per task, from tasks.json

import { agents } from '#lib/agent/agents.svelte.ts';
import { adeTasks } from '#lib/ade/tasks.svelte.ts';
import { liveWindows, parseRateLimit, spend, type LimitId, type LimitWindow } from './usage';

const KEY = 'kingu.usage.windows';

function load(): Partial<Record<LimitId, LimitWindow>> {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
	} catch {
		return {};
	}
}

class Usage {
	now = $state(Date.now());
	#all = $state<Partial<Record<LimitId, LimitWindow>>>(load());

	windows = $derived(liveWindows(Object.values(this.#all), this.now));
	/** Unix ms of the newest rate-limit event, or null before the first run. */
	updatedAt = $derived(this.windows.reduce<number | null>((t, w) => Math.max(t ?? 0, w.seenAt), null));
	spend = $derived(spend(adeTasks.list.map((t) => ({ slug: t.slug, title: t.title, last_run: t.last_run })), this.now));

	record(w: LimitWindow) {
		this.#all[w.id] = w;
		try {
			localStorage.setItem(KEY, JSON.stringify(this.#all));
		} catch {
			// Private mode or full storage: the windows just do not survive a restart.
		}
	}

	start(): () => void {
		const off = agents.onEvent((_, ev) => {
			if (ev.kind !== 'raw') return;
			const w = parseRateLimit(ev.line, Date.now());
			if (w) this.record(w);
		});
		const timer = setInterval(() => (this.now = Date.now()), 30_000);
		return () => (off(), clearInterval(timer));
	}
}

export const usage = new Usage();
