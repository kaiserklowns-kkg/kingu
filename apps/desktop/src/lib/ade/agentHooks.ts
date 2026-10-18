// Agent CLI state from hook events (Orca's agent status store): Claude Code hook payloads (stdin
// of each `--settings` hook), codex `notify` payloads (one per finished turn), and the tagged
// lines of the status hooks Kingu installs for other CLIs (`{ kingu_hook, event, payload }`,
// Rust agent/status_hooks.rs). Each provider's events map to Orca's states the way Orca's
// provider mappers do. Pure.

export type HookPhase = 'starting' | 'working' | 'waiting' | 'idle' | 'ended';
export type HookState = {
	phase: HookPhase;
	/** One line for the card: the tool in use, the notification text, … */
	message?: string;
	/** Waiting on a permission answer in the terminal (counts as "needs input"). */
	permission: boolean;
	/** Waiting on the answer to a question the agent asked (AskUserQuestion, elicitation, …). */
	question: boolean;
	/** Real hook events arrive (not only codex's turn-end notify): the phase can be trusted. */
	hooks?: boolean;
	sessionId?: string;
	/** Unix ms of the latest event. */
	at: number;
};

export const initialHookState = (now: number): HookState => ({ phase: 'starting', permission: false, question: false, at: now });

type Payload = Record<string, unknown>;
type HookEvent = Payload & {
	hook_event_name?: string;
	session_id?: string;
	tool_name?: string;
	message?: string;
	prompt?: string;
	notification_type?: string;
	/** codex notify: `agent-turn-complete` with the session (`thread-id`) and its last answer. */
	type?: string;
	'thread-id'?: string;
	'last-assistant-message'?: string;
	/** A line of Kingu's status hooks: which CLI, which of its events, the CLI's own payload. */
	kingu_hook?: string;
	event?: string;
	payload?: Payload;
};

