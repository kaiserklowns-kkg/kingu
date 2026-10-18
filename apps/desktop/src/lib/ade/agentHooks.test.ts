import { describe, expect, test } from 'bun:test';
import { applyHook, initialHookState } from './agentHooks';
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
