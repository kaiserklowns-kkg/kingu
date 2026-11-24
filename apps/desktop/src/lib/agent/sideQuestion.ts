// `/side` and its alias `/btw` (Orca 1.4.272's side chat; Orca
// src/shared/native-chat/input/commands/native-chat-side-chat-command.ts and
// src/renderer/src/components/native-chat/messages/actions/use-native-chat-side-chat.ts): a side
// question asked beside the chat without derailing it. The chat is forked through its newest
// finished response (a running reply is never copied) and the question goes to the fork, shown in
// the side chat drawer (SideChat.svelte), never to the chat's agent. Pure, so `bun test` covers it.

import type { Turn } from './chatParts.ts';

export const SIDE_COMMANDS = ['side', 'btw'] as const;
export type SideCommand = (typeof SIDE_COMMANDS)[number];

export const isSideCommand = (name: string | null | undefined): name is SideCommand => SIDE_COMMANDS.some((c) => c === name);

/** `/side [question]` or `/btw [question]` as the whole message; null for anything else. */
export function parseSideDraft(text: string): { question: string } | null {
	const m = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i.exec(text.trim());
	return m ? { question: m[1]?.trim() ?? '' } : null;
}

/**
 * Where a side chat forks: `before` is the request it is cut before (null: the whole chat), or why
 * none can start now (Orca's "Available when this reply finishes." / "Available after the first reply.").
 */
export type SideForkPoint = { kind: 'ready'; before: number | null } | { kind: 'replyRunning' } | { kind: 'noReply' };

type TurnLike = Pick<Turn, 'done' | 'parts' | 'checkpoint'>;

/** A finished turn the agent answered (its own text, not only a tool call or an error). */
const answered = (t: TurnLike) => t.done && t.parts.some((p) => p.kind === 'markdown');

/**
 * The newest finished response to fork through. While a reply runs (`busy`, the last turn not
 * done), the fork is cut before that running request, so it copies only finished turns; with no
 * finished answer yet there is nothing to ask beside.
 */
export function sideForkPoint(turns: readonly TurnLike[], busy: boolean): SideForkPoint {
	const last = turns[turns.length - 1];
	const running = busy && !!last && !last.done;
	if (!running) return turns.some(answered) ? { kind: 'ready', before: null } : { kind: 'noReply' };
	const earlier = turns.slice(0, -1).some(answered);
	// The running request's index is what the fork is cut before; unknown, it cannot be cut safely.
	return earlier && last.checkpoint != null ? { kind: 'ready', before: last.checkpoint } : { kind: 'replyRunning' };
}

/** Why `/side` cannot be sent now; null when it can. Side chats take text only (Orca's rule). */
export function sideRefusal(point: SideForkPoint, hasAttachments: boolean): 'replyRunning' | 'noReply' | 'textOnly' | null {
	if (hasAttachments) return 'textOnly';
	return point.kind === 'ready' ? null : point.kind;
}
