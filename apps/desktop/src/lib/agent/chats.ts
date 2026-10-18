// Agent chats (not ADE tasks): the data model mirrored from Rust `agent/chats.rs` and the pure
// reducers the `chats` store (chats.svelte.ts) uses. One chat = one agent-host session that runs
// in the open folder or one of its task worktrees, with no worktree, setup script or tabs of its
// own. The list lives in `<root>/.kingu/chats.json`; the transcript in `.kingu/chats/<id>.jsonl`.

import { worktreeDir } from '#lib/ade/keys.ts';
import type { RunSummary } from '#lib/ade/model.ts';
import { taskTitleFromPrompt } from './composerText';
import { applyEvent, initialRun, type AgentEvent, type RunState } from './events';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan';
export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];

/** Where the chat's agent runs. */
export type ChatCwd = { kind: 'folder' } | { kind: 'task'; slug: string };

export type ChatMeta = {
	id: string;
	/** From the first prompt; renameable. */
	title: string;
	/** The first prompt, cut to `MAX_PROMPT` characters (for "Promote to task"). */
	prompt: string;
	cwd: ChatCwd;
	session_id: string | null;
	model: string | null;
	permission_mode: PermissionMode | null;
	/** Unix ms. */
	created_at: number;
	updated_at: number;
	last_run: RunSummary | null;
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

export function newChat(input: { prompt: string; cwd: ChatCwd; model: string | null; permissionMode: PermissionMode | null }, now: number, id = newChatId(now)): ChatMeta {
	const prompt = input.prompt.trim();
	return {
		id,
		title: taskTitleFromPrompt(prompt) || 'Chat',
		prompt: cutChars(prompt, MAX_PROMPT),
		cwd: input.cwd,
		session_id: null,
		model: input.model?.trim() || null,
		permission_mode: input.permissionMode,
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
		if (s.ended && ev.kind !== 'exit') {
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

/** Row of the panel's session list: chats of this folder plus ADE tasks, newest first. */
export type SessionRow = { kind: 'chat'; id: string; title: string; at: number } | { kind: 'task'; slug: string; title: string; at: number; terminal: boolean };

export function sessionRows(chats: readonly ChatMeta[], tasks: readonly { slug: string; title: string; created_at: number; updated_at: number; terminal: boolean }[]): SessionRow[] {
	const rows: SessionRow[] = [
		...chats.map((c) => ({ kind: 'chat' as const, id: c.id, title: c.title, at: c.updated_at || c.created_at })),
		...tasks.map((t) => ({ kind: 'task' as const, slug: t.slug, title: t.title, at: t.updated_at || t.created_at, terminal: t.terminal }))
	];
	return rows.sort((a, b) => b.at - a.at);
}
