import { describe, expect, test } from 'bun:test';
import { applyHook, initialHookState, isQuestionTool, needsInput } from './agentHooks';
import { claudeResume, claudeStart } from './agentCli';

const run = (events: object[]) => events.reduce((s: ReturnType<typeof initialHookState>, e, i) => applyHook(s, e, i + 1), initialHookState(0));

describe('agent hooks', () => {
	test('a turn: started, working with a tool, then done', () => {
		const s = run([{ hook_event_name: 'SessionStart', session_id: 's1' }, { hook_event_name: 'UserPromptSubmit', prompt: 'แก้บั๊ก\nรายละเอียด' }]);
		expect(s).toMatchObject({ phase: 'working', message: 'แก้บั๊ก', sessionId: 's1' });
		expect(applyHook(s, { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 9).message).toBe('ใช้ Bash');
		expect(applyHook(s, { hook_event_name: 'Stop' }, 9)).toMatchObject({ phase: 'idle', permission: false });
	});
	test('a permission notification needs you; an idle one only waits', () => {
		expect(run([{ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }])).toMatchObject({ phase: 'waiting', permission: true });
		expect(run([{ hook_event_name: 'Notification', message: 'Claude is waiting for your input' }])).toMatchObject({ phase: 'waiting', permission: false });
	});
	test('unknown events change nothing', () => {
		const s = initialHookState(0);
		expect(applyHook(s, { hook_event_name: 'PreCompact' }, 5)).toBe(s);
	});
});

describe('questions', () => {
	test('claude AskUserQuestion and elicitation are questions, not permissions', () => {
		const q = run([{ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'ใช้ branch ไหน?', header: 'Branch' }] } }]);
		expect(q).toMatchObject({ phase: 'waiting', question: true, permission: false, message: 'ใช้ branch ไหน?' });
		expect(needsInput(q)).toBe(true);
		expect(applyHook(q, { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' }, 9)).toMatchObject({ phase: 'working', question: false });
		expect(run([{ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'MCP server asks' }])).toMatchObject({ question: true, message: 'MCP server asks' });
		expect(run([{ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }])).toMatchObject({ phase: 'waiting', permission: true, message: 'ขออนุญาตใช้ Bash' });
		expect(needsInput(run([{ hook_event_name: 'Notification', message: 'Claude is waiting for your input' }]))).toBe(false);
	});
	test('question tool names across CLIs', () => {
		for (const n of ['AskUserQuestion', 'request_user_input', 'ask_user', 'AskUser']) expect(isQuestionTool(n)).toBe(true);
		expect(isQuestionTool('Bash')).toBe(false);
	});
});

const tagged = (kingu_hook: string, event: string, payload: object = {}) => ({ kingu_hook, event, payload });

describe('status hooks of other CLIs (Orca provider mappings)', () => {
	test('gemini: work until AfterAgent', () => {
		const s = run([tagged('gemini', 'BeforeAgent', { prompt: 'fix' }), tagged('gemini', 'BeforeTool', { tool_name: 'run_shell_command' })]);
		expect(s).toMatchObject({ phase: 'working', message: 'ใช้ run_shell_command', hooks: true });
		expect(applyHook(s, tagged('gemini', 'AfterAgent', { prompt_response: 'เสร็จแล้ว' }), 9)).toMatchObject({ phase: 'idle', message: 'เสร็จแล้ว' });
	});
	test('cursor: gates are work, stop ends the turn', () => {
		const s = run([tagged('cursor', 'beforeShellExecution', { command: 'npm test' })]);
		expect(s).toMatchObject({ phase: 'working', message: 'รัน npm test' });
		const done = applyHook(s, tagged('cursor', 'stop', { status: 'completed' }), 9);
		expect(done).toMatchObject({ phase: 'idle' });
		expect(applyHook(done, tagged('cursor', 'afterAgentResponse', { text: 'สรุป' }), 10)).toMatchObject({ phase: 'idle', message: 'สรุป' });
	});
	test('copilot: ask_user is a question, a permission prompt needs you', () => {
		expect(run([tagged('copilot', 'preToolUse', { toolName: 'ask_user', toolArgs: {} })])).toMatchObject({ question: true });
		expect(run([tagged('copilot', 'Notification', { notification_type: 'permission_prompt', message: 'Allow?' })])).toMatchObject({ permission: true, message: 'Allow?' });
		expect(run([tagged('copilot', 'agentStop', {})])).toMatchObject({ phase: 'idle' });
	});
	test('droid: high risk and permission requests need you', () => {
		expect(run([tagged('droid', 'PreToolUse', { tool_name: 'Execute', tool_input: { riskLevel: 'high' } })])).toMatchObject({ permission: true });
		expect(run([tagged('droid', 'Notification', { message: 'Droid is waiting for your input' })])).toMatchObject({ phase: 'idle' });
		expect(run([tagged('droid', 'PermissionRequest', { tool_name: 'Edit' })])).toMatchObject({ permission: true, message: 'ขออนุญาตใช้ Edit' });
	});
	test('codex hooks: approvals, request_user_input, interrupt; subagents ignored', () => {
		expect(run([tagged('codex', 'PermissionRequest', { tool_name: 'Bash', session_id: 'c1' })])).toMatchObject({ permission: true, sessionId: 'c1' });
		const q = run([tagged('codex', 'PreToolUse', { tool_name: 'request_user_input', tool_input: { questions: [{ id: 'c', header: 'Color', question: 'Which color?' }] } })]);
		expect(q).toMatchObject({ question: true, message: 'Which color?' });
		expect(run([tagged('codex', 'Interrupt')])).toMatchObject({ phase: 'idle', message: 'หยุดกลางคัน' });
		expect(run([tagged('codex', 'PreToolUse', { tool_name: 'Bash', agent_id: 'sub' })]).phase).toBe('starting');
	});
	test('opencode plugin events', () => {
		expect(run([tagged('opencode', 'SessionBusy')]).phase).toBe('working');
		expect(run([tagged('opencode', 'AskUserQuestion', { questions: [{ question: 'Which?' }] })])).toMatchObject({ question: true, message: 'Which?' });
		expect(run([tagged('opencode', 'PermissionRequest', { permission: 'bash' })])).toMatchObject({ permission: true, message: 'ขออนุญาตใช้ bash' });
		expect(run([tagged('opencode', 'SessionIdle')]).phase).toBe('idle');
	});
	test('a codex notify line alone does not claim hooks', () => {
		const s = run([{ type: 'agent-turn-complete', 'thread-id': 't', 'last-assistant-message': 'ok' }]);
		expect(s).toMatchObject({ phase: 'idle', sessionId: 't', message: 'ok' });
		expect(s.hooks).toBeUndefined();
		expect(run([tagged('nobody', 'X')]).phase).toBe('starting');
	});
});

describe('claude argv', () => {
	test('start: our session id and the hooks before the prompt', () => {
		expect(claudeStart(['claude'], 'งาน', 'sid', '{"hooks":{}}')).toEqual(['claude', '--session-id', 'sid', '--settings', '{"hooks":{}}', 'งาน']);
		expect(claudeStart(['claude'], 'งาน', 'sid', null)).toEqual(['claude', '--session-id', 'sid', 'งาน']);
	});
	test('resume this session when known, else the latest', () => {
		expect(claudeResume(['claude'], 'sid', null)).toEqual(['claude', '--resume', 'sid']);
		expect(claudeResume(['claude'], null, 'S')).toEqual(['claude', '--continue', '--settings', 'S']);
	});
});
