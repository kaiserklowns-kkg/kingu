// Agent CLI state from Claude Code hook events (the JSON each hook gets on stdin): Kingu's version
// of Orca's agent state dot. Pure, so `bun test` covers it.

export type HookPhase = 'starting' | 'working' | 'waiting' | 'idle' | 'ended';
export type HookState = {
	phase: HookPhase;
	/** One line for the card: the tool in use, the notification text, … */
	message?: string;
	/** Waiting on a permission answer in the terminal (counts as "needs input"). */
	permission: boolean;
	sessionId?: string;
	/** Unix ms of the latest event. */
	at: number;
};

export const initialHookState = (now: number): HookState => ({ phase: 'starting', permission: false, at: now });

type HookEvent = { hook_event_name?: string; session_id?: string; tool_name?: string; message?: string; prompt?: string };

const firstLine = (s: string | undefined, max = 80) => {
	const line = (s ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
	return line.length > max ? line.slice(0, max - 1) + '…' : line;
};

export function applyHook(state: HookState, ev: HookEvent, now: number): HookState {
	const base = { ...state, at: now, sessionId: ev.session_id ?? state.sessionId };
	switch (ev.hook_event_name) {
		case 'SessionStart':
			return { ...base, phase: 'idle', permission: false, message: 'พร้อมรับคำสั่ง' };
		case 'UserPromptSubmit':
			return { ...base, phase: 'working', permission: false, message: firstLine(ev.prompt) || 'กำลังทำงาน' };
		case 'PreToolUse':
			return { ...base, phase: 'working', permission: false, message: ev.tool_name ? `ใช้ ${ev.tool_name}` : 'กำลังทำงาน' };
		case 'PostToolUse':
			return { ...base, phase: 'working', permission: false };
		case 'Notification': {
			// "Claude needs your permission to use Bash" vs. "Claude is waiting for your input".
			const permission = /permission/i.test(ev.message ?? '');
			return { ...base, phase: 'waiting', permission, message: firstLine(ev.message) || 'รอคุณ' };
		}
		case 'Stop':
			return { ...base, phase: 'idle', permission: false, message: 'จบรอบ รอคุณ' };
		case 'SessionEnd':
			return { ...base, phase: 'ended', permission: false, message: 'จบ session' };
		default:
			return state;
	}
}
