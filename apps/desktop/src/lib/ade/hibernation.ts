// Agent hibernation (Orca's experimentalAgentHibernation, kingu.agent.hibernation): an agent CLI
// that finished its turn and has sat idle for `kingu.agent.hibernationIdleMinutes` is closed to
// free its process and memory, and continues the same session when you return to it. Per pane, as
// in Orca: a task's own agent (its main tab) and an agent in any terminal pane of a task's
// worktree each sleep and wake on their own. Which CLIs may go is decided here, the way Orca's
// planner does (lib/agent-session/hibernation/agent-hibernation-planner.ts, -pane-eligibility.ts,
// -input-guard.ts, -confirmation.ts): a finished turn (not waiting on you, no subagent left), a
// session the CLI can resume, nothing typed since, nothing printed and not on screen for the whole
// idle time, and the same on two looks in a row with no output between. Pure.
//
// Waking is Orca's reveal wake (terminal-pane/pty-connection/lifecycle/hibernated-pane-wake.ts,
// spawn/hidden-agent-resume-deferral.ts): the CLI continues its session by itself the moment its
// terminal comes back on screen, once per return, also the first time it is shown after a restart.
// A task's own agent keeps its record on the task (`hibernated_at`, `session_id`); a terminal
// pane's record is the `SleepingPane` below, with the folder and launch the agent ran with (Orca's
// SleepingAgentSessionRecord `providerSession.cwd` and `launchConfig`).

import { agentOfProcess, profileOf } from './agentProfiles';
import { resumeArgv } from './agentsPanel';
import { AUTO_ARGS, YOLO_ARGS } from './agentCli';

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
	/** A task's slug for its own agent; the PTY key of the pane for an agent in a terminal pane. */
	id: string;
	/** The CLI's hook state: `idle` once a turn finished (agentHooks.ts); undefined without hooks. */
	phase?: string;
	/** Waiting on a permission answer or a question. */
	waiting: boolean;
	/** The CLI process ended already (its terminal shows the shell). */
	ended: boolean;
	/** Its session id is known and its CLI can resume it. */
	resumable: boolean;
	/** Subagents it started still run (Orca: "done" alone is not enough while children are attached). */
	busy?: boolean;
	/** The CLI's terminal is on screen now. */
	foreground: boolean;
	/** Unix ms: the latest hook event, the latest output, the last time it was on screen. */
	hookAt?: number;
	outputAt?: number;
	seenAt?: number;
	/** Unix ms of the last key typed into its terminal, when one was seen. */
	inputAt?: number;
	/** Unix ms its latest working stretch began (for a CLI without a "working" event: its turn's end). */
	turnAt?: number;
	/** The session it would resume (part of the confirmation's signature). */
	session?: string;
	/** How many output chunks its terminal printed so far (Orca's output epoch: unthrottled). */
	outputs?: number;
};

/**
 * Keys typed since the latest working stretch began may be a draft or a queued prompt, which
 * closing the CLI would lose (Orca's lastInputBlocksHibernation; a tie keeps the CLI). An answer
 * typed while it waited was consumed: the working stretch that followed is later than it.
 */
export const inputBlocks = (r: Pick<HibernationRow, 'inputAt' | 'turnAt'>) => r.inputAt !== undefined && r.inputAt >= (r.turnAt ?? 0);

/**
 * The CLIs that qualify now. The idle time counts from the latest of: the turn's end (hook event),
 * the last output (a draft typed into the TUI echoes, so it counts too) and the last time the
 * terminal was on screen.
 */
export function hibernationCandidates(rows: readonly HibernationRow[], now: number, idle: number): string[] {
	return rows
		.filter((r) => {
			if (r.phase !== 'idle' || r.waiting || r.busy || r.ended || !r.resumable || r.foreground || inputBlocks(r)) return false;
			const since = Math.max(r.hookAt ?? 0, r.outputAt ?? 0, r.seenAt ?? 0);
			return since > 0 && now - since >= idle;
		})
		.map((r) => r.id)
		.sort();
}

/**
 * What must not change between two looks for a candidate to be closed (Orca's signatureFor plus
 * the output epoch): its session, its turn and hook state, its last key and its output.
 */
