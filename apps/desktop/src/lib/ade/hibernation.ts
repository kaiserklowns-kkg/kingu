// Agent hibernation (Orca's experimentalAgentHibernation, kingu.agent.hibernation): an agent CLI
// that finished its turn and has sat idle for `kingu.agent.hibernationIdleMinutes` is closed to
// free its process and memory, and its task continues the same session with one click. Which CLIs
// may go is decided here, the way Orca's planner does: a finished turn (not waiting on you), a
// session the CLI can resume, nothing printed and not on screen for the whole idle time. Pure.

export const DEFAULT_IDLE_MINUTES = 30;
export const MIN_IDLE_MINUTES = 1;
export const MAX_IDLE_MINUTES = 24 * 60;
/** How often the coordinator looks (Orca's AGENT_HIBERNATION_TICK_MS). */
export const TICK_MS = 60_000;

/** The idle time in ms; a missing or out-of-range setting is the default (Orca's getEffectiveAgentHibernationIdleMs). */
export function idleMs(minutes: unknown): number {
	const m = typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= MIN_IDLE_MINUTES && minutes <= MAX_IDLE_MINUTES ? minutes : DEFAULT_IDLE_MINUTES;
	return m * 60_000;
}

/** One running agent CLI as the planner sees it. */
export type HibernationRow = {
	slug: string;
	/** The CLI's hook state: `idle` once a turn finished (agentHooks.ts); undefined without hooks. */
	phase?: string;
	/** Waiting on a permission answer or a question. */
	waiting: boolean;
	/** The CLI process ended already (its terminal shows the shell). */
	ended: boolean;
	/** The task has a saved session id and its CLI can resume it. */
	resumable: boolean;
	/** The CLI's terminal is on screen now. */
	foreground: boolean;
	/** Unix ms: the latest hook event, the latest output, the last time it was on screen. */
	hookAt?: number;
	outputAt?: number;
	seenAt?: number;
};

/**
 * The CLIs to close now. The idle time counts from the latest of: the turn's end (hook event),
 * the last output (a draft typed into the TUI echoes, so it counts too) and the last time the
 * terminal was on screen.
 */
export function hibernationCandidates(rows: readonly HibernationRow[], now: number, idle: number): string[] {
	return rows
		.filter((r) => {
			if (r.phase !== 'idle' || r.waiting || r.ended || !r.resumable || r.foreground) return false;
			const since = Math.max(r.hookAt ?? 0, r.outputAt ?? 0, r.seenAt ?? 0);
			return since > 0 && now - since >= idle;
		})
		.map((r) => r.slug)
		.sort();
}