const firstLine = (s: unknown, max = 80) => {
	const line = (typeof s === 'string' ? s : '').split('\n').find((l) => l.trim())?.trim() ?? '';
	return line.length > max ? line.slice(0, max - 1) + '…' : line;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** AskUserQuestion (claude), request_user_input (codex), ask_user (copilot), AskUser (droid)… (Orca's isAskUserQuestionTool + per-CLI names). */
export function isQuestionTool(name: unknown): boolean {
	if (typeof name !== 'string') return false;
	const n = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
	return n === 'askuserquestion' || n === 'requestuserinput' || n === 'askuser' || n === 'question';
}

/** The first question's text of an AskUserQuestion / request_user_input input, for the card. */
export function questionText(input: unknown): string | undefined {
	const qs = (input as { questions?: { question?: unknown; header?: unknown }[] } | null)?.questions;
	const q = Array.isArray(qs) ? qs[0] : undefined;
	return str(q?.question) ?? str(q?.header) ?? str((input as { question?: unknown } | null)?.question);
}

const toolOf = (p: Payload) => str(p.tool_name) ?? str(p.toolName) ?? str(p.name) ?? str((p.tool as Payload | undefined)?.name);
const inputOf = (p: Payload) => p.tool_input ?? p.toolInput ?? p.input ?? p.args ?? p.arguments;

type Patch = Partial<Pick<HookState, 'phase' | 'permission' | 'question' | 'message'>>;
const working = (message?: string): Patch => ({ phase: 'working', permission: false, question: false, ...(message ? { message } : {}) });
const idle = (message = 'จบรอบ รอคุณ'): Patch => ({ phase: 'idle', permission: false, question: false, message });
const permission = (tool?: string, message?: string): Patch => ({ phase: 'waiting', permission: true, question: false, message: message || (tool ? `ขออนุญาตใช้ ${tool}` : 'รอคุณอนุญาต') });
const question = (input: unknown): Patch => ({ phase: 'waiting', permission: false, question: true, message: firstLine(questionText(input)) || 'agent ถามคุณ' });
const usingTool = (p: Payload) => {
	const tool = toolOf(p);
	return working(tool ? `ใช้ ${tool}` : 'กำลังทำงาน');
};

/** gemini (Orca gemini-events): before/after tool and agent are work; AfterAgent ends the turn. */
function gemini(ev: string, p: Payload): Patch | null {
	switch (ev) {
		case 'BeforeAgent':
			return working(firstLine(p.prompt) || 'กำลังทำงาน');
		case 'BeforeTool':
		case 'PreToolUse':
			return usingTool(p);
		case 'AfterTool':
		case 'PostToolUse':
			return working();
		case 'AfterAgent':
			return idle(firstLine(p.prompt_response) || undefined);
		default:
			return null;
	}
}

/** cursor-agent (Orca cursor-events): its gate hooks fire on every call, so they mean work. */
function cursor(ev: string, p: Payload, prev: HookState): Patch | null {
	switch (ev) {
		case 'beforeSubmitPrompt':
			return working(firstLine(p.prompt) || 'กำลังทำงาน');
		case 'preToolUse':
		case 'beforeShellExecution':
		case 'beforeMCPExecution':
			return working(str(p.command) ? `รัน ${firstLine(p.command, 60)}` : toolOf(p) ? `ใช้ ${toolOf(p)}` : 'กำลังทำงาน');
		case 'postToolUse':
		case 'postToolUseFailure':
		case 'sessionStart':
			return working();
		case 'afterAgentResponse':
			return prev.phase === 'idle' ? { message: firstLine(p.text) || prev.message } : working(firstLine(p.text) || undefined);
		case 'stop':
		case 'sessionEnd':
			return idle(p.status && p.status !== 'completed' ? 'หยุดกลางคัน' : undefined);
		default:
			return null;
	}
}

const COPILOT_NAMES: Record<string, string> = {
	sessionStart: 'SessionStart',
	sessionEnd: 'SessionEnd',
	userPromptSubmitted: 'UserPromptSubmit',
	preToolUse: 'PreToolUse',
	postToolUse: 'PostToolUse',
	agentStop: 'Stop',
	errorOccurred: 'ErrorOccurred',
	notification: 'Notification',
	permissionRequest: 'PermissionRequest'
};

/** copilot (Orca copilot-events): ask_user and permission/elicitation notifications need you. */
function copilot(ev: string, p: Payload): Patch | null {
	switch (COPILOT_NAMES[ev] ?? ev) {
		case 'SessionStart':
		case 'PostToolUse':
		case 'PostToolUseFailure':
			return working();
		case 'UserPromptSubmit':
			return working(firstLine(p.prompt) || 'กำลังทำงาน');
		case 'Notification':
			if (p.notification_type === 'elicitation_dialog') return question(p);
			if (p.notification_type === 'permission_prompt') return permission(undefined, firstLine(p.message));
			return null;
		case 'PreToolUse':
		case 'PermissionRequest':
			return isQuestionTool(toolOf(p)) ? question(inputOf(p)) : usingTool(p);
		case 'Stop':
		case 'SessionEnd':
			return idle();
		case 'ErrorOccurred':
			return p.recoverable === true ? working() : idle(firstLine(str(p.error) ?? str((p.error as Payload | undefined)?.message)) || 'เกิดข้อผิดพลาด');
		default:
			return null;
	}
}

const highRisk = (p: Payload) => [p, p.tool_input, p.input, p.arguments].some((x) => x && typeof x === 'object' && ((x as Payload).riskLevel === 'high' || (x as Payload).risk_level === 'high'));

/** droid (Orca droid-events). */
function droid(ev: string, p: Payload): Patch | null {
	switch (ev) {
		case 'UserPromptSubmit':
			return working(firstLine(p.prompt) || 'กำลังทำงาน');
		case 'PreToolUse':
			if (isQuestionTool(toolOf(p))) return question(inputOf(p));
			if (highRisk(p)) return permission(toolOf(p));
			return usingTool(p);
		case 'PostToolUse':
			return working();
		case 'PermissionRequest':
			return permission(toolOf(p));
		case 'Notification': {
			const m = typeof p.message === 'string' ? p.message.toLowerCase() : '';
			if (/permission|approve|approval/.test(m)) return permission(undefined, firstLine(p.message));
			if (/waiting for (your )?input/.test(m)) return idle();
			return null;
		}
		case 'Stop':
			return idle(firstLine(p.last_assistant_message) || undefined);
		default:
			return null;
	}
}

/** codex hooks.json (Orca codex-events): request_user_input arrives as PreToolUse while it waits on you. */
function codex(ev: string, p: Payload): Patch | null {
	if (p.agent_id) return null;
	switch (ev) {
		case 'SessionStart':
			return working();
		case 'UserPromptSubmit':
			return working(firstLine(p.prompt) || 'กำลังทำงาน');
		case 'PreToolUse':
			return isQuestionTool(toolOf(p)) ? question(inputOf(p)) : usingTool(p);
		case 'PostToolUse':
			return working();
		case 'PermissionRequest':
			return permission(toolOf(p));
		case 'Stop':
			return idle(firstLine(p.last_assistant_message) || undefined);
		case 'Interrupt':
			return idle('หยุดกลางคัน');
		default:
			return null;
	}
}

/** opencode (Kingu's status plugin; Orca opencode-family-events). */
function opencode(ev: string, p: Payload): Patch | null {
	switch (ev) {
		case 'SessionBusy':
			return working();
		case 'SessionIdle':
			return idle();
		case 'SessionStart':
			return idle('พร้อมรับคำสั่ง');
		case 'PermissionRequest':
			return permission(str(p.permission) ?? str(p.type) ?? toolOf(p), firstLine(p.title) || undefined);
		case 'AskUserQuestion':
			return question(p);
		default:
			return null;
	}
}

const PROVIDERS: Partial<Record<string, (ev: string, p: Payload, prev: HookState) => Patch | null>> = { gemini, cursor, copilot, droid, codex, opencode };

/** Claude Code hook events (Orca claude-events + Kingu's Notification handling). */
function claude(ev: HookEvent): Patch | null {
	switch (ev.hook_event_name) {
		case 'SessionStart':
			return idle('พร้อมรับคำสั่ง');
		case 'UserPromptSubmit':
			return working(firstLine(ev.prompt) || 'กำลังทำงาน');
		case 'PreToolUse':
			// AskUserQuestion runs as a tool that waits for your answer.
			if (isQuestionTool(ev.tool_name)) return question(ev.tool_input);
			return working(ev.tool_name ? `ใช้ ${ev.tool_name}` : 'กำลังทำงาน');
		case 'PermissionRequest':
			return isQuestionTool(ev.tool_name) ? question(ev.tool_input) : permission(ev.tool_name);
		case 'PostToolUse':
			return working();
		case 'Notification': {
			if (ev.notification_type === 'elicitation_dialog') return { ...question(null), message: firstLine(ev.message) || 'agent ถามคุณ' };
			// "Claude needs your permission to use Bash" vs. "Claude is waiting for your input".
			const perm = ev.notification_type === 'permission_prompt' || /permission/i.test(ev.message ?? '');
			return { phase: 'waiting', permission: perm, question: false, message: firstLine(ev.message) || 'รอคุณ' };
		}
		case 'Stop':
			return idle();
		case 'SessionEnd':
			return { phase: 'ended', permission: false, question: false, message: 'จบ session' };
		default:
			return null;
	}
}

export function applyHook(state: HookState, event: object, now: number): HookState {
	const ev = event as HookEvent;
	if (ev.type === 'agent-turn-complete') {
		const sessionId = typeof ev['thread-id'] === 'string' && ev['thread-id'] ? ev['thread-id'] : state.sessionId;
		return { ...state, at: now, sessionId, phase: 'idle', permission: false, question: false, message: firstLine(ev['last-assistant-message']) || 'จบรอบ รอคุณ' };
	}
	if (typeof ev.kingu_hook === 'string') {
		const map = PROVIDERS[ev.kingu_hook];
		const p: Payload = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
		const patch = map && typeof ev.event === 'string' ? map(ev.event, p, state) : null;
		if (!patch) return state;
		const sessionId = str(p.session_id) ?? str(p.sessionID) ?? state.sessionId;
		return { ...state, ...patch, hooks: true, at: now, sessionId };
	}
	const patch = claude(ev);
	if (!patch) return state;
	return { ...state, ...patch, hooks: true, at: now, sessionId: ev.session_id ?? state.sessionId };
}

/** Needs you: a permission answer or a question's answer. */
export const needsInput = (h: HookState) => h.phase === 'waiting' && (h.permission || h.question);