export const hibernationSignature = (r: HibernationRow) =>
	[r.id, r.session ?? '', r.phase ?? '', r.hookAt ?? '', r.turnAt ?? '', r.inputAt ?? '', r.outputAt ?? '', r.outputs ?? 0].join('|');

/** Signatures of the candidates at the last look, by id. */
export type HibernationConfirmations = Readonly<Record<string, string>>;

/**
 * Orca's two-tick confirmation (agent-hibernation-confirmation.ts): a CLI is closed only when it
 * was a candidate at the last look too, with the same signature, so a turn that finished just
 * now, a key or any output between the looks starts it over. `state` is what the next look compares with.
 */
export function confirmHibernation(prev: HibernationConfirmations, rows: readonly HibernationRow[], now: number, idle: number): { confirmed: string[]; state: Record<string, string> } {
	const byId = new Map(rows.map((r) => [r.id, r]));
	const state: Record<string, string> = {};
	const confirmed: string[] = [];
	for (const id of hibernationCandidates(rows, now, idle)) {
		const sig = hibernationSignature(byId.get(id)!);
		state[id] = sig;
		if (prev[id] === sig) confirmed.push(id);
	}
	return { confirmed, state };
}

/** The task whose terminal is on screen, as the wake sees it. */
export type ReturnedTask = {
	/** The task says its CLI is hibernated (closed by hibernation in this run or an earlier one); any launch since clears it. */
	hibernated: boolean;
	/** A CLI is running for the task: another flow owns it already. */
	running: boolean;
	/** The saved session can still be continued by the CLI. */
	resumable: boolean;
	/** A launch of this task is in flight (Orca's hibernatedWakeInFlightClaimKey). */
	resuming: boolean;
};

/**
 * Whether the task on screen continues its session now. Once per showing: `claimed` is the task
 * a wake was already tried for since its terminal came on screen (the caller clears it when the
 * terminal leaves), so a failed launch waits for the next return. A task still hibernated after a
 * restart wakes the same way, the first time it is shown, and at once when it is on screen as the
 * window opens (Orca's hidden-agent resume deferral: hidden restores wait for their reveal,
 * visible ones resume immediately). There is no delay and no setting, as in Orca.
 */
export function autoResumeOnShow(shown: string | null, claimed: string | null, task: ReturnedTask | null): boolean {
	if (shown === null || claimed === shown || !task) return false;
	return task.hibernated && !task.running && task.resumable && !task.resuming;
}

// ---- agents in terminal panes ---------------------------------------------------------------

/**
 * Whether terminal panes can hibernate on this platform: the planner needs the job in front of a
 * pane's shell and its folder, and closing it needs job control. Kingu reads those on macOS and
 * Linux (kingu-ptyd procinfo.rs); on Windows they are never known, so panes are skipped there
 * outright (a task's own agent still hibernates). `platform`: `navigator.platform`.
 */
export const paneHibernationSupported = (platform: string | undefined): boolean => !/^win/i.test(platform ?? '');

/**
 * The CLIs whose session a pane can continue from its id alone, with the command session history
 * uses (agentsPanel.ts `resumeArgv`; Orca's shared/agent-launch/startup/agent-resume-argv.ts).
 * Left out, so left running: Pi and Prime Agent (they resume by a transcript file Kingu does not
 * have), Cursor and Antigravity (by a conversation id the pane's hooks do not report), and every
 * CLI without a resume command.
 */
export const PANE_RESUME_AGENTS: readonly string[] = ['claude', 'codex', 'gemini', 'opencode', 'opencode2', 'copilot', 'droid', 'grok', 'devin', 'kiro', 'kimi', 'codebuddy', 'qoder', 'hermes', 'muse', 'zcode', 'jcode', 'omp'];

/** Orca's normalizeSessionId: 1-512 characters, no control characters, not an option (`-…`). */
export function validSessionId(id: unknown): id is string {
	return typeof id === 'string' && id.length > 0 && id.length <= 512 && id === id.trim() && !id.startsWith('-') && !/[\u0000-\u001f\u007f]/.test(id);
}

