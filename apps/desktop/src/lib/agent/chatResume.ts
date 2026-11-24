// Resume chats after a crash or restart (Orca 1.4.272; `kingu.chat.resumeWorkOnRestart` is Orca's
// nativeChatResumeWorkOnRestart). A chat saved with `working` (a turn was running) that has no run
// now was cut off when Kingu quit or crashed. At the folder's first load it is marked
// `interrupted`; with the setting on it gets one more message so its agent carries on, otherwise
// Kingu offers Resume (a notification for all, and a row in each chat). Pure, so `bun test` covers it.
//
// Orca: src/shared/agent-session/lifecycle/stopping/agent-session-restart-continuation.ts (the
// continuation message), src/renderer/src/components/native-chat-recovery/offers/
// native-chat-resume-on-restart-store.ts (offer when off, continue when on).

import type { ChatMeta } from './chats.ts';

/**
 * What the resumed agent is told (to the model, so English like the other agent prompts): Orca's
 * AGENT_SESSION_RESTART_CONTINUATION_MESSAGE with Kingu's name.
 */
export const RESUME_PROMPT =
	"Kingu restarted, so your previous reply was cut off partway through. Before continuing, check whether your most recent action completed — don't repeat it if it did. Then carry on.";

/** How much of a cut-off reply the resume message quotes (its end: where to pick up). */
export const PARTIAL_TAIL = 600;

/**
 * The resume message. `partial`: the reply Kingu's checkpoint kept (Kingu-only; Claude Code keeps
 * only whole messages, so the agent never saw where its streamed reply stopped).
 */
export function resumePrompt(partial?: string | null): string {
	const text = partial?.trim();
	if (!text) return RESUME_PROMPT;
	const tail = text.length > PARTIAL_TAIL ? `…${text.slice(-PARTIAL_TAIL)}` : text;
	return `${RESUME_PROMPT}\n\nYour reply had reached this point when it was cut off:\n\n<cut-off-reply>\n${tail}\n</cut-off-reply>`;
}

/** The chats to continue: saved as working, with a session to resume, and no run in this app session. */
export function chatsToResume(list: readonly ChatMeta[], hasRun: (id: string) => boolean): ChatMeta[] {
	return list.filter((c) => c.working && !!c.session_id && !hasRun(c.id));
}

/** The chats that still offer Resume (cut off, not continued or dismissed yet), newest first. */
export function interruptedChats(list: readonly ChatMeta[]): ChatMeta[] {
	return list.filter((c) => !!c.interrupted && !c.side_of).sort((a, b) => (b.interrupted?.at ?? 0) - (a.interrupted?.at ?? 0));
}
