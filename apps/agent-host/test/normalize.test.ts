import { describe, expect, test } from 'bun:test';
import { contextTokensOf, contextWindowOf, MAX_TOOL_RESULT_CHARS, normalize, ruleTexts, slashCommands, summarizeTool } from '../src/normalize.ts';

describe('normalize', () => {
	test('maps init, assistant blocks, tool results and results', () => {
		expect(normalize({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5' })).toEqual([
			{ kind: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5' }
		]);
		expect(normalize({ type: 'system', subtype: 'status', status: 'compacting' })).toEqual([]);
		expect(
			normalize({
				type: 'assistant',
				message: {
					content: [
						{ type: 'thinking', thinking: 'คิดก่อน' },
						{ type: 'text', text: 'อ่านไฟล์ก่อนนะ' },
						{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/r/a' } }
					]
				}
			})
		).toEqual([
			{ kind: 'thinking', text: 'คิดก่อน' },
			{ kind: 'message', role: 'assistant', text: 'อ่านไฟล์ก่อนนะ' },
			{ kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/r/a' } }
		]);
		expect(normalize({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '# Kingu' }], is_error: true }] } })).toEqual([
			{ kind: 'tool_result', tool_use_id: 't1', content: '# Kingu', is_error: true }
		]);
		const [r] = normalize({ type: 'result', subtype: 'error_max_turns', is_error: false, errors: ['too many turns'], usage: { input_tokens: 3, output_tokens: 4 } });
		expect(r).toMatchObject({ kind: 'result', is_error: true, result: 'too many turns', total_cost_usd: null, usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0 } });
	});

	test('keeps the uuid of main-chain messages as an anchor after their events', () => {
		const uuid = '0b5e9a1c-4c1d-4e2f-9a3b-1234567890ab';
		expect(normalize({ type: 'assistant', uuid, message: { content: [{ type: 'text', text: 'เสร็จ' }] } })).toEqual([
			{ kind: 'message', role: 'assistant', text: 'เสร็จ' },
			{ kind: 'anchor', uuid }
		]);
		expect(normalize({ type: 'user', uuid, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }).at(-1)).toEqual({ kind: 'anchor', uuid });
		// A subagent's messages, replays and malformed uuids are not resume points.
		expect(normalize({ type: 'assistant', uuid, parent_tool_use_id: 'tu1', message: { content: 'x' } }).some((e) => e.kind === 'anchor')).toBe(false);
		expect(normalize({ type: 'user', uuid, isReplay: true, message: { content: 'x' } }).some((e) => e.kind === 'anchor')).toBe(false);
		expect(normalize({ type: 'assistant', uuid: 'x; rm', message: { content: 'x' } }).some((e) => e.kind === 'anchor')).toBe(false);
		expect(normalize({ type: 'result', subtype: 'success', uuid }).some((e) => e.kind === 'anchor')).toBe(false);
	});

	test("a subagent's messages carry its Task call's id; its prompt is dropped", () => {
		const parent = 'task-1';
		expect(
			normalize({
				type: 'assistant',
				parent_tool_use_id: parent,
				message: {
					content: [
						{ type: 'thinking', thinking: 'ดูก่อน' },
						{ type: 'text', text: 'กำลังค้น' },
						{ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'x' } }
					]
				}
			})
		).toEqual([
			{ kind: 'thinking', text: 'ดูก่อน', parent_tool_use_id: parent },
			{ kind: 'message', role: 'assistant', text: 'กำลังค้น', parent_tool_use_id: parent },
			{ kind: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'x' }, parent_tool_use_id: parent }
		]);
		expect(
			normalize({
				type: 'user',
				parent_tool_use_id: parent,
				message: { content: [{ type: 'text', text: 'Find x' }, { type: 'tool_result', tool_use_id: 't2', content: 'a.ts:1' }] }
			})
		).toEqual([{ kind: 'tool_result', tool_use_id: 't2', content: 'a.ts:1', is_error: false, parent_tool_use_id: parent }]);
		expect(normalize({ type: 'user', parent_tool_use_id: parent, message: { content: 'Find x' } })).toEqual([]);
		// Main-agent events stay without the field.
		expect(normalize({ type: 'assistant', parent_tool_use_id: null, message: { content: 'hi' } })).toEqual([{ kind: 'message', role: 'assistant', text: 'hi' }]);
	});

	test('maps text and thinking deltas of the main agent only', () => {
		const delta = (d: object, parent: string | null = null) => normalize({ type: 'stream_event', event: { type: 'content_block_delta', delta: d }, parent_tool_use_id: parent });
		expect(delta({ type: 'text_delta', text: 'สวัส' })).toEqual([{ kind: 'delta', block: 'text', text: 'สวัส' }]);
		expect(delta({ type: 'thinking_delta', thinking: 'hm' })).toEqual([{ kind: 'delta', block: 'thinking', text: 'hm' }]);
		expect(delta({ type: 'input_json_delta', partial_json: '{' })).toEqual([]);
		expect(delta({ type: 'text_delta', text: 'sub' }, 'tu1')).toEqual([]);
	});

	test('truncates huge tool results and passes unknown messages through', () => {
		const big = 'ก'.repeat(MAX_TOOL_RESULT_CHARS + 10);
		const [ev] = normalize({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big }] } });
		expect(ev?.kind === 'tool_result' && Array.from(ev.content).length).toBe(MAX_TOOL_RESULT_CHARS + 1);
		expect(normalize({ type: 'rate_limit_event' })).toEqual([{ kind: 'raw', line: '{"type":"rate_limit_event"}' }]);
		expect(normalize('nope')[0]?.kind).toBe('raw');
		expect(normalize({ type: 'assistant' })[0]?.kind).toBe('raw');
	});

	test('keeps what the session started with and its command list', () => {
		const init = { type: 'system', subtype: 'init', session_id: 's', model: 'm', slash_commands: ['compact', 'review', 7], tools: ['Bash'], mcp_servers: [{ name: 'gh', status: 'connected', source: 'sdk' }, { status: 'x' }] };
		expect(normalize(init)[1]).toEqual({ kind: 'session_info', slash_commands: ['compact', 'review'], tools: ['Bash'], mcp_servers: [{ name: 'gh', status: 'connected' }] });
		const changed = { type: 'system', subtype: 'commands_changed', commands: [{ name: 'deploy', description: 'Ship it', argumentHint: '<env>' }] };
		expect(normalize(changed)).toEqual([{ kind: 'commands', commands: [{ name: 'deploy', description: 'Ship it', argument_hint: '<env>' }] }]);
		expect(slashCommands([{ name: '/a', description: 'x' }, { name: 'a', description: 'dup' }, { description: 'no name' }, null])).toEqual([{ name: 'a', description: 'x', argument_hint: '' }]);
		expect(slashCommands('nope')).toEqual([]);
	});

	test('reads the context window and the main agent\'s last call', () => {
		expect(contextWindowOf({ modelUsage: { opus: { contextWindow: 200000 }, haiku: { contextWindow: 100000 } } })).toBe(200000);
		expect(contextWindowOf({ modelUsage: {} })).toBeNull();
		expect(contextWindowOf({})).toBeNull();
		const usage = { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20, output_tokens: 100 };
		expect(contextTokensOf({ type: 'assistant', parent_tool_use_id: null, message: { usage } })).toBe(1125);
		expect(contextTokensOf({ type: 'assistant', parent_tool_use_id: 'tu1', message: { usage } })).toBeNull();
		expect(contextTokensOf({ type: 'user', message: { usage } })).toBeNull();
	});

	test('turns permission suggestions into readable rules', () => {
		const suggestions = [
			{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'WebFetch' }] },
			{ type: 'addRules', behavior: 'deny', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }] },
			{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }
		];
		expect(ruleTexts(suggestions)).toEqual(['Bash(npm test:*)', 'WebFetch']);
		expect(ruleTexts(undefined)).toEqual([]);
	});
});

