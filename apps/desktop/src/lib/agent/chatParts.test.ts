/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { buildTurns, isInternal, lastRequest, promptHistory, responseText, shortPath, toolLabel, type Turn } from './chatParts';
import { applyEvent, initialRun, type AgentEvent, type PermissionRequest } from './events';
import { assemblePrompt } from './chatPrompt';

const result = (text: string | null, extra: Partial<Extract<AgentEvent, { kind: 'result' }>> = {}): AgentEvent => ({
	kind: 'result',
	subtype: 'success',
	is_error: false,
	result: text,
	session_id: 's-1',
	num_turns: 1,
	duration_ms: 10,
	total_cost_usd: 0.01,
	usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	...extra
});

const perm = (id: string, tool = 'Bash'): PermissionRequest => ({
	kind: 'permission_request',
	request_id: id,
	tool,
	tool_use_id: 'tu-1',
	title: null,
	input_summary: 'npm test',
	detail: null,
	diff: null,
	input: { command: 'npm test' },
	can_always: true
});

function fold(events: AgentEvent[]) {
	const s = initialRun();
	for (const ev of events) applyEvent(s, ev);
	return s;
}

const kinds = (turn: Turn) => turn.parts.map((p) => p.kind);

describe('buildTurns', () => {
	test('each chat turn knows its checkpoint (request index) for Restore checkpoint', () => {
		const run = fold([
			{ kind: 'message', role: 'user', text: 'first' },
			{ kind: 'checkpoint', request: 0 },
			{ kind: 'message', role: 'assistant', text: 'a' },
			{ kind: 'message', role: 'user', text: 'second' },
			{ kind: 'checkpoint', request: 1 },
			{ kind: 'message', role: 'assistant', text: 'b' }
		]);
		expect(buildTurns(run).map((t) => [t.request?.text, t.checkpoint])).toEqual([
			['first', 0],
			['second', 1]
		]);
	});

	test('a request and its response; the result text is not shown again', () => {
		const run = fold([
			{ kind: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5' },
			{ kind: 'message', role: 'user', text: 'what is 2+2?' },
			{ kind: 'message', role: 'assistant', text: '4' },
			result('4')
		]);
		const turns = buildTurns(run);
		expect(turns).toHaveLength(1);
		expect(turns[0].request?.text).toBe('what is 2+2?');
		expect(turns[0].parts).toEqual([{ kind: 'markdown', text: '4' }]);
		expect(turns[0].done).toBe(true);
		expect(turns[0].result?.total_cost_usd).toBe(0.01);
	});

	test('session start, stderr and unknown SDK messages are hidden', () => {
		const events: AgentEvent[] = [
			{ kind: 'system', subtype: 'init', session_id: 's', model: 'm' },
			{ kind: 'message', role: 'user', text: 'hi' },
			{ kind: 'raw', line: '{"type":"rate_limit_event","rate_limit_info":{}}' },
			{ kind: 'stderr', line: 'debug: something' },
			{ kind: 'message', role: 'assistant', text: 'hello' }
		];
		const turns = buildTurns(fold(events));
		expect(turns).toHaveLength(1);
		expect(kinds(turns[0])).toEqual(['markdown']);
		expect(events.filter(isInternal).map((e) => e.kind)).toEqual(['system', 'raw', 'stderr']);
	});

	test('tool calls pair with their results; thinking stays a part', () => {
		const turns = buildTurns(
			fold([
				{ kind: 'message', role: 'user', text: 'read it' },
				{ kind: 'thinking', text: 'Let me look.' },
				{ kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/r/src/x.ts' } },
				{ kind: 'tool_result', tool_use_id: 't1', content: 'export {}', is_error: false },
				{ kind: 'message', role: 'assistant', text: 'It exports nothing.' },
				result('It exports nothing.')
			])
		);
		expect(kinds(turns[0])).toEqual(['thinking', 'tool', 'markdown']);
		expect(turns[0].parts[1]).toMatchObject({ kind: 'tool', name: 'Read', result: { content: 'export {}', isError: false } });
	});

	test('a pending approval is a confirmation part; once allowed only the tool row stays', () => {
		const run = fold([
			{ kind: 'message', role: 'user', text: 'test it' },
			{ kind: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'npm test' } },
			perm('p1')
		]);
		expect(kinds(buildTurns(run)[0])).toEqual(['tool', 'confirmation']);
		applyEvent(run, { kind: 'permission_resolved', request_id: 'p1', decision: 'allow' });
		expect(kinds(buildTurns(run)[0])).toEqual(['tool']);
		const denied = fold([{ kind: 'message', role: 'user', text: 'x' }, perm('p2'), { kind: 'permission_resolved', request_id: 'p2', decision: 'deny' }]);
		expect(kinds(buildTurns(denied)[0])).toEqual(['confirmation']);
	});

	test('streaming text and thinking are the last parts while the turn runs', () => {
		const run = fold([
			{ kind: 'message', role: 'user', text: 'go' },
			{ kind: 'delta', block: 'thinking', text: 'hmm' },
			{ kind: 'delta', block: 'text', text: 'Work' }
		]);
		const [turn] = buildTurns(run);
		expect(turn.done).toBe(false);
		expect(turn.parts).toEqual([
			{ kind: 'thinking', text: 'hmm', streaming: true },
			{ kind: 'markdown', text: 'Work', streaming: true }
		]);
	});

	test('errors: an error result is an error part (no success text), an empty one is "stopped"', () => {
		const failed = buildTurns(fold([{ kind: 'message', role: 'user', text: 'x' }, result('API overloaded', { is_error: true, subtype: 'error_during_execution' })]));
		expect(failed[0].parts).toEqual([{ kind: 'error', message: 'API overloaded' }]);
		const interrupted = buildTurns(fold([{ kind: 'message', role: 'user', text: 'x' }, { kind: 'message', role: 'assistant', text: 'part' }, result(null, { is_error: true })]));
		expect(kinds(interrupted[0])).toEqual(['markdown', 'canceled']);
	});

	test('a crashed agent is an error once; a session ended mid-turn is "stopped"', () => {
		const crashed = buildTurns(fold([{ kind: 'message', role: 'user', text: 'x' }, { kind: 'error', message: 'boom' }, { kind: 'exit', code: 1, signal: null, stopped: false }]));
		expect(crashed[0].parts).toEqual([{ kind: 'error', message: 'boom' }]);
		const exited = buildTurns(fold([{ kind: 'message', role: 'user', text: 'x' }, { kind: 'exit', code: 2, signal: null, stopped: false }]));
		expect(exited[0].parts).toEqual([{ kind: 'error', message: 'The agent exited with code 2' }]);
		const stopped = buildTurns(fold([{ kind: 'message', role: 'user', text: 'x' }, { kind: 'exit', code: null, signal: null, stopped: true }]));
		expect(kinds(stopped[0])).toEqual(['canceled']);
		expect(stopped[0].done).toBe(true);
	});

	test('several turns; the request shows what was typed, the attached files as chips', () => {
		const sent = assemblePrompt('explain this', [{ path: 'src/a.ts', range: { startLine: 3, endLine: 9 }, content: 'code' }]);
		const run = fold([
			{ kind: 'message', role: 'user', text: 'first' },
			{ kind: 'message', role: 'assistant', text: 'one' },
			result('one'),
			{ kind: 'message', role: 'user', text: `${sent}\n\n[แนบรูป: shot.png]` },
			{ kind: 'message', role: 'assistant', text: 'two' },
			{ kind: 'message', role: 'assistant', text: 'three' },
			result('three')
		]);
		const turns = buildTurns(run);
		expect(turns).toHaveLength(2);
		expect(turns[1].request).toMatchObject({ text: 'explain this', files: [{ path: 'src/a.ts', range: { startLine: 3, endLine: 9 } }], images: ['shot.png'] });
		expect(responseText(turns[1])).toBe('two\n\nthree');
		expect(lastRequest(turns)?.text).toBe('explain this');
		expect(promptHistory(turns)).toEqual(['first', 'explain this']);
	});

	test('a replayed transcript ends every turn', () => {
		const run = fold([{ kind: 'message', role: 'user', text: 'x' }, { kind: 'message', role: 'assistant', text: 'y' }]);
		run.ended = true;
		expect(buildTurns(run)[0].done).toBe(true);
	});
});

describe('tool rows', () => {
	test('labels, running then past tense, paths relative to the agent folder', () => {
		expect(toolLabel('Read', { file_path: '/r/src/x.ts' }, true, '/r')).toBe('Read src/x.ts');
		expect(toolLabel('Edit', { file_path: '/r/y.ts' }, false, '/r')).toBe('Editing y.ts');
		expect(toolLabel('Bash', { command: 'npm   test' }, true)).toBe('Ran `npm test`');
		expect(toolLabel('Grep', { pattern: 'TODO' }, true)).toBe('Searched for "TODO"');
		expect(toolLabel('mcp__github__get_issue', { query: '#12' }, true)).toBe('Ran get_issue (github): #12');
		expect(toolLabel('Mystery', {}, false)).toBe('Running Mystery');
		expect(shortPath('/elsewhere/z.ts', '/r')).toBe('/elsewhere/z.ts');
	});
});
