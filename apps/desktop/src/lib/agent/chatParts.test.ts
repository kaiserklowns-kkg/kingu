/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { buildTurns, editOf, feedbackTarget, isInternal, isSubagentTool, lastRequest, latestTodos, parseTodos, planOf, promptHistory, responseText, shortPath, subagentStats, todoProgress, toolLabel, type TodoStatus, type ToolPart, type Turn } from './chatParts';
import { applyEvent, initialRun, type AgentEvent, type PermissionRequest } from './events';
import { assemblePrompt } from './chatPrompt';
import { turnBusy } from './chatInput';

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

describe('subagents', () => {
	test("a Task call holds its subagent's text, thinking and tool calls; the main response goes on after it", () => {
		const run = fold([
			{ kind: 'message', role: 'user', text: 'look around' },
			{ kind: 'tool_use', id: 'task', name: 'Task', input: { description: 'Explore', prompt: 'find x' } },
			{ kind: 'thinking', text: 'hm', parent_tool_use_id: 'task' },
			{ kind: 'message', role: 'assistant', text: 'searching', parent_tool_use_id: 'task' },
			{ kind: 'message', role: 'assistant', text: 'more', parent_tool_use_id: 'task' },
			{ kind: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'x' }, parent_tool_use_id: 'task' },
			{ kind: 'tool_result', tool_use_id: 'g', content: 'a.ts:1', is_error: false, parent_tool_use_id: 'task' },
			{ kind: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'a.ts' }, parent_tool_use_id: 'task' },
			{ kind: 'tool_result', tool_use_id: 'task', content: 'found in a.ts', is_error: false },
			{ kind: 'message', role: 'assistant', text: 'done' },
			result('done')
		]);
		const [turn] = buildTurns(run);
		expect(kinds(turn)).toEqual(['tool', 'markdown']);
		const task = turn.parts[0] as ToolPart;
		expect(task.result?.content).toBe('found in a.ts');
		expect(task.children?.map((p) => p.kind)).toEqual(['thinking', 'markdown', 'tool', 'tool']);
		expect(task.children?.[1]).toMatchObject({ kind: 'markdown', text: 'searching\n\nmore' });
		expect((task.children?.[2] as ToolPart).result?.content).toBe('a.ts:1');
		const stats = subagentStats(task);
		expect([stats.tools, stats.running, [...stats.ids]]).toEqual([2, 1, ['g', 'r']]);
		expect(isSubagentTool('Agent')).toBe(true);
	});

	test("a subagent's prompt is not a request, and does not clear the main agent's streaming text", () => {
		const run = fold([
			{ kind: 'message', role: 'user', text: 'go' },
			{ kind: 'tool_use', id: 'task', name: 'Task', input: {} },
			{ kind: 'delta', block: 'text', text: 'main…' },
			{ kind: 'message', role: 'user', text: 'sub prompt', parent_tool_use_id: 'task' },
			{ kind: 'message', role: 'assistant', text: 'sub reply', parent_tool_use_id: 'task' }
		]);
		expect(run.draft.text).toBe('main…');
		const turns = buildTurns(run);
		expect(turns.length).toBe(1);
		expect(kinds(turns[0])).toEqual(['tool', 'markdown']);
		expect((turns[0].parts[0] as ToolPart).children).toEqual([{ kind: 'markdown', text: 'sub reply' }]);
	});

	test('events whose call is unknown (e.g. trimmed from the timeline) stay in the response', () => {
		const run = fold([{ kind: 'message', role: 'assistant', text: 'orphan', parent_tool_use_id: 'gone' }]);
		expect(kinds(buildTurns(run)[0])).toEqual(['markdown']);
	});
});