describe('summarizeTool', () => {
	test('bash shows the command and its description', () => {
		expect(summarizeTool('Bash', { command: 'bun test', description: 'Run tests' })).toEqual({ summary: 'bun test', detail: 'Run tests', diff: null });
	});
	test('edits show the path and line stats', () => {
		expect(summarizeTool('Edit', { file_path: '/r/a.ts', old_string: 'a\nb', new_string: 'a\nb\nc' })).toEqual({ summary: '/r/a.ts', detail: null, diff: { added: 3, removed: 2 } });
		expect(summarizeTool('Write', { file_path: '/r/n.ts', content: 'x\ny\n' }).diff).toEqual({ added: 3, removed: 0 });
		expect(summarizeTool('MultiEdit', { file_path: '/r/m', edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: 'd', new_string: '' }] }).diff).toEqual({ added: 2, removed: 2 });
	});
	test('other tools fall back to a key argument', () => {
		expect(summarizeTool('WebFetch', { url: 'https://x.dev', prompt: 'p' })).toMatchObject({ summary: 'https://x.dev', detail: 'p' });
		expect(summarizeTool('mcp__gh__create_issue', { title: 't' }).summary).toBe('{"title":"t"}');
		expect(summarizeTool('Bash', { command: 'x'.repeat(900) }).summary.length).toBe(501);
	});
});
