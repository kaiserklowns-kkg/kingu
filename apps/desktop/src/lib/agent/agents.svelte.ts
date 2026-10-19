/**
 * `agents` — reactive store of agent runs, one per task (worktree slug), owned by the app rather
 * than a panel, so runs keep streaming while the Agent panel is closed or another folder is open.
 *
 *   agents.get(slug)          AgentRun | undefined   latest run of that task (state: see RunState in events.ts)
 *   agents.list               AgentRun[]             all runs, newest first (filter by `root` for the open folder)
 *   agents.pendingCount       number                 unanswered permission requests across all runs
 *   agents.start(slug, prompt, { root?, resume? })   start a run in `<root>/.kingu/worktrees/<slug>` (must exist);
 *                                                    model/permission mode come from settings `kingu.agent.*`
 *   agents.send(slug, text)   follow-up; restarts the task's last session (resume) if its run has ended
 *   agents.answer(slug, requestId, decision, message?, answers?)   decision: 'allow' | 'allow_always' | 'deny'; answers: an AskUserQuestion's (question → answer)
 *   agents.interrupt(slug)    stop the current turn, keep the session
 *   agents.stop(slug)         end the run
 *   agents.onEvent(fn)        (slug, event) for every event of every run; returns an unsubscribe
 */

import { mcpServers, skillPlugins } from '#lib/ade/mcp.ts';
import { worktreeDir } from '#lib/ade/keys.ts';
import { Channel, invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { applyEvent, initialRun, type AgentEvent, type Decision, type RunState } from './events';

export type AgentRun = RunState & {
	slug: string;
	/** Workspace root the task's worktree belongs to. */
	root: string;
	/** Rust run id; undefined until started. */
	runId: number | undefined;
	startedAt: number;
};

type Listener = (slug: string, ev: AgentEvent) => void;

class Agents {
	runs = $state<Record<string, AgentRun>>({});
	list = $derived(Object.values(this.runs).sort((a, b) => b.startedAt - a.startedAt));
	pendingCount = $derived(Object.values(this.runs).reduce((n, r) => n + r.pending.length, 0));

	#listeners = new Set<Listener>();

	get(slug: string): AgentRun | undefined {
		return this.runs[slug];
	}

	onEvent(fn: Listener): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	/** `model`: this run's model instead of `kingu.agent.model` (a best-of-N attempt's). */
	async start(slug: string, prompt: string, opts: { root?: string; resume?: string | null; images?: string[]; model?: string | null } = {}): Promise<void> {
		const prev = this.runs[slug];
		if (prev && !prev.ended) throw new Error(t('team.agent.alreadyRunning', { slug }));
		const root = opts.root ?? workspace.root;
		if (!root) throw new Error(t('team.agent.noFolder'));
		const resume = opts.resume === undefined ? null : opts.resume;
		// Keep the earlier timeline when continuing the same session.
		const run: AgentRun = { ...initialRun(), slug, root, runId: undefined, startedAt: Date.now() };
		if (resume && prev) {
			run.items = prev.items;
			run.sessionId = prev.sessionId;
			run.result = prev.result;
		}
		this.runs[slug] = run;
		const state = this.runs[slug]; // the reactive proxy
		const mcp = mcpServers(`${root}/${worktreeDir(slug)}`);
		const plugins = await skillPlugins();
		const onEvent = new Channel<AgentEvent>();
		onEvent.onmessage = (ev) => {
			applyEvent(state, ev);
			for (const fn of this.#listeners) fn(slug, ev);
		};
		try {
			state.runId = await invoke<number>('agent_start', {
				slug,
				prompt,
				model: opts.model || settings.get<string>('kingu.agent.model'),
				permissionMode: settings.get<string>('kingu.agent.permissionMode'),
				resume,
				mcpServers: Object.keys(mcp).length ? mcp : null,
				plugins: plugins.length ? plugins : null,
				images: opts.images?.length ? opts.images : null,
				onEvent
			});
			clientLog('info', `agent run ${state.runId} started for ${slug}`);
		} catch (e) {
			applyEvent(state, { kind: 'error', message: String(e) });
			applyEvent(state, { kind: 'exit', code: null, signal: null, stopped: false });
			throw e;
		}
	}

	/** `images`: image files sent with the message (Composer attachments). */
	async send(slug: string, text: string, images: string[] = []): Promise<void> {
		const run = this.runs[slug];
		if (!run) throw new Error(`${slug}: no run`);
		if (run.ended) return this.start(slug, text, { root: run.root, resume: run.sessionId, images });
		if (run.runId === undefined) throw new Error(t('team.agent.stillStarting'));
		await invoke('agent_send', { runId: run.runId, text, images: images.length ? images : null });
	}

	async answer(slug: string, requestId: string, decision: Decision, message?: string, answers?: Record<string, string>): Promise<void> {
		const run = this.runs[slug];
		if (run?.runId === undefined) return;
		await invoke('agent_answer_permission', { runId: run.runId, requestId, decision, message: message?.trim() || null, answers: answers ?? null });
	}

	async interrupt(slug: string): Promise<void> {
		const run = this.runs[slug];
		if (run?.runId !== undefined && !run.ended) await invoke('agent_interrupt', { runId: run.runId });
	}

	async stop(slug: string): Promise<void> {
		const run = this.runs[slug];
		if (run?.runId !== undefined && !run.ended) await invoke('agent_stop', { runId: run.runId });
	}

	/** Forgets an ended run (e.g. after its worktree is removed). */
	forget(slug: string) {
		if (this.runs[slug]?.ended) delete this.runs[slug];
	}
}

export const agents = new Agents();
