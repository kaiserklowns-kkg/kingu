// Agent chats (not ADE tasks): the data model mirrored from Rust `agent/chats.rs` and the pure
// reducers the `chats` store (chats.svelte.ts) uses. One chat = one agent-host session that runs
// in the open folder or one of its task worktrees, with no worktree, setup script or tabs of its
// own. The list lives in `<root>/.kingu/chats.json`; the transcript in `.kingu/chats/<id>.jsonl`.

import { worktreeDir } from '#lib/ade/keys.ts';
import type { RunSummary } from '#lib/ade/model.ts';
import { taskTitleFromPrompt } from './composerText';
import { applyEvent, initialRun, type AgentEvent, type RunState, type RunStatus } from './events';
import { CLAUDE_RUNTIME } from './runtimes';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan';
export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];

/** Where the chat's agent runs. */
export type ChatCwd = { kind: 'folder' } | { kind: 'task'; slug: string };

export type ChatMeta = {
	id: string;
	/** From the first prompt, then the AI title (chatTitle.ts); renameable. */
	title: string;
	/** Still Kingu's own title (the user never renamed it), so an AI title may replace it. Rust defaults it to false. */
	title_auto?: boolean;
	/** The first prompt, cut to `MAX_PROMPT` characters (for "Promote to task"). */
	prompt: string;
	cwd: ChatCwd;
	session_id: string | null;
	/** After a rewind or a fork: the next run resumes `session_id` up to this message, in a fork of it (Rust `rewind.rs`). */
	resume_at?: string | null;
	model: string | null;
	permission_mode: PermissionMode | null;
	/** Which agent runs it (runtimes.ts); absent: Claude (Rust defaults it). */
	runtime?: string;
	/** VS Code's Ask or a custom agent's name (customizations.ts); absent: Agent or Plan by `permission_mode`. */
	agent?: string | null;
	/** Unix ms. */
	created_at: number;
	updated_at: number;
	last_run: RunSummary | null;
	/** A turn was running when saved; still set at launch: Kingu quit mid-turn (chatResume.ts). */
	working?: boolean;
};

/** Rust's limits (chats.rs). */
export const MAX_PROMPT = 2000;
export const MAX_TITLE = 200;

/** `c-<time>-<random>`: lowercase letters, digits and '-', as Rust requires. */
export function newChatId(now: number, rand: () => number = Math.random): string {
	const tail = Array.from({ length: 6 }, () => Math.floor(rand() * 36).toString(36)).join('');
	return `c-${now.toString(36)}-${tail}`;
}

const cutChars = (s: string, max: number) => ([...s].length > max ? [...s].slice(0, max).join('') : s);

/** The title a chat starts with: its first prompt's first line. */
export const initialTitle = (prompt: string) => taskTitleFromPrompt(prompt.trim()) || 'Chat';

/** Whether a finished turn should get the chat an AI title: never renamed, and still its first-prompt title. */
export const wantsAiTitle = (meta: Pick<ChatMeta, 'title' | 'title_auto' | 'prompt'>) => meta.title_auto === true && !!meta.prompt.trim() && meta.title === initialTitle(meta.prompt);

export function newChat(input: { prompt: string; cwd: ChatCwd; model: string | null; permissionMode: PermissionMode | null; runtime?: string; agent?: string | null }, now: number, id = newChatId(now)): ChatMeta {
	const prompt = input.prompt.trim();
	return {
		...(input.agent ? { agent: input.agent } : {}),
		id,
		title: initialTitle(prompt),
		title_auto: true,
		prompt: cutChars(prompt, MAX_PROMPT),
		cwd: input.cwd,
		session_id: null,
		model: input.model?.trim() || null,
		permission_mode: input.permissionMode,
		runtime: input.runtime || CLAUDE_RUNTIME,
		created_at: now,
		updated_at: now,
		last_run: null
	};
}

/** `patch` applied to chat `id` (and `updated_at` bumped unless the patch sets it). */
export function patchChat(list: readonly ChatMeta[], id: string, patch: Partial<Omit<ChatMeta, 'id'>>, now: number): ChatMeta[] {
	return list.map((c) => (c.id === id ? { ...c, updated_at: now, ...patch } : c));
}

/** A new title (trimmed, one line, at most `MAX_TITLE` characters); `null` when it is empty or unchanged. */
export function renamedChatTitle(current: string, input: string): string | null {
	const title = cutChars(input.replace(/\s+/g, ' ').trim(), MAX_TITLE);
	return title && title !== current ? title : null;
}

export function removeChat(list: readonly ChatMeta[], id: string): ChatMeta[] {
	return list.filter((c) => c.id !== id);
}

/** Newest activity first. */
export function sortChats(list: readonly ChatMeta[]): ChatMeta[] {
	return [...list].sort((a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at));
}

