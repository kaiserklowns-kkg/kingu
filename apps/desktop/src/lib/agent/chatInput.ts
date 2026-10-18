// The chat input's behaviour (VS Code's chatInputPart), pure so `bun test` covers it:
// ↑/↓ prompt history, the Ask/Agent mode picker over the SDK permission modes, the request queue
// while a turn runs, and the `#` file trigger.

import type { PermissionMode } from './chats';
import type { RunStatus } from './events';

// ---- ↑/↓ history -----------------------------------------------------------------------------

/** Where ↑/↓ is in the chat's prompt history: null when not browsing (the input is the user's own). */
export type HistoryCursor = number | null;

/**
 * ↑ / ↓ in the input. ↑ starts browsing only from an empty input (VS Code recalls from an empty
 * box), then steps back; ↓ steps forward and past the newest entry returns to an empty input.
 * null: the key is not for history (the caret moves as usual).
 */
export function recallPrompt(history: readonly string[], cursor: HistoryCursor, dir: 'up' | 'down', input: string): { cursor: HistoryCursor; text: string } | null {
	if (!history.length) return null;
	const browsing = cursor !== null && history[cursor] === input;
	if (!browsing) {
		if (dir === 'down' || input.trim()) return null;
		return { cursor: history.length - 1, text: history[history.length - 1] };
	}
	if (dir === 'up') return cursor! > 0 ? { cursor: cursor! - 1, text: history[cursor! - 1] } : { cursor, text: input };
	return cursor! < history.length - 1 ? { cursor: cursor! + 1, text: history[cursor! + 1] } : { cursor: null, text: '' };
}

// ---- Ask / Agent -----------------------------------------------------------------------------

/** VS Code's chat modes: Ask answers without changing anything (SDK `plan`), Agent works with tools. */
export type ChatMode = 'ask' | 'agent';
/** How Agent mode asks for permission (the existing choice). */
export type AgentApproval = Exclude<PermissionMode, 'plan'>;
export const AGENT_APPROVALS: readonly AgentApproval[] = ['default', 'acceptEdits'];

export const modeOf = (permission: PermissionMode | null | undefined): ChatMode => (permission === 'plan' ? 'ask' : 'agent');

/** The permission mode for a mode pick; Agent keeps the approval chosen before (or asks first). */
export function permissionFor(mode: ChatMode, approval: AgentApproval | null | undefined): PermissionMode {
	return mode === 'ask' ? 'plan' : (approval ?? 'default');
}

// ---- queue -----------------------------------------------------------------------------------

/** A turn is in progress: a new request waits for it (VS Code queues it) instead of interleaving. */
export const turnBusy = (run: { ended: boolean; status: RunStatus } | undefined): boolean =>
	!!run && !run.ended && (run.status === 'starting' || run.status === 'running' || run.status === 'waiting');

/** What to do with the queue after an event: send its head when the turn just finished. */
export function shouldDrain(queueLength: number, run: { ended: boolean; status: RunStatus; stopped?: boolean } | undefined): boolean {
	if (!queueLength || !run) return false;
	if (run.ended) return run.status !== 'stopped';
	return run.status === 'idle';
}

// ---- # file trigger --------------------------------------------------------------------------

/** A `#` just typed at the start of a word (VS Code's variable trigger): its offset, else -1. */
export function hashTrigger(text: string, caret: number): number {
	const i = caret - 1;
	if (i < 0 || text[i] !== '#') return -1;
	return i === 0 || /\s/.test(text[i - 1]) ? i : -1;
}
