// TaskRuntime adapter. Today agent runs live in the webview: `agent_start` streams the runner's
// events over a Channel and this module keeps them per task slug. The rest of the ADE reads only
// `runtime.get / events / isRunning / start / stop`, so moving to the sidecar agent host's
// reactive `agents` store means rewriting this one file against that store.

import { Channel, invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import type { AgentEvent } from '#lib/agent/events.ts';
import { reduceRun, startRun, type RunState, type RuntimeEvent, type TaskRuntime } from './model';

type Run = RunState & { id?: number; events: RuntimeEvent[] };

/** The timeline keeps the latest events only; tool results are already truncated in Rust. */
const MAX_EVENTS = 2000;

class Runtime {
	#runs = $state<Record<string, Run>>({});

	get(slug: string): TaskRuntime | undefined {
		return this.#runs[slug]?.runtime;
	}

	/** Events of the latest run of `slug` (empty when it has not run since the app started). */
	events(slug: string): AgentEvent[] {
		return (this.#runs[slug]?.events ?? []).filter((e): e is AgentEvent => e.kind !== 'permission_request' && e.kind !== 'permission_resolved');
	}

	isRunning(slug: string): boolean {
		const s = this.get(slug)?.status;
		return s === 'running' || s === 'waiting';
	}

	all(): TaskRuntime[] {
		return Object.values(this.#runs).map((r) => r.runtime);
	}

	/** Starts the agent in the task worktree (which must exist). A new run replaces the old timeline. */
	async start(slug: string, prompt: string): Promise<void> {
		if (this.isRunning(slug)) throw new Error(`${slug}: กำลังทำงานอยู่`);
		this.#runs[slug] = { ...startRun(slug, Date.now()), events: [] };
		const onEvent = new Channel<AgentEvent>();
		onEvent.onmessage = (ev) => this.#push(slug, ev);
		try {
			const id = await invoke<number>('agent_start', { slug, prompt, onEvent });
			const run = this.#runs[slug];
			if (run) run.id = id;
			clientLog('info', `agent run ${id} started for ${slug}`);
		} catch (e) {
			this.#push(slug, { kind: 'stderr', line: String(e) });
			this.#push(slug, { kind: 'exit', code: null, signal: null, stopped: false });
			throw e;
		}
	}

	async stop(slug: string): Promise<void> {
		const id = this.#runs[slug]?.id;
		if (id !== undefined && this.isRunning(slug)) await invoke('agent_stop', { id });
	}

	/** A folder switch: runs belong to the old folder's tasks. */
	reset() {
		this.#runs = {};
	}

	#push(slug: string, ev: RuntimeEvent) {
		const run = this.#runs[slug];
		if (!run) return;
		const next = reduceRun(run, ev, Date.now());
		run.runtime = next.runtime;
		run.failed = next.failed;
		run.pending = next.pending;
		run.events.push(ev);
		if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
		if (ev.kind === 'exit') run.id = undefined;
	}
}

export const runtime = new Runtime();