describe('todos, plans and edits', () => {
	const todos = [
		{ content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
		{ content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
		{ content: 'Run tests', status: 'pending', activeForm: '' },
		{ content: '', status: 'pending' },
		'junk'
	];

	test('the latest TodoWrite of the main agent is the list', () => {
		const run = fold([
			{ kind: 'message', role: 'user', text: 'go' },
			{ kind: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'old', status: 'pending', activeForm: 'old' }] } },
			{ kind: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos } },
			{ kind: 'tool_use', id: 'task', name: 'Task', input: {} },
			{ kind: 'tool_use', id: 't3', name: 'TodoWrite', input: { todos: [] }, parent_tool_use_id: 'task' }
		]);
		const list = latestTodos(buildTurns(run))!;
		expect(list).toEqual([
			{ content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
			{ content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
			{ content: 'Run tests', status: 'pending', activeForm: 'Run tests' }
		]);
		expect(todoProgress(list)).toMatchObject({ done: 1, total: 3, n: 2, inProgress: true, current: { content: 'Fix the bug' } });
		expect(latestTodos([])).toBeNull();
		expect(parseTodos({})).toBeNull();
	});

	test('progress: next not started item when none runs; all done', () => {
		const p = (s: string[]) => todoProgress(s.map((status, i) => ({ content: `t${i}`, activeForm: `t${i}`, status: status as TodoStatus })));
		expect(p(['completed', 'pending'])).toMatchObject({ n: 1, current: { content: 't1' }, inProgress: false });
		expect(p(['pending', 'pending'])).toMatchObject({ n: 1, current: { content: 't0' } });
		expect(p(['completed', 'completed'])).toMatchObject({ done: 2, n: 2, current: null });
	});

	test('plan text and edit stats', () => {
		expect(planOf({ plan: '# Plan\n- a' })).toBe('# Plan\n- a');
		expect(planOf({ plan: '  ' })).toBeNull();
		expect(editOf('Edit', { file_path: '/r/a.ts', old_string: 'a\nb', new_string: 'c' })).toEqual({ path: '/r/a.ts', added: 1, removed: 2 });
		expect(editOf('MultiEdit', { file_path: 'b.ts', edits: [{ old_string: 'x', new_string: 'y\nz' }, { old_string: '', new_string: 'w' }] })).toEqual({ path: 'b.ts', added: 3, removed: 1 });
		expect(editOf('Write', { file_path: 'c.ts', content: '1\n2\n3' })).toEqual({ path: 'c.ts', added: 3, removed: 0 });
		expect(editOf('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'x' })).toEqual({ path: 'n.ipynb', added: 1, removed: 0 });
		expect(editOf('Read', { file_path: 'a.ts' })).toBeNull();
		expect(editOf('Edit', {})).toBeNull();
	});
});

describe('"How did the agent do?"', () => {
	const done = (extra: AgentEvent[] = []): AgentEvent[] => [
		{ kind: 'message', role: 'user', text: 'fix it' },
		{ kind: 'checkpoint', request: 0 },
		{ kind: 'message', role: 'assistant', text: 'fixed' },
		{ kind: 'result', subtype: 'success', is_error: false, result: 'fixed', session_id: 's', num_turns: 1, duration_ms: 5, total_cost_usd: null },
		...extra
	];
	const target = (events: AgentEvent[]) => {
		const run = fold(events);
		return feedbackTarget(buildTurns(run), turnBusy(run));
	};

	test('asks about the last request once its answer is done, not while it runs or after a vote', () => {
		expect(target(done())).toBe(0);
		expect(target(done().slice(0, 3))).toBeNull();
		expect(target(done([{ kind: 'feedback', request: 0, vote: 'up' }]))).toBeNull();
		expect(target(done([{ kind: 'feedback', request: 0, vote: 'up' }, { kind: 'feedback', request: 0, vote: null }]))).toBe(0);
		expect(target(done([{ kind: 'message', role: 'user', text: 'more' }, { kind: 'checkpoint', request: 1 }]))).toBeNull();
	});

	test('output after the last request (an exit error, an error line) does not hide it', () => {
		expect(target(done([{ kind: 'exit', code: 1, signal: null, stopped: false }]))).toBe(0);
		expect(target(done([{ kind: 'error', message: 'the session closed' }]))).toBe(0);
		expect(target(done([{ kind: 'exit', code: 0, signal: null, stopped: false }]))).toBe(0);
	});

	test('nothing to ask without a checkpoint to keep the vote on, or an answer', () => {
		expect(target(done().filter((e) => e.kind !== 'checkpoint'))).toBeNull();
		expect(target([{ kind: 'message', role: 'assistant', text: 'before any request' }, { kind: 'exit', code: 0, signal: null, stopped: false }])).toBeNull();
	});
});
