/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { applyEvent, formatUsage, initialRun, isLive, MAX_ITEMS, slugify, toolArg, type AgentEvent, type PermissionRequest } from './events';

const perm = (id: string, tool = 'Bash'): PermissionRequest => ({
	kind: 'permission_request',
	request_id: id,
	tool,
	tool_use_id: null,
	title: null,
	input_summary: 'rm -rf build',
	detail: null,
	diff: null,
	input: { command: 'rm -rf build' },
	can_always: true
});

const result = (cost: number): AgentEvent => ({
	kind: 'result',
	subtype: 'success',
	is_error: false,
	result: 'done',
	session_id: 's-1',
	num_turns: 2,
	duration_ms: 10,
	total_cost_usd: cost,
	usage: { input_tokens: 1200, output_tokens: 34, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
});

function fold(events: AgentEvent[]) {
	const s = initialRun();
	for (const ev of events) applyEvent(s, ev);
	return s;
}

describe('applyEvent', () => {
	test('session commands and context usage are kept on the run, not in the timeline', () => {
		const names: AgentEvent = { kind: 'session_info', slash_commands: ['compact', 'review'], tools: [], mcp_servers: [] };
		let s = fold([names]);
		expect(s.commands.map((c) => c.name)).toEqual(['compact', 'review']);
		s = fold([names, { kind: 'commands', commands: [{ name: 'compact', description: 'Summarize', argument_hint: '' }] }, names]);
		// A later init's names do not replace the list with descriptions.
		expect(s.commands).toEqual([{ name: 'compact', description: 'Summarize', argument_hint: '' }]);
		s = fold([{ kind: 'context_usage', used_tokens: 1000, max_tokens: 200000 }, { kind: 'context_usage', used_tokens: 5, max_tokens: 0 }]);
		expect(s.context).toEqual({ used: 1000, max: 200000 });
		expect(s.items).toEqual([]);
	});

	test('a turn with a permission prompt: running → waiting → running → idle', () => {
		const s = initialRun();
		expect(s.status).toBe('starting');
		applyEvent(s, { kind: 'message', role: 'user', text: 'clean up' });
		applyEvent(s, { kind: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5' });
		expect([s.status, s.sessionId, s.model]).toEqual(['running', 's-1', 'claude-opus-5-5']);
		applyEvent(s, perm('r1'));
		expect(s.status).toBe('waiting');
		expect(s.pending.map((p) => p.request_id)).toEqual(['r1']);
		applyEvent(s, { kind: 'permission_resolved', request_id: 'r1', decision: 'allow' });
		expect([s.status, s.pending.length, s.decisions.r1]).toEqual(['running', 0, 'allow']);
		applyEvent(s, result(0.02));
		expect(s.status).toBe('idle');
		expect(s.result?.total_cost_usd).toBe(0.02);
		expect(isLive(s)).toBe(true);
		// Bookkeeping events stay out of the timeline.
		expect(s.items.map((e) => e.kind)).toEqual(['message', 'system', 'permission_request', 'result']);
	});

	test('streams deltas into a draft that the full message replaces', () => {
		const s = fold([
			{ kind: 'delta', block: 'thinking', text: 'hm' },
			{ kind: 'delta', block: 'text', text: 'สวัส' },
			{ kind: 'delta', block: 'text', text: 'ดี' }
		]);
		expect(s.draft).toEqual({ text: 'สวัสดี', thinking: 'hm' });
		expect(s.items).toEqual([]);
		applyEvent(s, { kind: 'thinking', text: 'hm' });
		applyEvent(s, { kind: 'message', role: 'assistant', text: 'สวัสดี' });
		expect(s.draft).toEqual({ text: '', thinking: '' });
		expect(s.items).toHaveLength(2);
	});

	test('several pending prompts keep the run waiting until all are answered', () => {
		const s = fold([perm('a'), perm('b', 'Edit')]);
		applyEvent(s, { kind: 'permission_resolved', request_id: 'a', decision: 'deny' });
		expect(s.status).toBe('waiting');
		applyEvent(s, { kind: 'permission_resolved', request_id: 'b', decision: 'allow_always' });
		expect(s.status).toBe('running');
	});

	test('exit ends the run and cancels what is still pending', () => {
		const s = fold([perm('a'), { kind: 'exit', code: null, signal: null, stopped: true }]);
		expect([s.status, s.ended, s.pending.length, s.decisions.a]).toEqual(['stopped', true, 0, 'cancelled']);
		expect(isLive(s)).toBe(false);
		// Late events after exit do not revive it.
		applyEvent(s, perm('late'));
		expect([s.status, s.pending.length]).toEqual(['stopped', 0]);
	});

	test('failures', () => {
		expect(fold([{ kind: 'error', message: 'agent host exited' }, { kind: 'exit', code: 0, signal: null, stopped: false }]).status).toBe('failed');
		expect(fold([{ kind: 'exit', code: 1, signal: null, stopped: false }]).status).toBe('failed');
		expect(fold([{ kind: 'exit', code: null, signal: 9, stopped: false }]).status).toBe('failed');
		expect(fold([result(0), { kind: 'exit', code: 0, signal: null, stopped: false }]).status).toBe('done');
	});

	test('a follow-up after a result makes the run busy again', () => {
		const s = fold([result(0.01), { kind: 'message', role: 'user', text: 'and the tests?' }]);
		expect(s.status).toBe('running');
	});

	test('caps the timeline', () => {
		const s = initialRun();
		for (let i = 0; i < MAX_ITEMS + 5; i++) applyEvent(s, { kind: 'raw', line: String(i) });
		expect(s.items).toHaveLength(MAX_ITEMS);
		expect(s.items[0]).toEqual({ kind: 'raw', line: '5' });
	});
});

test('formatUsage', () => {
	expect(formatUsage(result(0.0123) as never)).toBe('$0.0123 · 1.2k in · 34 out · 2 turns');
	expect(formatUsage({ total_cost_usd: null, usage: null, num_turns: null })).toBe('');
});

test('slugify and toolArg still behave', () => {
	expect(slugify('Fix Login Bug!')).toBe('fix-login-bug');
	expect(slugify('แก้บั๊ก')).toMatch(/^task-/);
	expect(toolArg({ command: 'ls   -la' })).toBe('ls -la');
});
