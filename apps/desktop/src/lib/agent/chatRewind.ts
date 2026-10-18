// Rewinding and forking a chat (VS Code's Restore Checkpoint, Edit request, Retry, Start Over and
// Fork Conversation): the pure parts the `chatRewind` store (chatRewind.svelte.ts) uses. Rust does
// the work (`chat_rewind`, `chat_rewind_redo`, `chat_fork` in agent/rewind.rs): files back, the
// transcript cut, and where the next run continues the conversation.

import type { ChatMeta } from './chats.ts';
import type { Report } from './chatEdits.ts';
import type { Turn } from './chatParts.ts';

/** `chat_rewind`'s answer: where the next run continues (both null: a new session), and the files. */
export type Rewound = {
	session_id: string | null;
	resume_at: string | null;
	report: Report;
};
/** `chat_fork`'s answer. */
export type ForkPoint = Pick<Rewound, 'session_id' | 'resume_at'>;

/** The chat fields a rewind sets: its next run resumes there (a new session when both are null). */
export const rewoundMeta = (r: ForkPoint): Pick<ChatMeta, 'session_id' | 'resume_at'> => ({ session_id: r.session_id, resume_at: r.session_id ? r.resume_at : null });

/** Checkpoint (request) indexes of the turns, in order; turns without one (before chats kept them) are left out. */
export const checkpoints = (turns: readonly Turn[]): number[] => turns.flatMap((t) => (t.request && t.checkpoint != null ? [t.checkpoint] : []));

/** The first request: its checkpoint is Start Over rather than Restore Checkpoint. */
export const isFirstRequest = (turns: readonly Turn[], checkpoint: number) => turns.find((t) => t.request)?.checkpoint === checkpoint;

/** The last request's checkpoint (Retry rewinds to it); null when it has none. */
export const lastCheckpoint = (turns: readonly Turn[]): number | null => turns.findLast((t) => t.request)?.checkpoint ?? null;

/** The turn of a checkpoint. */
export const turnOf = (turns: readonly Turn[], checkpoint: number): Turn | undefined => turns.find((t) => t.checkpoint === checkpoint);

/** Index of the first turn hidden while request `checkpoint` is edited in place (the later ones), or -1. */
export function laterThan(turns: readonly Turn[], checkpoint: number): number {
	const i = turns.findIndex((t) => t.checkpoint === checkpoint);
	return i < 0 ? -1 : i + 1;
}

/** The forked chat's title: "Forked: <title>", never twice (VS Code's fork). */
export function forkTitle(title: string, prefix: string, format: (title: string) => string): string {
	return title.startsWith(prefix) ? title : format(title);
}

/**
 * The confirm's answer as a plan: 0 = go, 1 = go and stop asking, anything else = cancel.
 * Asked only when the setting says so and there is something to lose.
 */
export function confirmAnswer(button: number): { go: boolean; dontAsk: boolean } {
	return { go: button === 0 || button === 1, dontAsk: button === 1 };
}
