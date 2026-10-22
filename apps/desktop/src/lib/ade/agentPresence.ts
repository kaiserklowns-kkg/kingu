// Whether an agent still runs, and what every agent of a task is doing (Orca's ended-process
// reconciliation, agent-status freshness and per-pane agent rows). Pure, so `bun test` covers it.
//
// - Liveness: the PTY list (`pty_list`) says whether a terminal's shell is alive and which job is
//   in front of it. A CLI that crashed, was Ctrl-C'd or OOM-killed never sends its SessionEnd
//   hook, but its shell comes back to the front (or the shell itself is gone): the agent ended.
// - Freshness: a hook state that says "working" with no event for 30 minutes is not trusted.
// - Rows: an agent in any terminal pane of a task's worktree (hooks, the terminal title, or
//   output timing) is one row; the task's status takes the most urgent row.

import type { HookState } from './agentHooks';
import { needsInput } from './agentHooks';
import { isWorking } from './agentCli';
import type { TitleTrack } from './agentTitle';
import type { TaskRuntime, TaskStatus } from './model';
import { t } from '#lib/i18n/index.ts';

/** One entry of `pty_list`. */
export type PtyListing = { key: string; alive: boolean; foreground?: { pid: number; name: string } | null };

/**
 * One terminal's liveness. `listedAt`: when the PTY list first had the key (a terminal mounted
 * hidden spawns its shell only once shown); `seen`: a job was in front of the shell (the CLI ran).
 */
export type Liveness = { listedAt?: number; seen: boolean; misses: number; ended: boolean };

/** A new shell types its CLI within this long; until then an idle shell is not an exit. */
export const EXIT_GRACE_MS = 15_000;
/** Polls in a row with the shell in front (or gone) before the agent counts as ended. */
export const EXIT_MISSES = 2;

/**
 * The next liveness of a terminal from one PTY listing (`info` undefined: not in the list).
 * `foregroundKnown`: the platform reports the foreground job (not Windows).
 */
export function checkLiveness(prev: Liveness | undefined, info: PtyListing | undefined, now: number, foregroundKnown = true): Liveness {
	const l: Liveness = prev ?? { seen: false, misses: 0, ended: false };
	if (l.ended) return l;
	if (!info) {
		// Never listed yet: the shell has not been spawned (a hidden terminal), not an exit.
		if (l.listedAt === undefined) return l;
		return miss(l);
	}
	const listedAt = l.listedAt ?? now;
	if (!info.alive) return { ...l, listedAt, ended: true };
	if (info.foreground) return { listedAt, seen: true, misses: 0, ended: false };
	if (!foregroundKnown || (!l.seen && now - listedAt < EXIT_GRACE_MS)) return { ...l, listedAt };
	return miss({ ...l, listedAt });
}

const miss = (l: Liveness): Liveness => {
	const misses = l.misses + 1;
	return { ...l, misses, ended: misses >= EXIT_MISSES };
};

/** Orca's AGENT_STATUS_STALE_AFTER_MS: "working" decays when the hook stream goes silent this long. */
export const STALE_AFTER_MS = 30 * 60_000;

/** A hook state that may still be trusted: not a "working" left over from a silent (likely dead) agent. */
export const hookFresh = (h: HookState, now: number) => !(h.phase === 'working' && now - h.at > STALE_AFTER_MS);

export type AgentRowState = 'working' | 'permission' | 'question' | 'idle';
/** One agent of a task: the launched CLI or one found in another terminal pane. */
export type AgentRow = {
	/** The PTY key of its terminal. */
	id: string;
	/** `claude`, `gemini`, … (lower case) when known. */
	agent: string | null;
	state: AgentRowState;
	message?: string;
	/** Unix ms of its latest evidence. */
	at: number;
};

/** What Kingu knows about one terminal pane of a task's worktree. */
export type PaneEvidence = {
	id: string;
	/** Hook events from the pane's own hook file (`KINGU_AGENT_HOOK_FILE`). */
	hook?: HookState;
	/** The hook provider that reported (`gemini`, `codex`, …). */
	hookAgent?: string;
	title?: TitleTrack;
	/** The job in front of the shell, null at the prompt, undefined when unknown. */
	foreground?: string | null;
	lastOutput?: number;
};

/** Program names of agent CLIs that report nothing themselves (no hooks, no title): output timing. */
const OUTPUT_AGENTS = new Set(['aider', 'qwen', 'amp', 'goose', 'crush', 'kimi', 'auggie']);

