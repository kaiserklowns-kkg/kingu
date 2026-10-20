// VS Code's `chat.tools.global.autoApprove` ("YOLO mode") for agent chats, pure so `bun test`
// covers it: which permission prompts the chat answers by itself. Never the ones that are
// questions for the user (AskUserQuestion, the plan's ExitPlanMode) and never Kingu's always-ask
// checks (a `guard_asked` before the prompt: writes outside the folder, deletes, protected paths,
// MCP tools), which the user turned on to be asked.

import type { AgentEvent } from './events';

/** Tools whose prompt is a question for the user, not an approval. */
const QUESTIONS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Follows a run's events: `seen` takes each event and says whether it is a permission prompt to
 * approve now (`chat.tools.global.autoApprove` read at that moment through `enabled`).
 */
export function autoApprover(enabled: () => boolean): (ev: AgentEvent) => string | null {
	const guarded = new Set<string>();
	return (ev) => {
		if (ev.kind === 'guard_asked') {
			guarded.add(ev.request_id);
			return null;
		}
		if (ev.kind !== 'permission_request' || guarded.has(ev.request_id) || QUESTIONS.has(ev.tool) || !enabled()) return null;
		return ev.request_id;
	};
}