/** Orca's getAgentResumeArgv without its program word: what follows the launch command to continue `id`. */
function resumeTail(agent: string, id: string): string[] {
	switch (agent) {
		case 'codex':
			return ['resume', id];
		case 'muse':
			return ['resume', id];
		case 'opencode':
		case 'opencode2':
		case 'kimi':
			return ['--session', id];
		case 'copilot':
			return [`--resume=${id}`];
		case 'kiro':
			return ['--resume-id', id];
		default:
			return ['--resume', id];
	}
}

/** Launch arguments a profile leaves out when it resumes (agentProfiles.ts `launchArgs.resume: false`). */
const NOT_ON_RESUME: Readonly<Record<string, readonly string[]>> = { hermes: ['--tui'], muse: ['--trust-workspace'] };

/** An agent launch split up: its `env NAME=value …` words, its program and its arguments. */
function splitLaunch(argv: readonly string[]): { env: string[]; program: string; args: string[] } | null {
	let i = 0;
	const env: string[] = [];
	if (argv[0] && (argv[0].split('/').pop() ?? '') === 'env') {
		i = 1;
		while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) env.push(argv[i++]);
	}
	const program = argv[i];
	return program ? { env, program, args: argv.slice(i + 1) } : null;
}

/**
 * Orca's buildClaudeResumeLaunchCommand: stale `--resume`/`-r` (with its id), `--continue`/`-c`
 * selectors in the launch are replaced by the one session, placed before a `--` terminator.
 */
function claudeResumeArgs(args: readonly string[], tail: readonly string[]): string[] {
	const end = args.indexOf('--');
	const options = end < 0 ? args : args.slice(0, end);
	const kept: string[] = [];
	for (let i = 0; i < options.length; i++) {
		const t = options[i];
		if (t === '--resume' || t === '-r') {
			if (options[i + 1] !== undefined && !options[i + 1].startsWith('-')) i++;
			continue;
		}
		if (['--resume=', '-r=', '--continue=', '-c='].some((p) => t.startsWith(p)) || t === '--continue' || t === '-c') continue;
		kept.push(t);
	}
	return [...kept, ...tail, ...(end < 0 ? [] : args.slice(end))];
}

/**
 * The command that continues `sessionId` in the pane; null when the pane stays running. Without a
 * launch it is the CLI's plain resume command (session history's). With the launch the pane's
 * agent was started with (`env` words, program, arguments), Orca's buildAgentResumeStartupPlan:
 * the launch command with the resume arguments after it; for claude stale session selectors are
 * replaced (before a `--`), for codex Kingu's own permission flags are dropped so the thread keeps
 * the permissions it had (Orca's dropRecordedAgentPermissionArgs).
 */
export function paneResumeArgv(agent: string | null | undefined, sessionId: string | null | undefined, launch?: readonly string[]): string[] | null {
	if (!agent || !PANE_RESUME_AGENTS.includes(agent) || !validSessionId(sessionId)) return null;
	const parts = launch ? splitLaunch(launch) : null;
	if (!parts) return resumeArgv(agent, sessionId);
	let args = parts.args;
	const drop = NOT_ON_RESUME[agent];
	if (drop && drop.every((a, k) => args[k] === a)) args = args.slice(drop.length);
	if (agent === 'codex') {
		const permission = new Set([...(YOLO_ARGS.codex ?? []), ...(AUTO_ARGS.codex ?? [])]);
		args = args.filter((a) => !permission.has(a));
	}
	const tail = resumeTail(agent, sessionId);
	const rest = agent === 'claude' ? claudeResumeArgs(args, tail) : [...args, ...tail];
	return [...(parts.env.length ? ['env', ...parts.env] : []), parts.program, ...rest];
}

/** An agent launch Kingu started a tab with (the new-tab menu, a quick prompt): its profile and argv, without a prompt. */
export type PaneLaunch = { agent: string; argv: string[] };

/**
 * The launch a pane's running agent was started with, when it is the tab's own (Orca keeps a
 * pane's launch config while the agent it launched runs there): the same agent, and every
 * argument of the launch on the job's command line in order (`job`: what the OS reports, first
 * arguments only). An agent typed by hand later in the same pane, or one whose command line cannot
 * be read, has none and resumes with the plain command, as Orca's typed agents do.
 */
