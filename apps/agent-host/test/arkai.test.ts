// Arkai's parts (arkai/): text tool calls, the tool coach, context fitting, a chat's history, the
// built-in tools and both API clients against a fake server (fixtures/fake-llm.ts). No model.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicClient, anthropicMessages } from '../src/arkai/anthropic.ts';
import { coachInput, hintFor, HINTS, parseArguments } from '../src/arkai/coach.ts';
import { conversationTokens, fitContext, SUMMARY_HEADER, summarise } from '../src/arkai/context.ts';
import { historyMessages, NO_RESULT } from '../src/arkai/history.ts';
import { hasLeftoverToolCall, recoverToolCalls, stripToolMarkup } from '../src/arkai/leftover.ts';
import { ThinkSplitter, type CompletionRequest, type Msg } from '../src/arkai/messages.ts';
import { OpenAiClient, openaiMessages } from '../src/arkai/openai.ts';
import { LIGHT_SYSTEM_PROMPT, systemPrompt } from '../src/arkai/prompt.ts';
import { arkaiDecision, granted, ruleFor, toolDisallowed } from '../src/arkai/session.ts';
import { arkaiSpec, modelOf, type ArkaiProvider } from '../src/arkai/spec.ts';
import { runTool, TOOL_DEFS, toolDefs } from '../src/arkai/tools.ts';
import { FakeLlm } from './fixtures/fake-llm.ts';

