import { describe, expect, test } from 'bun:test';
import { chatHandoffSessions, chatRuntimeFor } from './sessionHandoff';

describe('session handoff to agent chat', () => {
	test('claude CLI sessions (and old timeline ones) go to the claude runtime', () => {
		expect(chatRuntimeFor('cli:claude --model opus')).toBe('claude');
		expect(chatRuntimeFor('cli:/opt/bin/claude')).toBe('claude');
		expect(chatRuntimeFor('claude-code')).toBe('claude');
	});

	test('CLIs with their own session store are not offered', () => {
		expect(chatRuntimeFor('cli:codex')).toBeNull();
		expect(chatRuntimeFor('cli:gemini')).toBeNull();
		expect(chatRuntimeFor('cli:mycli')).toBeNull();
	});

	test("only the task's claude sessions, newest first", () => {
		const meta = {
			session_id: 'c3',
			agent: 'cli:claude',
			updated_at: 30,
			sessions: [
				{ id: 'x2', agent: 'cli:codex', at: 20 },
				{ id: 'c1', agent: 'cli:claude', at: 10 }
			]
		};
		expect(chatHandoffSessions(meta).map((s) => s.id)).toEqual(['c3', 'c1']);
		expect(chatHandoffSessions({ session_id: null, agent: 'cli:codex', updated_at: 0 })).toEqual([]);
	});
});