export function paneLaunchOf(agent: string, launch: PaneLaunch | undefined, job: readonly string[]): string[] | undefined {
	if (!launch || launch.agent !== agent || !job.length) return undefined;
	const parts = splitLaunch(launch.argv);
	if (!parts) return undefined;
	let k = 1;
	for (const a of parts.args) {
		while (k < job.length && job[k] !== a) k++;
		if (k++ >= job.length) return undefined;
	}
	return [...launch.argv];
}

/**
 * The agent (its profile id) running in a pane: the job in front of its shell must be a known
 * agent CLI, and the one its hooks name. Null at the prompt, for any other program (a hook file
 * left by an agent that has quit must not close what runs there now), and when the job is unknown.
 */
export function paneAgent(foreground: string | null | undefined, hookAgent?: string): string | null {
	const bin = agentOfProcess(foreground);
	const id = bin ? profileOf([bin]).id : 'custom';
	if (id === 'custom') return null;
	return hookAgent && hookAgent !== id ? null : id;
}

/** What Kingu knows about one terminal pane of a task's worktree (paneAgents.svelte.ts). */
export type PaneFacts = {
	/** The pane's PTY key. */
	key: string;
	foreground?: string | null;
	hook?: { phase: string; permission: boolean; question: boolean; hooks?: boolean; sessionId?: string; subagents?: Record<string, string>; at: number };
	hookAgent?: string;
	lastOutput?: number;
	outputs?: number;
	inputAt?: number;
	turnAt?: number;
	/** Its tab is shown in a region of the center now, and when it last was. */
	onScreen: boolean;
	seenAt?: number;
};

/** A terminal pane as the planner sees it. */
export function paneHibernationRow(p: PaneFacts): HibernationRow {
	const h = p.hook;
	const agent = paneAgent(p.foreground, p.hookAgent);
	return {
		id: p.key,
		phase: h?.phase,
		waiting: !!h && (h.permission || h.question || h.phase === 'waiting'),
		busy: !!h?.subagents && Object.keys(h.subagents).length > 0,
		ended: !agent,
		resumable: !!paneResumeArgv(agent, h?.sessionId),
		foreground: p.onScreen,
		hookAt: h?.at,
		outputAt: p.lastOutput,
		seenAt: p.seenAt,
		inputAt: p.inputAt,
		// A CLI that only reports finished turns has no "working" event: its turn's end is the boundary.
		turnAt: h?.hooks ? p.turnAt : h?.at,
		session: agent && h?.sessionId ? `${agent}:${h.sessionId}` : undefined,
		outputs: p.outputs
	};
}

/** When the latest working stretch began, after one more hook event moved the phase. */
export const turnStart = (turnAt: number | undefined, before: string | undefined, after: string, now: number) => (after === 'working' && before !== 'working' ? now : turnAt);

/**
 * A sleeping pane's record (Orca's SleepingAgentSessionRecord): which CLI, which session, since
 * when; the folder the agent ran in (`cwd`) and whether that is its shell's own (`here`); and the
 * launch it was started with (`launch`: `env` words, program, arguments), when Kingu started it.
 */
export type SleepingPane = { agent: string; sessionId: string; at: number; cwd?: string; here?: boolean; launch?: string[] };
/** By PTY key of the pane (`ade:<root tag>:<task>:<pane>`). */
export type SleepingPanes = Record<string, SleepingPane>;

/** The job in front of a pane's shell (Rust `pty_job_info`). */
export type PaneJob = { pid: number; cwd?: string | null; here?: boolean | null; args: string[] };

/** The record to keep for a pane about to be closed; null when it cannot be resumed (so it is not closed). */
export function sleepingPaneOf(p: Pick<PaneFacts, 'foreground' | 'hook' | 'hookAgent'>, now: number, job?: Pick<PaneJob, 'cwd' | 'here'>, launch?: readonly string[]): SleepingPane | null {
	const agent = paneAgent(p.foreground, p.hookAgent);
	const sessionId = p.hook?.sessionId;
	if (!agent || !sessionId || !paneResumeArgv(agent, sessionId)) return null;
	const cwd = job?.cwd && job.cwd.startsWith('/') ? job.cwd : undefined;
	return {
		agent,
		sessionId,
		at: now,
		...(cwd ? { cwd, ...(typeof job?.here === 'boolean' ? { here: job.here } : {}) } : {}),
		...(launch?.length && paneResumeArgv(agent, sessionId, launch) ? { launch: [...launch] } : {})
	};
}

