// What the program in each ADE terminal pane reports about itself (OSC 7501, Orca's program
// status): the tab row draws it as a progress ring or a state glyph. Per PTY key, live only (a
// reload starts empty, like Orca's facets). Pure decisions live in programStatus.ts.

import { adeLayout } from './adeLayout.svelte';
import { tabPanes } from './adeTabs';
import { paneAgents } from './paneAgents.svelte';
import { agentRingProgress, programIndicator, reduceProgram, type ProgramEvent, type ProgramFacet, type ProgramIndicator } from './programStatus';

/** Staleness is 30 minutes, so a coarse clock is enough. */
const TICK_MS = 60_000;

class PaneProgram {
	/** Per PTY key of an ADE terminal pane. */
	facets = $state<Record<string, ProgramFacet>>({});
	now = $state(Date.now());
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor() {
		if (typeof window !== 'undefined') this.#timer = setInterval(() => this.#tick(), TICK_MS);
	}

	/** A pane's terminal read a report, started a new prompt, was reset, or the user typed in it. */
	apply(key: string, event: ProgramEvent) {
		const prev = this.facets[key];
		const next = reduceProgram(prev, event, Date.now());
		if (next === prev) return;
		if (next) this.facets[key] = next;
		else delete this.facets[key];
	}

	/** The shell of a task pane is back in front (paneAgents polls the PTY list): its program exited. */
	#atPrompt = (key: string) => paneAgents.panes[key]?.foreground === null;

	/**
	 * What a terminal tab without an agent shows for its program. A tab with split panes shows its
	 * most urgent one (needs you, working, failed, done), the latest report among equals.
	 */
	tab(slug: string, tabId: string): ProgramIndicator | undefined {
		const tab = (adeLayout.terminals[slug] ?? []).find((t) => t.id === tabId);
		if (!tab) return undefined;
		const now = Math.max(this.now, paneAgents.now);
		let best: { i: ProgramIndicator; at: number } | undefined;
		for (const pane of tabPanes(tab)) {
			const key = adeLayout.ptyKey(slug, pane);
			const f = this.facets[key];
			const i = programIndicator(f, now, this.#atPrompt(key));
			if (!f || !i) continue;
			if (!best || RANK[i.status] < RANK[best.i.status] || (RANK[i.status] === RANK[best.i.status] && f.observedAt > best.at)) best = { i, at: f.observedAt };
		}
		return best?.i;
	}

	/** The percentage the state glyph of the agent in pane `key` becomes a ring for, if any. */
	agentProgress(key: string, rowState: 'working' | 'permission' | 'question' | 'idle'): number | undefined {
		return agentRingProgress(rowState, this.facets[key], Math.max(this.now, paneAgents.now));
	}

	#tick() {
		this.now = Date.now();
		// Panes that were closed take their record along.
		const open = new Set(adeLayout.ptyKeys());
		for (const key of Object.keys(this.facets)) if (!open.has(key)) delete this.facets[key];
	}

	dispose() {
		clearInterval(this.#timer);
	}
}

const RANK: Record<ProgramIndicator['status'], number> = { permission: 0, working: 1, failed: 2, done: 3 };

export const paneProgram = new PaneProgram();