const servers: FakeLlm[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fake() {
	const s = new FakeLlm();
	servers.push(s);
	return s;
}

function tmp() {
	const d = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-arkai-')));
	dirs.push(d);
	return d;
}

const TOOLS = toolDefs(false);

describe('text tool calls (leftover.ts)', () => {
	test('Qwen XML becomes a real call with typed parameters', () => {
		const text = 'I will write it.\n<function=Write>\n<parameter=file_path>\na.js\n</parameter>\n<parameter=content>\nx = 1\n</parameter>\n</function>';
		const r = recoverToolCalls(text, TOOLS)!;
		expect(r.calls).toEqual([{ name: 'Write', arguments: JSON.stringify({ file_path: 'a.js', content: 'x = 1' }) }]);
		expect(r.text).toBe('I will write it.');
		const typed = recoverToolCalls('<function=Read><parameter=file_path>a</parameter><parameter=offset>5</parameter></function>', TOOLS)!;
		expect(JSON.parse(typed.calls[0]!.arguments)).toEqual({ file_path: 'a', offset: 5 });
	});

	test('a JSON call is recovered, an unknown tool or a fenced example is not', () => {
		const r = recoverToolCalls('<tool_call>{"name": "Bash", "arguments": {"command": "ls"}}</tool_call>', TOOLS)!;
		expect(r.calls).toEqual([{ name: 'Bash', arguments: '{"command":"ls"}' }]);
		expect(r.text).toBe('');
		expect(recoverToolCalls('{"name": "Hack", "arguments": {}}', TOOLS)).toBeUndefined();
		expect(recoverToolCalls('Use this:\n```json\n{"name": "Bash", "arguments": {"command": "ls"}}\n```', TOOLS)).toBeUndefined();
		expect(recoverToolCalls('no calls here', TOOLS)).toBeUndefined();
	});

	test('leftover markup is found outside fences and stripped', () => {
		expect(hasLeftoverToolCall('<tool_call>\n{"name": "nope"')).toBe(true);
		expect(hasLeftoverToolCall('```\n<tool_call>\n```')).toBe(false);
		expect(stripToolMarkup('Done.\n<|tool_call_begin|>junk<|tool_call_end|>')).toBe('Done.');
		expect(stripToolMarkup('plain <parameter> text')).toBe('plain <parameter> text');
	});
});

describe('tool coach (coach.ts)', () => {
	test('arguments that are not quite JSON are repaired', () => {
		expect(parseArguments('```json\n{"a": 1}\n```')).toEqual({ input: { a: 1 } });
		expect(parseArguments('{"a": [1, 2,],}')).toEqual({ input: { a: [1, 2] } });
		expect(parseArguments('"{\\"a\\": 1}"')).toEqual({ input: { a: 1 } });
		expect(parseArguments('')).toEqual({ input: {} });
		expect('error' in parseArguments('{oops')).toBe(true);
		expect('error' in parseArguments('[1]')).toBe(true);
	});

	test('common slips are put right', () => {
		expect(coachInput('Read', { path: 'a.ts' })).toEqual({ file_path: 'a.ts' });
		expect(coachInput('Grep', { pattern: 'x', directory: 'src' })).toEqual({ pattern: 'x', path: 'src' });
		expect(coachInput('Edit', { file_path: 'a', old_str: 'x', new_str: 'y' })).toEqual({ file_path: 'a', old_string: 'x', new_string: 'y' });
		expect(coachInput('Write', { file_path: 'a.ts', content: '"line\\n"' })).toEqual({ file_path: 'a.ts', content: 'line\n' });
		expect(coachInput('Write', { file_path: 'a.json', content: '"str"' }).content).toBe('"str"');
		const same = { file_path: 'a' };
		expect(coachInput('Read', same)).toBe(same);
	});

	test('a failed call gets one hint', () => {
		expect(hintFor('Edit', 'old_string was not found in a.ts')).toBe(HINTS.editTextNotFound);
		expect(hintFor('Read', 'File does not exist: /x')).toBe(HINTS.fileNotFound);
		expect(hintFor('Bash', 'Invalid arguments: not valid JSON')).toBe(HINTS.invalidArguments);
		expect(hintFor('Bash', 'Exit code 1')).toBeUndefined();
		expect(hintFor('Edit', `x ${HINTS.editTextNotFound}`)).toBeUndefined();
	});
});

describe('context window (context.ts)', () => {
	const turn = (n: number, size: number): Msg[] => [
		{ role: 'user', text: `question ${n}` },
		{ role: 'assistant', text: '', calls: [{ id: `c${n}`, name: 'Write', arguments: JSON.stringify({ file_path: `f${n}.ts`, content: 'x' }) }] },
		{ role: 'tool', id: `c${n}`, name: 'Write', content: 'y'.repeat(size), isError: false },
		{ role: 'assistant', text: `answer ${n}`, calls: [] }
	];

	test('a conversation that fits is left alone', () => {
		const msgs = turn(1, 100);
		expect(fitContext(msgs, { window: 32_000, maxTokens: 4000, fixed: 1000 }).messages).toBe(msgs);
	});

	test('old tool results are cut first, then the oldest turns are summarised; the current turn stays', () => {
		const msgs = [...turn(1, 20_000), ...turn(2, 20_000), ...turn(3, 20_000), { role: 'user' as const, text: 'now this' }];
		const cut = fitContext(msgs, { window: 16_000, maxTokens: 2000, fixed: 1000 });
		expect(cut.compacted).toBe(true);
		expect(cut.droppedTurns).toBe(0);
		expect(cut.messages.filter((m) => m.role === 'tool').every((m) => m.role === 'tool' && m.content.length < 1000)).toBe(true);

		const big = Array.from({ length: 30 }, (_, i) => turn(i, 500)).flat();
		big.push({ role: 'user', text: 'the latest question' });
		const fitted = fitContext(big, { window: 4000, maxTokens: 1000, fixed: 500 });
		expect(fitted.droppedTurns).toBeGreaterThan(0);
		const first = fitted.messages[0]!;
		expect(first.role).toBe('user');
		expect(first.role === 'user' && first.text.startsWith(SUMMARY_HEADER)).toBe(true);
		// The newest of the dropped turns are the ones kept when the summary is too long.
		const dropped = fitted.droppedTurns - 1;
		expect(first.role === 'user' && first.text).toContain(`- The user asked: question ${dropped}\n  Files changed: f${dropped}.ts\n  You answered: answer ${dropped}`);
		expect(fitted.messages[fitted.messages.length - 1]).toEqual({ role: 'user', text: 'the latest question' });
		expect(conversationTokens(fitted.messages)).toBeLessThan(4000 - 1000 - 500);
	});

	test('a summary of a summary keeps the earlier lines', () => {
		const s1 = summarise([...turn(1, 10)], 2000);
		const s2 = summarise([{ role: 'user', text: `${s1}\n\nquestion 2` }, { role: 'assistant', text: 'answer 2', calls: [] }], 2000);
		expect(s2).toContain('question 1');
		expect(s2).toContain('question 2');
		expect(s2.split(SUMMARY_HEADER).length).toBe(2);
	});
});

describe("a chat's history (history.ts)", () => {
	test('transcript events become the conversation; a call without its result gets one', () => {
		const events = [
			{ kind: 'system', subtype: 'init', session_id: 's', model: 'm' },
			{ kind: 'message', role: 'user', text: 'make a.txt' },
			{ kind: 'message', role: 'assistant', text: 'Writing it.' },
			{ kind: 'tool_use', id: 'c1', name: 'Write', input: { file_path: 'a.txt', content: 'hi' } },
			{ kind: 'tool_result', tool_use_id: 'c1', content: 'Created a.txt', is_error: false },
			{ kind: 'message', role: 'assistant', text: 'Done.' },
			{ kind: 'result', subtype: 'success' },
			{ kind: 'message', role: 'user', text: 'run it' },
			{ kind: 'tool_use', id: 'c2', name: 'Bash', input: { command: 'cat a.txt' } },
			{ kind: 'message', role: 'assistant', text: 'sub', parent_tool_use_id: 'x' }
		];
		expect(historyMessages(events)).toEqual([
			{ role: 'user', text: 'make a.txt' },
			{ role: 'assistant', text: 'Writing it.', calls: [{ id: 'c1', name: 'Write', arguments: '{"file_path":"a.txt","content":"hi"}' }] },
			{ role: 'tool', id: 'c1', name: 'Write', content: 'Created a.txt', isError: false },
			{ role: 'assistant', text: 'Done.', calls: [] },
			{ role: 'user', text: 'run it' },
			{ role: 'assistant', text: '', calls: [{ id: 'c2', name: 'Bash', arguments: '{"command":"cat a.txt"}' }] },
			{ role: 'tool', id: 'c2', name: 'Bash', content: NO_RESULT, isError: true }
		]);
	});
});

describe('spec and prompts', () => {
	const provider = { id: 'ollama', name: 'Ollama', api: 'openai', baseUrl: 'http://127.0.0.1:11434/v1/', models: [{ id: 'small', contextWindow: 8192 }, { id: 'big', contextWindow: 128_000, light: false }] };

	test('the spec is checked', () => {
		const s = arkaiSpec({ kind: 'arkai', provider, model: 'small' });
		expect(s.provider.baseUrl).toBe('http://127.0.0.1:11434/v1');
		expect(() => arkaiSpec({ kind: 'arkai', provider: { ...provider, id: 'Bad Id' }, model: 'x' })).toThrow();
		expect(() => arkaiSpec({ kind: 'arkai', provider: { ...provider, baseUrl: 'file:///etc' }, model: 'x' })).toThrow();
		expect(() => arkaiSpec({ kind: 'arkai', provider: { ...provider, api: 'gemini' }, model: 'x' })).toThrow();
		expect(() => arkaiSpec({ kind: 'arkai', provider, model: '' })).toThrow();
	});

	test('a small window means light mode, with six tools and the short prompt', () => {
		const p = arkaiSpec({ kind: 'arkai', provider, model: 'small' }).provider;
		expect(modelOf(p, 'small')).toEqual({ id: 'small', contextWindow: 8192, maxTokens: 2048, light: true });
		expect(modelOf(p, 'big').light).toBe(false);
		expect(modelOf(p, 'unlisted').contextWindow).toBe(32_768);
		expect(toolDefs(true).map((t) => t.name)).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']);
		expect(systemPrompt(true, { cwd: '/w', platform: 'darwin', date: '2026-01-01', model: 'm' }, 'RULES')).toBe(LIGHT_SYSTEM_PROMPT);
		const full = systemPrompt(false, { cwd: '/w', platform: 'darwin', date: '2026-01-01', model: 'm' }, 'RULES');
		expect(full).toContain('Arkai');
		expect(full).toContain('/w');
		expect(full.endsWith('RULES')).toBe(true);
	});
});

describe('permissions', () => {
	test('disallowed tools follow the SDK rules', () => {
		expect(toolDisallowed('Bash', ['Bash'])).toBe(true);
		expect(toolDisallowed('Read', ['Bash'])).toBe(false);
		expect(toolDisallowed('mcp__gh__search', ['mcp__gh'])).toBe(true);
		expect(toolDisallowed('mcp__gh__search', ['mcp__gh__*'])).toBe(true);
		expect(toolDisallowed('mcp__gh__search', ['mcp__*'])).toBe(true);
		expect(toolDisallowed('mcp__gh__search', ['mcp__gh__search'])).toBe(true);
		expect(toolDisallowed('mcp__gh__search', ['mcp__gh__list', 'mcp__ghx'])).toBe(false);
		expect(toolDisallowed('mcp__ghx__search', ['mcp__gh'])).toBe(false);
		expect(toolDisallowed('Bash', ['mcp__*'])).toBe(false);
	});

	test('each mode decides what it can by itself', () => {
		expect(arkaiDecision('default', 'read')).toBe('allow');
		expect(arkaiDecision('default', 'edit')).toBeNull();
		expect(arkaiDecision('acceptEdits', 'edit')).toBe('allow');
		expect(arkaiDecision('acceptEdits', 'execute')).toBeNull();
		expect(arkaiDecision('plan', 'edit')).toBe('deny');
		expect(arkaiDecision('plan', 'think')).toBe('allow');
		expect(arkaiDecision('bypassPermissions', 'execute')).toBe('allow');
	});

	test('"allow always" on a command covers that command, not a chain', () => {
		const bash = (command: string) => ({ name: 'Bash', kind: 'execute' as const, paths: [], input: { command } });
		expect(ruleFor(bash('npm test -- a'))).toEqual({ text: 'Bash(npm test:*)', key: 'Bash:npm test' });
		expect(ruleFor(bash('ls -la'))).toEqual({ text: 'Bash(ls:*)', key: 'Bash:ls' });
		const grants = new Set(['Bash:npm test']);
		expect(granted(grants, bash('npm test'))).toBe(true);
		expect(granted(grants, bash('npm test --watch'))).toBe(true);
		expect(granted(grants, bash('npm testing'))).toBe(false);
		expect(granted(grants, bash('npm test && rm -rf x'))).toBe(false);
		expect(ruleFor(bash('a | b')).key).toBe('Bash=a | b');
		expect(granted(new Set(['Edit']), { name: 'Edit', kind: 'edit', paths: [], input: {} })).toBe(true);
	});
});

describe('built-in tools (tools.ts)', () => {
	const ctx = (cwd: string) => ({ cwd, env: process.env, signal: new AbortController().signal, grep: 'js' as const });

	test('Read, Write and Edit', async () => {
		const cwd = tmp();
		expect((await runTool('Write', { file_path: 'src/a.ts', content: 'one\ntwo\nthree\n' }, ctx(cwd))).content).toBe('Created src/a.ts (4 lines)');
		const read = await runTool('Read', { file_path: 'src/a.ts', offset: 2, limit: 1 }, ctx(cwd));
		expect(read.content).toBe('     2\ttwo\n… (1 more lines: read on with offset 3)');
		expect((await runTool('Edit', { file_path: join(cwd, 'src/a.ts'), old_string: 'two', new_string: '2' }, ctx(cwd))).isError).toBe(false);
		expect(readFileSync(join(cwd, 'src/a.ts'), 'utf8')).toBe('one\n2\nthree\n');
		const missing = await runTool('Edit', { file_path: 'src/a.ts', old_string: 'nope', new_string: 'x' }, ctx(cwd));
		expect(missing).toEqual({ content: 'old_string was not found in src/a.ts', isError: true });
		writeFileSync(join(cwd, 'b.txt'), 'x x');
		expect((await runTool('Edit', { file_path: 'b.txt', old_string: 'x', new_string: 'y' }, ctx(cwd))).isError).toBe(true);
		expect((await runTool('Edit', { file_path: 'b.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx(cwd))).content).toBe('Edited b.txt (2 places)');
		expect((await runTool('Read', { file_path: 'nope.txt' }, ctx(cwd))).isError).toBe(true);
		expect((await runTool('Read', {}, ctx(cwd))).content).toContain('missing required');
	});

	test('Glob and Grep skip node_modules and .git', async () => {
		const cwd = tmp();
		mkdirSync(join(cwd, 'src/deep'), { recursive: true });
		mkdirSync(join(cwd, 'node_modules/x'), { recursive: true });
		writeFileSync(join(cwd, 'src/a.ts'), 'const needle = 1;\n');
		writeFileSync(join(cwd, 'src/deep/b.ts'), 'NEEDLE\n');
		writeFileSync(join(cwd, 'node_modules/x/c.ts'), 'needle\n');
		expect((await runTool('Glob', { pattern: '**/*.ts' }, ctx(cwd))).content).toBe('src/a.ts\nsrc/deep/b.ts');
		expect((await runTool('Glob', { pattern: 'b.ts' }, ctx(cwd))).content).toBe('src/deep/b.ts');
		expect((await runTool('Grep', { pattern: 'needle' }, ctx(cwd))).content).toBe('src/a.ts:1:const needle = 1;');
		expect((await runTool('Grep', { pattern: 'needle', '-i': true, output_mode: 'files_with_matches' }, ctx(cwd))).content).toBe('src/a.ts\nsrc/deep/b.ts');
		expect((await runTool('Grep', { pattern: '(' }, ctx(cwd))).isError).toBe(true);
	});

	test('Bash runs in the folder and reports its exit code', async () => {
		const cwd = tmp();
		expect(await runTool('Bash', { command: 'pwd' }, ctx(cwd))).toEqual({ content: cwd, isError: false });
		expect(await runTool('Bash', { command: 'echo out; echo err >&2; exit 3' }, ctx(cwd))).toEqual({ content: 'out\nerr\nExit code 3', isError: true });
		const r = await runTool('Bash', { command: 'sleep 5', timeout: 100 }, ctx(cwd));
		expect(r.isError && r.content.includes('stopped after 100 ms')).toBe(true);
	});

	test('TodoWrite hands the list on', async () => {
		let got: unknown = null;
		const r = await runTool('TodoWrite', { todos: [{ content: 'a', status: 'in_progress' }, { content: '', status: 'x' }] }, { ...ctx(tmp()), todos: (t) => (got = t) });
		expect(r.content).toBe('Todo list updated (1 items, 1 open)');
		expect(got).toEqual([{ content: 'a', status: 'in_progress', activeForm: 'a' }]);
		expect(Object.keys(TOOL_DEFS)).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'WebFetch']);
	});
});

describe('API clients against a fake server', () => {
	const provider = (url: string, api: 'openai' | 'anthropic' = 'openai'): ArkaiProvider => ({ id: 'fake', name: 'Fake', api, baseUrl: api === 'openai' ? `${url}/v1` : url, apiKey: 'sk-test', headers: { 'X-Extra': '1' }, models: [] });
	const req = (over: Partial<CompletionRequest> = {}) => {
		const got = { text: '', thinking: '' };
		const r: CompletionRequest = {
			model: 'm',
			system: 'sys',
			messages: [{ role: 'user', text: 'hi' }],
			tools: toolDefs(true),
			maxTokens: 100,
			signal: new AbortController().signal,
			onText: (t) => (got.text += t),
			onThinking: (t) => (got.thinking += t),
			...over
		};
		return { r, got };
	};

	test('OpenAI: streamed text, thinking, tool calls in pieces and usage', async () => {
		const llm = fake().reply({ reasoning: ['hmm'], text: ['<think>more</think>', 'Hel', 'lo'], calls: [{ id: 'c1', name: 'Read', args: '{"file_path": "a.ts"}', pieces: 3 }], usage: { prompt_tokens: 50, completion_tokens: 7 } });
		const { r, got } = req();
		const res = await new OpenAiClient(provider(llm.url)).complete(r);
		expect(res).toEqual({ text: 'Hello', calls: [{ id: 'c1', name: 'Read', arguments: '{"file_path": "a.ts"}' }], stop: 'tool_calls', usage: { input: 50, output: 7, cacheRead: 0, cacheWrite: 0 } });
		expect(got).toEqual({ text: 'Hello', thinking: 'hmmmore' });
		const sent = llm.requests[0]!;
		expect(sent.path).toBe('/v1/chat/completions');
		expect(sent.headers.authorization).toBe('Bearer sk-test');
		expect(sent.headers['x-extra']).toBe('1');
		expect(sent.body.messages[0]).toEqual({ role: 'system', content: 'sys' });
		expect(sent.body.tools[0].function.name).toBe('Read');
		expect(sent.body.stream_options).toEqual({ include_usage: true });
	});

	test('OpenAI: a server that refuses stream_options is asked again without it; one that ignores stream is read whole', async () => {
		const llm = fake().reply({ status: 400, body: '{"error":{"message":"Unrecognized request argument: stream_options"}}' }, { text: ['ok'] }, { whole: true, text: ['whole'], calls: [{ name: 'Bash', args: '{"command":"ls"}' }] });
		const client = new OpenAiClient(provider(llm.url));
		expect((await client.complete(req().r)).text).toBe('ok');
		const whole = await client.complete(req().r);
		expect(whole.text).toBe('whole');
		expect(whole.calls[0]!.name).toBe('Bash');
		expect(llm.requests.map((x) => 'stream_options' in x.body)).toEqual([true, false, false]);
	});

	test('OpenAI: an HTTP error carries the status and the provider\'s message, never the key', async () => {
		const llm = fake().reply({ status: 401, body: '{"error":{"message":"bad key"}}' });
		const e = await new OpenAiClient(provider(llm.url)).complete(req().r).catch((x) => x);
		expect(e.status).toBe(401);
		expect(e.message).toBe('Fake: HTTP 401: bad key');
		expect(e.message).not.toContain('sk-test');
	});

	test('OpenAI messages: images, tool calls and results', () => {
		const out = openaiMessages('', [
			{ role: 'user', text: 'see', images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
			{ role: 'assistant', text: '', calls: [{ id: 'c', name: 'Read', arguments: '' }] },
			{ role: 'tool', id: 'c', name: 'Read', content: '', isError: false }
		]);
		expect(out).toEqual([
			{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }, { type: 'text', text: 'see' }] },
			{ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
			{ role: 'tool', tool_call_id: 'c', content: '(no output)' }
		]);
	});

	test('Anthropic: streamed blocks, tool_use input in pieces, results in the user message', async () => {
		const llm = fake().reply({ thinking: ['th'], text: ['Hi'], calls: [{ id: 'toolu_1', name: 'Bash', args: '{"command":"ls"}' }], usage: { input: 40, output: 9 } });
		const { r, got } = req();
		const res = await new AnthropicClient(provider(llm.url, 'anthropic')).complete(r);
		expect(res).toEqual({ text: 'Hi', calls: [{ id: 'toolu_1', name: 'Bash', arguments: '{"command":"ls"}' }], stop: 'tool_calls', usage: { input: 40, output: 9, cacheRead: 0, cacheWrite: 0 } });
		expect(got.thinking).toBe('th');
		const sent = llm.requests[0]!;
		expect(sent.path).toBe('/v1/messages');
		expect(sent.headers['x-api-key']).toBe('sk-test');
		expect(sent.headers['anthropic-version']).toBe('2023-06-01');
		expect(sent.body.system).toBe('sys');
		expect(sent.body.tools[0].input_schema.required).toEqual(['file_path']);
		expect(
			anthropicMessages([
				{ role: 'assistant', text: 'a', calls: [{ id: 'c.1', name: 'Read', arguments: '{"file_path":"x"}' }] },
				{ role: 'tool', id: 'c.1', name: 'Read', content: 'x', isError: true },
				{ role: 'user', text: 'next' }
			])
		).toEqual([
			{ role: 'user', content: [{ type: 'text', text: '(earlier conversation)' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'c_1', name: 'Read', input: { file_path: 'x' } }] },
			{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c_1', content: 'x', is_error: true }, { type: 'text', text: 'next' }] }
		]);
	});

	test('<think> tags split across chunks', () => {
		let text = '';
		let thinking = '';
		const s = new ThinkSplitter(
			(t) => (text += t),
			(t) => (thinking += t)
		);
		for (const c of ['<thi', 'nk>a', 'b</th', 'ink>\n\nAns', 'wer <b>']) s.push(c);
		s.end();
		expect({ text, thinking }).toEqual({ text: 'Answer <b>', thinking: 'ab' });
	});
});
