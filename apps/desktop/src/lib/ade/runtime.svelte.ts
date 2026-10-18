// TaskRuntime adapter over the agent host's `agents` store (agent/agents.svelte.ts), the single
// source of truth for agent runs. The ADE reads tasks' live state only through this module:
// `get` maps a run to a TaskRuntime (pure mapping in model.ts), `run` hands the timeline the run
// itself, and the actions forward to the store. Runs belong to a workspace root; only runs of
// the open folder are visible here (others keep streaming in the store).

import { agents, type AgentRun } from '#lib/agent/agents.svelte.ts';
import type { Decision } from '#lib/agent/events.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { followUpPlan, toTaskRuntime, type TaskRuntime } from './model';
import { cliName } from './agentCli';
import { cliSessions } from './cliSessions.svelte';

/** A task whose agent CLI runs in a terminal: working while it prints, else waiting for you. */
function cliRuntime(slug: string): TaskRuntime | undefined {
	const s = cliSessions.sessions[slug];
	if (!s) return;
	// claude reports its state through hooks; other CLIs fall back to "printing = working".
	const hook = cliSessions.hooks[slug];
	if (hook && hook.phase !== 'starting') {
		const working = hook.phase === 'working';
		return {
			slug,
			status: hook.permission ? 'waiting' : working ? 'running' : 'review',
			runStatus: hook.permission ? 'waiting' : working ? 'running' : hook.phase === 'ended' ? 'done' : 'idle',
			live: hook.phase !== 'ended',
			working,
			lastEvent: hook.message,
			pendingPermissions: hook.permission ? 1 : 0,
			sessionId: hook.sessionId ?? null,
			updatedAt: hook.at
		};
	}
	const working = cliSessions.working(slug);
	return {
		slug,
		status: working ? 'running' : 'review',
		runStatus: working ? 'running' : 'idle',
		live: true,
		working,
		lastEvent: working ? `${cliName(s.run)} กำลังทำงานใน terminal` : `${cliName(s.run)} รอคุณใน terminal`,
		pendingPermissions: 0,
		sessionId: null,
		updatedAt: cliSessions.lastOutput(slug)
	};
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

	get(slug: string): TaskRuntime | undefined {
		const r = this.run(slug);
		if (r) return toTaskRuntime(r, this.#touched[slug] ?? r.startedAt);
		return cliRuntime(slug);
	}

	all(): TaskRuntime[] {
		return agents.list.filter((r) => r.root === workspace.root).map((r) => toTaskRuntime(r, this.#touched[r.slug] ?? r.startedAt));
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

	/** Starts the agent in the task worktree (which must exist); model and permission mode come from settings. */
	start(slug: string, prompt: string, resume: string | null = null): Promise<void> {
		this.#touched[slug] = Date.now();
		return agents.start(slug, prompt, { root: workspace.root ?? undefined, resume });
	}

	/**
	 * Follow-up: sent to the open session, else resumes the run's session (or `savedSession` from
	 * tasks.json after a restart), else starts fresh.
	 */
	async followUp(slug: string, text: string, savedSession: string | null): Promise<void> {
		const plan = followUpPlan(this.run(slug), savedSession);
		this.#touched[slug] = Date.now();
		if (plan.kind === 'send') await agents.send(slug, text);
		else await this.start(slug, text, plan.resume);
	}

	answer(slug: string, requestId: string, decision: Decision, message?: string): Promise<void> {
		return agents.answer(slug, requestId, decision, message);
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