/**
 * The agent row of a pane, or null when no agent runs there: hooks that report (and are fresh)
 * first, then the terminal title, then output timing for a known agent program in front.
 */
export function paneRow(p: PaneEvidence, now: number): AgentRow | null {
	// The shell is back in front: whatever ran there has exited.
	if (p.foreground === null) return null;
	const h = p.hook;
	if (h?.hooks && h.phase !== 'starting' && h.phase !== 'ended' && hookFresh(h, now)) {
		const state: AgentRowState = needsInput(h) ? (h.question ? 'question' : 'permission') : h.phase === 'working' ? 'working' : 'idle';
		return { id: p.id, agent: p.hookAgent ?? p.title?.agent ?? null, state, message: h.message, at: h.at };
	}
	const t = p.title;
	if (t?.status) return { id: p.id, agent: t.agent, state: t.status, at: t.at };
	const name = p.foreground?.toLowerCase();
	if (name && OUTPUT_AGENTS.has(name)) return { id: p.id, agent: name, state: isWorking(p.lastOutput, now) ? 'working' : 'idle', at: p.lastOutput ?? now };
	return null;
}

const RANK: Record<AgentRowState, number> = { permission: 0, question: 0, working: 1, idle: 2 };

/** The most urgent row (needs you > working > idle), latest first among equals. */
export function topRow(rows: readonly AgentRow[]): AgentRow | undefined {
	return [...rows].sort((a, b) => RANK[a.state] - RANK[b.state] || b.at - a.at)[0];
}

const rowStatus = (r: AgentRow): TaskStatus => (r.state === 'permission' || r.state === 'question' ? 'waiting' : r.state === 'working' ? 'running' : 'review');

/**
 * A task's runtime with the agents of its other terminal panes: the launched agent (legacy host
 * run or CLI) stays the base; a pane that needs you or works raises the task's status the way Orca's
 * card takes its most urgent agent. Without a base the panes alone make the runtime.
 */
export function withPaneAgents(slug: string, base: TaskRuntime | undefined, rows: readonly AgentRow[]): TaskRuntime | undefined {
	if (!rows.length) return base;
	const top = topRow(rows)!;
	const status = rowStatus(top);
	const attention = status === 'waiting';
	const working = top.state === 'working';
	if (!base)
		return {
			slug,
			status,
			runStatus: attention ? 'waiting' : working ? 'running' : 'idle',
			live: true,
			working,
			lastEvent: top.message,
			pendingPermissions: top.state === 'permission' ? 1 : 0,
			question: top.state === 'question',
			sessionId: null,
			updatedAt: top.at,
			agents: [...rows]
		};
	const baseRank = base.status === 'waiting' ? 0 : base.working || base.status === 'running' ? 1 : 2;
	const raise = RANK[top.state] < baseRank;
	return {
		...base,
		...(raise
			? {
					status,
					working: base.working || working,
					lastEvent: top.message ?? base.lastEvent,
					pendingPermissions: base.pendingPermissions + (top.state === 'permission' ? 1 : 0),
					question: base.question || top.state === 'question'
				}
			: {}),
		updatedAt: Math.max(base.updatedAt ?? 0, top.at),
		agents: [...rows]
	};
}

const STATE_KEY = { working: 'ade.agentRow.working', permission: 'ade.agentRow.permission', question: 'ade.agentRow.question', idle: 'ade.agentRow.idle' } as const;

/** A row's text on the card: "Claude - Using Bash", or the state when there is no message. */
export function rowText(r: AgentRow): string {
	const name = r.agent ? r.agent.charAt(0).toUpperCase() + r.agent.slice(1) : t('ade.agentRow.unknown');
	return `${name} - ${r.message || t(STATE_KEY[r.state])}`;
}

/** A row's dot in the side bar's status vocabulary (sidebarModel.ts CardStatus). */
export const rowCardStatus = (r: AgentRow): 'working' | 'permission' | 'done' => (r.state === 'working' ? 'working' : r.state === 'idle' ? 'done' : 'permission');

/** Removing a task: a working legacy host run must be stopped first; agents in terminals are asked about (removal kills them). */
export function removalGate(timelineWorking: boolean, terminalWorking: boolean): 'block' | 'confirm' | 'ok' {
	if (timelineWorking) return 'block';
	return terminalWorking ? 'confirm' : 'ok';
}