/** The chat's run folder under `root` (Rust checks it again: `chats::resolve_cwd`). */
export function chatCwdPath(root: string, cwd: ChatCwd): string {
	return cwd.kind === 'folder' ? root : `${root}/${worktreeDir(cwd.slug)}`;
}

/** Runs are keyed by folder and chat id: two folders can have the same chat id. */
export const runKey = (root: string, id: string) => `${root}\n${id}`;

/**
 * The timeline of a saved transcript (every run of the chat, in order). A transcript without its `exit` (the app quit mid-run) is
 * closed as stopped, and permission prompts left open are shown as cancelled: none can be answered.
 */
export function replayTranscript(events: readonly AgentEvent[]): RunState {
	const s = initialRun();
	for (const ev of events) {
		// A transcript holds every run of the chat: an event after an `exit` starts the next one.
		// (A vote is added by the app whenever the user clicks, also after the run's end.)
		if (s.ended && ev.kind !== 'exit' && ev.kind !== 'feedback') {
			s.ended = false;
			s.error = null;
		}
		applyEvent(s, ev);
	}
	if (!s.ended) {
		s.ended = true;
		for (const p of s.pending) s.decisions[p.request_id] = 'cancelled';
		s.pending = [];
		s.draft = { text: '', thinking: '' };
		s.status = events.length ? 'stopped' : 'done';
	}
	return s;
}

/** What a message does: into the live run, else a new run resuming the chat's session (if any). */
export function chatSendPlan(run: Pick<RunState, 'ended' | 'sessionId'> | undefined, saved: string | null): { kind: 'send' } | { kind: 'start'; resume: string | null } {
	if (run && !run.ended) return { kind: 'send' };
	return { kind: 'start', resume: run?.sessionId ?? saved ?? null };
}

/** What a model / permission mode change does: applied to the live session now, or on the next run. */
export const optionChange = (run: Pick<RunState, 'ended'> | undefined, runId: number | undefined): 'live' | 'next' => (run && !run.ended && runId !== undefined ? 'live' : 'next');

/** A chat row of the history list (VS Code's agent sessions): title, last activity and live state. */
export type ChatRow = { id: string; title: string; at: number; state: 'working' | 'needsInput' | null };
/** An ADE task row: read-only here, opened in the Agents layout. */
export type TaskRow = { slug: string; title: string; at: number; terminal: boolean; state: 'working' | 'needsInput' | null };

const liveState = (status: RunStatus | undefined): ChatRow['state'] =>
	status === 'waiting' ? 'needsInput' : status === 'running' || status === 'starting' ? 'working' : null;

/** The history list: this folder's chats newest first, and its ADE tasks in their own section. */
export function historySections(
	chats: readonly ChatMeta[],
	tasks: readonly { slug: string; title: string; created_at: number; updated_at: number; terminal: boolean }[],
	statusOf: (row: { kind: 'chat'; id: string } | { kind: 'task'; slug: string }) => RunStatus | undefined
): { chats: ChatRow[]; tasks: TaskRow[] } {
	return {
		chats: sortChats(chats).map((c) => ({ id: c.id, title: c.title, at: c.updated_at || c.created_at, state: liveState(statusOf({ kind: 'chat', id: c.id })) })),
		tasks: [...tasks]
			.sort((a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at))
			.map((x) => ({ slug: x.slug, title: x.title, at: x.updated_at || x.created_at, terminal: x.terminal, state: liveState(statusOf({ kind: 'task', slug: x.slug })) }))
	};
}

/** The history's date groups (VS Code's agent sessions sections). */
export type DateGroup = 'today' | 'yesterday' | 'week' | 'older';

/**
 * `rows` (newest first) in Today / Yesterday / Last 7 days / Older by local calendar day of `at`;
 * empty groups are left out, the order inside each is kept. A time after `now` counts as today.
 */
export function groupByDate<T extends { at: number }>(rows: readonly T[], now: number): { group: DateGroup; rows: T[] }[] {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	const today = day.getTime();
	day.setDate(day.getDate() - 1);
	const yesterday = day.getTime();
	day.setDate(day.getDate() - 6);
	const week = day.getTime();
	const of = (at: number): DateGroup => (at >= today ? 'today' : at >= yesterday ? 'yesterday' : at >= week ? 'week' : 'older');
	const out: { group: DateGroup; rows: T[] }[] = [];
	for (const g of ['today', 'yesterday', 'week', 'older'] as const) {
		const inGroup = rows.filter((r) => of(r.at) === g);
		if (inGroup.length) out.push({ group: g, rows: inGroup });
	}
	return out;
}

/** The chat the panel opens on: the most recent one (null: a new chat). ADE tasks are never opened here. */
export const initialChat = (chats: readonly ChatMeta[]): string | null => sortChats(chats)[0]?.id ?? null;