/** Per folder in localStorage (`storeName(SLEEPING_PANES_STORE, rootTag(root))`). */
export const SLEEPING_PANES_STORE = 'kingu.adeSleepingPanes';
/** 2: records carry the agent's folder and launch. 1 (the first per-pane build) had neither. */
const VERSION = 2;
const PANE_KEY = /^ade:([0-9a-f]{8}):([^:]+):(t\d+)$/;
const MAX_LAUNCH = 64;

export const serializeSleepingPanes = (panes: SleepingPanes) => ({ v: VERSION, panes });

const isArgv = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= MAX_LAUNCH && v.every((a) => typeof a === 'string' && a.length <= 4096 && !a.includes('\0'));

/**
 * The stored records of folder `tag`; anything else reads as none, so a pane without a valid
 * record starts a plain shell. A folder that never had this store (every build before per-pane
 * hibernation: a task's own agent keeps `hibernated_at` on the task, unchanged) has none.
 * Version 1 records (agent, session, time) migrate as they are: v1 closed only agents running in
 * the worktree's own folder, so with no folder of their own they resume there, with the plain
 * command, as they would have.
 */
export function parseSleepingPanes(raw: unknown, tag: string): SleepingPanes | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const { v, panes } = raw as { v?: unknown; panes?: unknown };
	if ((v !== 1 && v !== VERSION) || typeof panes !== 'object' || panes === null || Array.isArray(panes)) return null;
	const out: SleepingPanes = {};
	for (const [key, r] of Object.entries(panes as Record<string, unknown>)) {
		// Only a task's panes sleep: the folder's own terminals (an empty worktree part) never do.
		if (key.length > 128 || PANE_KEY.exec(key)?.[1] !== tag || typeof r !== 'object' || r === null) continue;
		const { agent, sessionId, at, cwd, here, launch } = r as Record<string, unknown>;
		if (typeof agent !== 'string' || !paneResumeArgv(agent, sessionId as string) || typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
		const record: SleepingPane = { agent, sessionId: sessionId as string, at };
		if (v === VERSION) {
			// A folder or launch that does not read right is left out, never the whole record.
			if (typeof cwd === 'string' && cwd.startsWith('/') && cwd.length <= 4096 && !/[\u0000-\u001f]/.test(cwd)) {
				record.cwd = cwd;
				if (typeof here === 'boolean') record.here = here;
			}
			if (isArgv(launch) && paneResumeArgv(agent, record.sessionId, launch)) record.launch = [...launch];
		}
		out[key] = record;
	}
	return out;
}

/**
 * Sleeping panes and their wakes. `live`: panes whose shell still runs (hibernation closes the
 * agent, not the shell, so the pane keeps its screen and scrollback): their wake types the resume
 * into that shell. A pane whose shell is gone (a restart without the terminal daemon) starts a new
 * one that types it. `waking`: a wake is in flight (Orca's hibernatedWakeInFlightClaimKey).
 */
export type PaneSleepState = { panes: SleepingPanes; live: readonly string[]; waking: readonly string[] };
export const emptyPaneSleep: PaneSleepState = { panes: {}, live: [], waking: [] };

const without = (list: readonly string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : list);
const withKey = (list: readonly string[], key: string) => (list.includes(key) ? list : [...list, key]);
const dropPane = (panes: SleepingPanes, key: string) => {
	if (!(key in panes)) return panes;
	const { [key]: _, ...rest } = panes;
	return rest;
};

/** The record is kept before the pane's agent is closed (Orca stores the record first: the exit can come first); its shell stays. */
export function paneSlept(s: PaneSleepState, key: string, record: SleepingPane): PaneSleepState {
	return { panes: { ...s.panes, [key]: record }, live: withKey(s.live, key), waking: without(s.waking, key) };
}

