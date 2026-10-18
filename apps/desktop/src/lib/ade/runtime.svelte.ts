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
import { profileOf } from '#lib/ade/agentProfiles.ts';
import { cliSessions } from './cliSessions.svelte';
import { needsInput } from './agentHooks';
import { hookFresh, withPaneAgents } from './agentPresence';
import { paneAgents } from './paneAgents.svelte';
import { t } from '#lib/i18n/index.ts';

/**
 * A task whose agent CLI runs in a terminal. Status evidence, best first (Orca's order): hooks
 * that report (and have not gone silent while "working" for 30 minutes), then the terminal's
 * title (spinner / idle glyphs), then "printing = working". A CLI whose process is gone has ended.
 */
function cliRuntime(slug: string): TaskRuntime | undefined {
	const s = cliSessions.sessions[slug];
	if (!s) return;
	// claude reports its state through hooks, and so do CLIs with Kingu's status hooks once their
	// hooks report; before that (or without them) the title, else output (codex's notify adds the
	// session id and the turn's last answer).
	const hook = cliSessions.hooks[slug];
	const now = cliSessions.now;
	if (hook && hook.phase !== 'starting' && (profileOf(s.run).status === 'hooks' || hook.hooks) && hookFresh(hook, now)) {
		const working = hook.phase === 'working';
		const attention = needsInput(hook);
		return {
			slug,
			status: attention ? 'waiting' : working ? 'running' : 'review',
			runStatus: attention ? 'waiting' : working ? 'running' : hook.phase === 'ended' ? 'done' : 'idle',
			live: hook.phase !== 'ended',
			working,
			lastEvent: hook.message,
			pendingPermissions: hook.permission && hook.phase === 'waiting' ? 1 : 0,
			question: hook.question && hook.phase === 'waiting',
			sessionId: hook.sessionId ?? null,
			updatedAt: hook.at
		};
	}
	const title = cliSessions.titles[slug];
	if (title?.status) {
		const working = title.status === 'working';
		const attention = title.status === 'permission';
		return {
			slug,
			status: attention ? 'waiting' : working ? 'running' : 'review',
			runStatus: attention ? 'waiting' : working ? 'running' : 'idle',
			live: true,
			working,
			lastEvent: t(attention ? 'ade.cli.needsAnswer' : working ? 'ade.cli.working' : 'ade.cli.waiting', { cli: cliName(s.run) }),
			pendingPermissions: attention ? 1 : 0,
			sessionId: hook?.sessionId ?? null,
			updatedAt: Math.max(title.at, cliSessions.lastOutput(slug) ?? 0)
		};
	}
	const working = cliSessions.working(slug);
	return {
		slug,
		status: working ? 'running' : 'review',
		runStatus: working ? 'running' : 'idle',
		live: true,
		working,
		lastEvent: working ? t('ade.cli.working', { cli: cliName(s.run) }) : (hook?.message ?? t('ade.cli.waiting', { cli: cliName(s.run) })),
		pendingPermissions: 0,
		sessionId: hook?.sessionId ?? null,
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

	/** The task's launched agent (timeline run, else its CLI), with the agents of its other terminal panes. */
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
	start(slug: string, prompt: string, resume: string | null = null, images: string[] = []): Promise<void> {
		this.#touched[slug] = Date.now();
		return agents.start(slug, prompt, { root: workspace.root ?? undefined, resume, images });
	}

	/**
	 * Follow-up: sent to the open session, else resumes the run's session (or `savedSession` from
	 * tasks.json after a restart), else starts fresh.
	 */
	async followUp(slug: string, text: string, savedSession: string | null, images: string[] = []): Promise<void> {
		const plan = followUpPlan(this.run(slug), savedSession);
		this.#touched[slug] = Date.now();
		if (plan.kind === 'send') await agents.send(slug, text, images);
		else await this.start(slug, text, plan.resume, images);
	}

	answer(slug: string, requestId: string, decision: Decision, message?: string, answers?: Record<string, string>): Promise<void> {
		return agents.answer(slug, requestId, decision, message, answers);
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
