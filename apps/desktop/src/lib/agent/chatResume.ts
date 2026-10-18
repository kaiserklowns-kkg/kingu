// Orca's nativeChatResumeWorkOnRestart (`kingu.chat.resumeWorkOnRestart`): a chat saved with
// `working` (a turn was running) that has no run now was cut off when Kingu quit; on the folder's
// first load it gets one more message so its agent carries on. Pure, so `bun test` covers it.

import type { ChatMeta } from './chats.ts';

/** What the resumed agent is told (to the model, so English like the other agent prompts). */
export const RESUME_PROMPT = 'Kingu was closed while you were working on this. Continue where you left off; if the work was already finished, say so briefly.';

/** The chats to continue: saved as working, with a session to resume, and no run in this app session. */
export function chatsToResume(list: readonly ChatMeta[], hasRun: (id: string) => boolean): ChatMeta[] {
	return list.filter((c) => c.working && !!c.session_id && !hasRun(c.id));
}