/** The close failed: the agent still runs, so nothing sleeps there (Orca's rollbackTargetShutdownState). */
export function paneSleepFailed(s: PaneSleepState, key: string): PaneSleepState {
	return { panes: dropPane(s.panes, key), live: without(s.live, key), waking: without(s.waking, key) };
}

/**
 * The panes to wake now: sleeping panes with a live shell that just came on screen (`prev`: the
 * panes on screen at the last look), each claimed so one return types one resume. A claim ends
 * when the wake reports (`paneWoken`) or the pane leaves the screen.
 */
export function paneWakes(s: PaneSleepState, prev: ReadonlySet<string>, shown: ReadonlySet<string>): { state: PaneSleepState; wake: string[] } {
	const waking = s.waking.filter((k) => shown.has(k));
	const wake = [...shown].filter((k) => !prev.has(k) && k in s.panes && s.live.includes(k) && !waking.includes(k)).sort();
	if (!wake.length && waking.length === s.waking.length) return { state: s, wake };
	return { state: { ...s, waking: [...waking, ...wake] }, wake };
}

/**
 * How a wake went. `typed`: the resume went into the shell, so the record is used up, whatever
 * the CLI then does (when it cannot continue the session it exits and the shell stays, a usable
 * terminal). `taken`: a job other than the shell is in front already (someone started the agent
 * again, or something else): nothing sleeps there any more. `failed`: the record stays and the
 * next return tries again.
 */
export function paneWoken(s: PaneSleepState, key: string, how: 'typed' | 'taken' | 'failed'): PaneSleepState {
	if (!(key in s.panes)) return s;
	if (how === 'failed') return { ...s, waking: without(s.waking, key) };
	return { panes: dropPane(s.panes, key), live: without(s.live, key), waking: without(s.waking, key) };
}

/**
 * A pane's terminal reported how it came up. `attached`: its shell still runs, so a wake types
 * into it. `spawned`: a new shell started and typed the record's resume (the terminal's `type`),
 * so the record is used up. `failed`: no shell started; the record stays.
 */
export function paneConnected(s: PaneSleepState, key: string, how: 'spawned' | 'attached' | 'failed'): PaneSleepState {
	if (!(key in s.panes)) return s;
	if (how === 'attached') return s.live.includes(key) ? s : { ...s, live: [...s.live, key] };
	if (how === 'failed') return { ...s, live: without(s.live, key), waking: without(s.waking, key) };
	return { panes: dropPane(s.panes, key), live: without(s.live, key), waking: without(s.waking, key) };
}

/** Records of panes that no longer exist (a closed tab or split, a removed task) go with them. */
export function panesPruned(s: PaneSleepState, open: ReadonlySet<string>): PaneSleepState {
	const gone = Object.keys(s.panes).filter((k) => !open.has(k));
	if (!gone.length) return s;
	return { panes: Object.fromEntries(Object.entries(s.panes).filter(([k]) => open.has(k))), live: s.live.filter((k) => open.has(k)), waking: s.waking.filter((k) => open.has(k)) };
}

/** A word for a POSIX shell line (as kingu-ptyd's `shell_quote`, which types a terminal's `run`). */
export function shellWord(arg: string): string {
	return arg && /^[A-Za-z0-9\-_./=:@%+,]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line a sleeping pane's shell runs to wake it: its CLI's resume command, from the agent's own
 * folder (Orca's buildAiVaultResumeShellCommand: `cd` there first when the shell is elsewhere).
 * `kept`: the shell the agent was closed in (it is in its folder already unless `here` said
 * otherwise); else a new shell, which starts in the worktree. Null when nothing sleeps there.
 */
export function paneResumeLine(s: PaneSleepState, key: string, kept: boolean): string | null {
	const r = s.panes[key];
	const argv = r ? paneResumeArgv(r.agent, r.sessionId, r.launch) : null;
	if (!r || !argv) return null;
	const command = argv.map(shellWord).join(' ');
	const cd = r.cwd && !(kept && r.here !== false);
	return cd ? `cd ${shellWord(r.cwd!)} && ${command}` : command;
}
