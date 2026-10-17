import { describe, expect, test } from 'bun:test';
import { MAX_TOOL_RESULT_CHARS, normalize, summarizeTool } from '../src/normalize.ts';

describe('normalize', () => {
	test('maps init, assistant blocks, tool results and results', () => {
		expect(normalize({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5', tools: [] })).toEqual([
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
