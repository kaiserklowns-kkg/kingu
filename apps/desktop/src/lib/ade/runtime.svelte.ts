// TaskRuntime adapter for the ADE: a task's live state comes from its agent CLI terminal
// (cliRuntime.ts) plus the agents of its other terminal panes. `get` maps that evidence to a
// TaskRuntime (pure mapping in model.ts). The legacy agent-host runs in the `agents` store are
// still observed so a task saved by an older Kingu timeline can be stopped or removed; ADE never
// starts one. Runs belong to a workspace root; only runs of the open folder are visible here.

import { agents, type AgentRun } from '#lib/agent/agents.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { toTaskRuntime, type TaskRuntime } from './model';
import { cliSessions } from './cliSessions.svelte';
import { cliTaskRuntime } from './cliRuntime';
import { withPaneAgents } from './agentPresence';
import { paneAgents } from './paneAgents.svelte';

/** A task whose agent CLI runs in a terminal of the open folder (evidence order: cliRuntime.ts). */
function cliRuntime(slug: string): TaskRuntime | undefined {
	const s = cliSessions.sessions[slug];
	if (!s) return;
	return cliTaskRuntime(slug, {
		run: s.run,
		hook: cliSessions.hooks[slug],
		title: cliSessions.titles[slug],
		working: cliSessions.working(slug),
		lastOutput: cliSessions.lastOutput(slug),
		now: cliSessions.now
	});
}

class Runtime {
	/** Unix ms of each task's latest event (the store does not timestamp events). */
	#touched = $state<Record<string, number>>({});

	constructor() {
		agents.onEvent((slug) => {
			this.#touched[slug] = Date.now();
		});
	}

	/** The latest run of `slug` in the open folder. */
	run(slug: string): AgentRun | undefined {
		const r = agents.get(slug);
		return r && r.root === workspace.root ? r : undefined;
	}

	/** The task's launched agent (legacy host run, else its CLI), with the agents of its other terminal panes. */
	get(slug: string): TaskRuntime | undefined {
		return withPaneAgents(slug, this.#own(slug), paneAgents.rows(slug));
	}

	#own(slug: string): TaskRuntime | undefined {
		const r = this.run(slug);
		if (r) return toTaskRuntime(r, this.#touched[slug] ?? r.startedAt);
		return cliRuntime(slug);
	}

	/** A turn of the task's timeline run is in progress (it must be stopped before the task goes). */
	timelineWorking(slug: string): boolean {
		const r = this.run(slug);
		return !!r && toTaskRuntime(r, r.startedAt).working;
	}

	/** The session is open (the task's worktree is in use). */
	isLive(slug: string): boolean {
		const r = this.run(slug);
		return !!r && !r.ended;
	}

	/** A turn is in progress or waiting for a permission answer. */
	isWorking(slug: string): boolean {
		return this.get(slug)?.working ?? false;
	}

	interrupt(slug: string): Promise<void> {
		return agents.interrupt(slug);
	}

	stop(slug: string): Promise<void> {
		return agents.stop(slug);
	}

	forget(slug: string) {
		if (this.run(slug)) agents.forget(slug);
		delete this.#touched[slug];
	}
}

export const runtime = new Runtime();
