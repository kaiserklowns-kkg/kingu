import { describe, expect, test } from 'bun:test';
import { autoApprover } from './toolApproval';
import type { AgentEvent } from './events';

const ask = (request_id: string, tool: string): AgentEvent => ({
	kind: 'permission_request',
	request_id,
	tool,
	tool_use_id: null,
	title: null,
	input_summary: '',
	detail: null,
	diff: null,
	input: {},
	can_always: true
});

describe('chat.tools.global.autoApprove', () => {
	test('approves tool prompts, not questions or Kingu’s always-ask checks', () => {
		let on = true;
		const seen = autoApprover(() => on);
		expect(seen(ask('r1', 'Bash'))).toBe('r1');
		expect(seen(ask('r2', 'AskUserQuestion'))).toBeNull();
		expect(seen(ask('r3', 'ExitPlanMode'))).toBeNull();
		expect(seen({ kind: 'guard_asked', request_id: 'r4', tool: 'Bash', tool_use_id: null, check: 'delete', paths: ['a'] })).toBeNull();
		expect(seen(ask('r4', 'Bash'))).toBeNull();
		expect(seen({ kind: 'message', role: 'assistant', text: 'hi' })).toBeNull();
		on = false;
		expect(seen(ask('r5', 'Edit'))).toBeNull();
	});
});
