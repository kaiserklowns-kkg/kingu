// Rewinding and forking a chat (VS Code's Restore Checkpoint, Edit request, Retry, Start Over and
// Fork Conversation): the pure parts the `chatRewind` store (chatRewind.svelte.ts) uses. Rust does
// the work (`chat_rewind`, `chat_rewind_redo`, `chat_fork` in agent/rewind.rs): files back, the
// transcript cut, and where the next run continues the conversation.

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
export const rewoundMeta = (r: ForkPoint): ForkPoint => ({ session_id: r.session_id, resume_at: r.session_id ? r.resume_at : null });

/** The last request's checkpoint (Retry rewinds to it); null when it has none. */
export const lastCheckpoint = (turns: readonly Turn[]): number | null => turns.findLast((t) => t.request)?.checkpoint ?? null;

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
