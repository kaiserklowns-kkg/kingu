// Protocol tests with a fake SDK `query()`: no model calls, no Claude Code process.

import { describe, expect, test } from 'bun:test';
import type { Options, PermissionResult, PermissionUpdate, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentHost, decisionResult, imageBlocks, Inbox, MAX_IMAGE_BYTES, runEnv, shownText, type QueryFn } from '../src/host.ts';
import type { AgentEvent } from '../src/protocol.ts';

type Out = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: any; result?: unknown; error?: { code: number; message: string } };

/** A fake session: for each user message, asks to run Bash once and reports the decision. */
function fakeQuery(log: { options?: Options; prompts: string[]; interrupted: number; changes?: string[]; permission?: PermissionResult; tool?: { name: string; input: Record<string, unknown> } }): QueryFn {
	return ({ prompt, options }) => {
		log.options = options;
		const gen = (async function* () {
			yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: options.model };
			for await (const m of prompt as AsyncIterable<SDKUserMessage>) {
				const text = String(m.message.content);
				log.prompts.push(text);
				yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'กำลัง' } }, parent_tool_use_id: null };
				yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf build' } }] } };
				const tool = log.tool ?? { name: 'Bash', input: { command: 'rm -rf build', description: 'Clean' } };
				const r = await options.canUseTool!(tool.name, tool.input, {
					signal: options.abortController!.signal,
					suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }], behavior: 'allow', destination: 'localSettings' }],
					toolUseID: 'tu1',
					requestId: 'cr1'
				});
				log.permission = r ?? undefined;
				yield {
					type: 'result',
					subtype: 'success',
					is_error: false,
					result: r?.behavior === 'allow' ? 'ลบแล้ว' : 'ไม่ได้ลบ',
					session_id: 'sess-1',
					num_turns: 1,
					duration_ms: 10,
					total_cost_usd: 0.01,
					modelUsage: { m: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 } }
				};
			}
		})();
		return Object.assign(gen, {
			interrupt: async () => {
				log.interrupted++;
			},
			setModel: async (model?: string) => {
				(log.changes ??= []).push(`model:${model}`);
			},
			setPermissionMode: async (mode: string) => {
				(log.changes ??= []).push(`mode:${mode}`);
			}
		});
	};
}

function setup() {
	const out: Out[] = [];
	const waiters: { pred: (o: Out) => boolean; resolve: (o: Out) => void }[] = [];
	const log = { prompts: [] as string[], interrupted: 0 } as Parameters<typeof fakeQuery>[0];
	let n = 0;
	const host = new AgentHost({
		query: fakeQuery(log),
		write: (m) => {
			const o = JSON.parse(JSON.stringify(m)) as Out; // must survive the wire
			out.push(o);
			for (const w of [...waiters]) if (w.pred(o)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(o));
		},
		newId: () => `req-${++n}`
	});
	const events = (runId = 1) => out.filter((o) => o.method === 'event' && o.params.runId === runId).map((o) => o.params.event as AgentEvent);
	const next = (pred: (o: Out) => boolean, ms = 2000) =>
		new Promise<Out>((resolve, reject) => {
			const hit = out.find(pred);
			if (hit) return resolve(hit);
			waiters.push({ pred, resolve });
			setTimeout(() => reject(new Error('timed out waiting for host output')), ms);
		});
	const event = (kind: string, after = 0) => next((o) => o.method === 'event' && o.params.event.kind === kind && out.indexOf(o) >= after);
	const call = async (id: number, method: string, params: unknown) => {
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
		return out.findLast((o) => o.id === id)!;
	};
	return { host, out, log, events, event, call };
}

describe('agent host protocol', () => {
	test('start → permission_request → answer allow → result', async () => {
		const { log, events, event, call } = setup();
		const res = await call(1, 'start', { runId: 1, cwd: '/repo/.kingu/worktrees/t', prompt: 'ทำความสะอาด', permissionMode: 'acceptEdits' });
		expect(res.result).toEqual({ runId: 1 });
		expect(log.options).toMatchObject({ cwd: '/repo/.kingu/worktrees/t', model: 'claude-opus-5-5', permissionMode: 'acceptEdits', includePartialMessages: true });

		const req = await event('permission_request');
		expect(req.params.event).toMatchObject({
			request_id: 'req-1',
			tool: 'Bash',
			tool_use_id: 'tu1',
			input_summary: 'rm -rf build',
			detail: 'Clean',
			can_always: true
		});
		expect(log.permission).toBeUndefined(); // waiting for the user

		expect((await call(2, 'answer', { runId: 1, requestId: 'req-1', decision: 'allow' })).result).toBeNull();
		await event('result');
		expect(log.permission).toEqual({ behavior: 'allow', updatedInput: { command: 'rm -rf build', description: 'Clean' } });
		const kinds = events().map((e) => e.kind);
		expect(kinds).toEqual(['message', 'system', 'delta', 'tool_use', 'permission_request', 'permission_resolved', 'result']);
		const result = events().at(-1) as Extract<AgentEvent, { kind: 'result' }>;
		expect(result).toMatchObject({ result: 'ลบแล้ว', total_cost_usd: 0.01, session_id: 'sess-1' });
		expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 });
	});

	test('deny with a message, then a follow-up in the same session, then stop', async () => {
		const { host, log, events, out, event, call } = setup();
		await call(1, 'start', { runId: 1, cwd: '/w', prompt: 'one' });
		await event('permission_request');
		await call(2, 'answer', { runId: 1, requestId: 'req-1', decision: 'deny', message: 'อย่าลบ' });
		await event('result');
		expect(log.permission).toEqual({ behavior: 'deny', message: 'อย่าลบ' });

		const mark = out.length;
		expect((await call(3, 'send', { runId: 1, text: 'two' })).result).toBeNull();
		await event('permission_request', mark);
		await call(4, 'answer', { runId: 1, requestId: 'req-2', decision: 'allow_always' });
		await event('result', mark);
		expect(log.prompts).toEqual(['one', 'two']);
		// Plain "always" is a session-scoped rule, not written to a settings file.
		expect(log.permission).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'addRules', destination: 'session' }] });

		await call(5, 'stop', { runId: 1 });
		const exit = await event('exit');
		expect(exit.params.event).toEqual({ kind: 'exit', code: null, signal: null, stopped: true });
		expect(host.runCount).toBe(0);
		expect(events().filter((e) => e.kind === 'exit')).toHaveLength(1);
		expect((await call(6, 'send', { runId: 1, text: 'three' })).error?.message).toContain('no such run');
	});

	test('stop while a permission is pending cancels it', async () => {
		const { log, events, event, call } = setup();
		await call(1, 'start', { runId: 7, cwd: '/w', prompt: 'x' });
		await event('permission_request');
		await call(2, 'stop', { runId: 7 });
		await event('exit');
		expect(log.permission).toMatchObject({ behavior: 'deny', interrupt: true });
		expect(events(7).find((e) => e.kind === 'permission_resolved')).toEqual({ kind: 'permission_resolved', request_id: 'req-1', decision: 'cancelled' });
	});

	test('interrupt reaches the SDK and cancels pending prompts', async () => {
		const { log, event, call } = setup();
		await call(1, 'start', { runId: 1, cwd: '/w', prompt: 'x' });
		await event('permission_request');
		await call(2, 'interrupt', { runId: 1 });
		expect(log.interrupted).toBe(1);
		expect(log.permission?.behavior).toBe('deny');
	});

	test('lists the session commands and reports the context window after a turn', async () => {
		const out: Out[] = [];
		const asked: string[] = [];
		const host = new AgentHost({
			write: (m) => out.push(JSON.parse(JSON.stringify(m))),
			query: ({ prompt }) => {
				const gen = (async function* () {
					yield { type: 'system', subtype: 'init', session_id: 's', model: 'm', slash_commands: ['compact'], tools: [], mcp_servers: [] };
					for await (const _ of prompt) {
						yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, cache_read_input_tokens: 990, output_tokens: 50 } } };
						yield { type: 'result', subtype: 'success', is_error: false, session_id: 's', modelUsage: { m: { inputTokens: 1, outputTokens: 1, contextWindow: 200000 } } };
					}
				})();
				return Object.assign(gen, {
					interrupt: async () => {},
					supportedCommands: async () => (asked.push('commands'), [{ name: 'compact', description: 'Clear history but keep a summary', argumentHint: '<instructions>' }]),
					supportedModels: async () => (asked.push('models'), [{ value: 'opus', displayName: 'Opus', description: 'Most capable' }])
				});
			}
		});
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'start', params: { runId: 1, cwd: '/w', prompt: 'x' } }));
		const evs = () => out.filter((o) => o.method === 'event').map((o) => o.params.event as AgentEvent);
		for (let i = 0; i < 50 && !evs().some((e) => e.kind === 'context_usage'); i++) await Bun.sleep(2);
		expect(asked).toEqual(['commands', 'models']);
		expect(evs().find((e) => e.kind === 'models')).toEqual({ kind: 'models', models: [{ value: 'opus', display_name: 'Opus', description: 'Most capable' }] });
		expect(evs().find((e) => e.kind === 'commands')).toEqual({ kind: 'commands', commands: [{ name: 'compact', description: 'Clear history but keep a summary', argument_hint: '<instructions>' }] });
		expect(evs().find((e) => e.kind === 'context_usage')).toEqual({ kind: 'context_usage', used_tokens: 1050, max_tokens: 200000 });
		expect(evs().find((e) => e.kind === 'session_info')).toMatchObject({ slash_commands: ['compact'] });
		await host.dispatch('stop', { runId: 1 });
	});

	test('permission requests carry the rules an "always" answer would add', async () => {
		const { event, call } = setup();
		await call(1, 'start', { runId: 1, cwd: '/w', prompt: 'x' });
		expect((await event('permission_request')).params.event.rules).toEqual(['Bash(rm -rf build)']);
		expect((await call(2, 'answer', { runId: 1, requestId: 'req-1', decision: 'allow_never' })).error?.message).toContain('bad decision');
	});

	test('set_options changes the live session model and permission mode', async () => {
		const { log, event, call } = setup();
		await call(1, 'start', { runId: 1, cwd: '/w', prompt: 'x' });
		await event('permission_request');
		expect((await call(2, 'set_options', { runId: 1, model: 'claude-sonnet-5' })).result).toEqual({ model: 'claude-sonnet-5', permissionMode: null });
		expect((await call(3, 'set_options', { runId: 1, permissionMode: 'plan' })).result).toEqual({ model: null, permissionMode: 'plan' });
		expect(log.changes).toEqual(['model:claude-sonnet-5', 'mode:plan']);
		expect((await call(4, 'set_options', { runId: 1, permissionMode: 'dontAsk' })).error?.message).toContain('permission mode');
		// "Allow all" is the user's pick; the session was started able to take it.
		expect((await call(5, 'set_options', { runId: 1, permissionMode: 'bypassPermissions' })).result).toEqual({ model: null, permissionMode: 'bypassPermissions' });
		expect(log.options?.allowDangerouslySkipPermissions).toBe(true);
		expect((await call(5, 'set_options', { runId: 1 })).error?.message).toContain('nothing to change');
		expect((await call(6, 'set_options', { runId: 9, model: 'm' })).error?.code).toBe(1);
		expect(log.changes).toHaveLength(3);
	});

	test('set_options says so when the SDK cannot change options', async () => {
		const out: Out[] = [];
		const host = new AgentHost({
			// A session that waits on its inbox and has no setModel/setPermissionMode.
			query: ({ prompt }) =>
				Object.assign(
					(async function* () {
						for await (const _ of prompt) yield { type: 'system', subtype: 'status' };
					})(),
					{ interrupt: async () => {} }
				),
			write: (m) => out.push(JSON.parse(JSON.stringify(m)))
		});
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'start', params: { runId: 1, cwd: '/w', prompt: 'x' } }));
		const err = await host.dispatch('set_options', { runId: 1, model: 'm' }).catch((e: Error) => e.message);
		expect(String(err)).toContain('cannot change the model');
		await host.dispatch('shutdown', null);
	});

	test('passes model and resume through', async () => {
		const { log, call } = setup();
		await call(1, 'start', { runId: 1, cwd: '/w', prompt: 'x', model: 'claude-sonnet-5', resume: 'sess-0' });
		expect(log.options).toMatchObject({ model: 'claude-sonnet-5', resume: 'sess-0', permissionMode: 'default' });
	});

	test('resumeAt rewinds in a fork of the session; it needs resume and a uuid', async () => {
		const { log, call } = setup();
		const at = '0b5e9a1c-4c1d-4e2f-9a3b-1234567890ab';
		await call(1, 'start', { runId: 1, cwd: '/w', prompt: 'x', resume: 'sess-0', resumeAt: at });
		expect(log.options).toMatchObject({ resume: 'sess-0', resumeSessionAt: at, forkSession: true });
		await call(2, 'start', { runId: 2, cwd: '/w', prompt: 'x', resume: 'sess-0' });
		expect(log.options && 'resumeSessionAt' in log.options).toBe(false);
		expect((await call(3, 'start', { runId: 3, cwd: '/w', prompt: 'x', resumeAt: at })).error?.message).toContain('resumeAt');
		expect((await call(4, 'start', { runId: 4, cwd: '/w', prompt: 'x', resume: 's', resumeAt: '--fork' })).error?.message).toContain('resumeAt');
	});

	test('hands Snap MCP servers to the SDK as stdio servers', async () => {
		const { log, call } = setup();
		await call(1, 'start', { runId: 1, cwd: '/w', prompt: 'x', mcpServers: { 'go-gopls': { command: 'gopls', args: ['mcp'] } } });
		expect(log.options?.mcpServers).toEqual({ 'go-gopls': { type: 'stdio', command: 'gopls', args: ['mcp'], env: {} } });
	});

	test('no MCP servers or plugins leaves the options out', async () => {
		const { log, call } = setup();
		await call(1, 'start', { runId: 1, cwd: '/w', prompt: 'x', plugins: [] });
		expect(log.options && 'mcpServers' in log.options).toBe(false);
		expect(log.options && 'plugins' in log.options).toBe(false);
	});

	test('no account leaves env to the host; an account sets and clears variables for that run only', async () => {
		const { log, call } = setup();
		await call(1, 'start', { runId: 1, cwd: '/w', prompt: 'x' });
		expect(log.options && 'env' in log.options).toBe(false);
		await call(2, 'start', { runId: 2, cwd: '/w', prompt: 'x', env: { CLAUDE_CONFIG_DIR: '/acc/claude/0123456789ab' }, unsetEnv: ['ANTHROPIC_API_KEY'] });
		expect(log.options?.env?.CLAUDE_CONFIG_DIR).toBe('/acc/claude/0123456789ab');
		expect(log.options?.env && 'ANTHROPIC_API_KEY' in log.options.env).toBe(false);
		expect(runEnv({ A: '1', ANTHROPIC_API_KEY: 'k' }, { B: '2' }, ['ANTHROPIC_API_KEY'])).toEqual({ A: '1', B: '2' });
		expect((await call(3, 'start', { runId: 3, cwd: '/w', prompt: 'x', env: { 'bad name': 'x' } })).error?.message).toContain('env must map');
		expect((await call(4, 'start', { runId: 4, cwd: '/w', prompt: 'x', unsetEnv: [1] })).error?.message).toContain('unsetEnv');
	});

	test('hands Snap skill plugins to the SDK as local plugins without their own MCP', async () => {
		const { log, call } = setup();
		await call(1, 'start', { runId: 1, cwd: '/w', prompt: 'x', plugins: ['/cache/snap-plugins/go-0123456789abcdef'] });
		expect(log.options?.plugins).toEqual([{ type: 'local', path: '/cache/snap-plugins/go-0123456789abcdef', skipMcpDiscovery: true }]);
	});

	test('rejects bad requests', async () => {
		const { host, out, call } = setup();
		expect((await call(1, 'start', { runId: 1, cwd: 'relative', prompt: 'x' })).error?.code).toBe(-32602);
		expect((await call(2, 'start', { runId: 1, cwd: '/w', prompt: '  ' })).error?.message).toBe('prompt is empty');
		expect((await call(3, 'start', { runId: 1, cwd: '/w', prompt: 'x', permissionMode: 'auto' })).error?.message).toContain('unsupported permission mode');
		expect((await call(6, 'start', { runId: 1, cwd: '/w', prompt: 'x', mcpServers: { bad: { command: ' ' } } })).error?.message).toContain('command is empty');
		expect((await call(7, 'start', { runId: 1, cwd: '/w', prompt: 'x', plugins: ['relative/plugin'] })).error?.message).toContain('plugins must be absolute');
		expect((await call(8, 'start', { runId: 1, cwd: '/w', prompt: 'x', plugins: '/one' })).error?.message).toContain('plugins must be absolute');
		expect((await call(4, 'answer', { runId: 9, requestId: 'r', decision: 'allow' })).error?.message).toContain('no such run');
		expect((await call(5, 'nope', {})).error?.code).toBe(-32601);
		await host.handleLine('{not json');
		expect(out.at(-1)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
		expect(host.runCount).toBe(0);
	});

	test('a failing SDK reports an error and exits once', async () => {
		const out: Out[] = [];
		const host = new AgentHost({
			query: () =>
				Object.assign(
					(async function* () {
						yield { type: 'system', subtype: 'init', session_id: 's' };
						throw new Error('Claude Code process exited with code 1');
					})(),
					{ interrupt: async () => {} }
				),
			write: (m) => out.push(m as Out)
		});
		await host.handleLine(JSON.stringify({ id: 1, method: 'start', params: { runId: 3, cwd: '/w', prompt: 'x' } }));
		await Bun.sleep(10);
		const kinds = out.filter((o) => o.method === 'event').map((o) => o.params.event.kind);
		expect(kinds).toEqual(['message', 'system', 'error', 'exit']);
		expect(out.at(-1)!.params.event).toEqual({ kind: 'exit', code: 1, signal: null, stopped: false });
	});
});

describe('image attachments', () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	test('image blocks first, then the text', async () => {
		const inbox = new Inbox();
		inbox.push('ดูรูปนี้', imageBlocks(['/c/a.png', '/c/b.JPG'], () => png));
		const msg = (await inbox[Symbol.asyncIterator]().next()).value!;
		expect(msg.message.content).toEqual([
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } },
			{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'iVBORw==' } },
			{ type: 'text', text: 'ดูรูปนี้' }
		]);
		expect(shownText('ดูรูปนี้', ['/c/a.png'])).toBe('ดูรูปนี้\n\n[แนบรูป: a.png]');
		expect(shownText('x', [])).toBe('x');
	});
	test('limits', () => {
		expect(imageBlocks(undefined, () => png)).toEqual([]);
		expect(() => imageBlocks(['a.png'], () => png)).toThrow();
		expect(() => imageBlocks(['/a.svg'], () => png)).toThrow();
		expect(() => imageBlocks(['/a.png'], () => new Uint8Array(MAX_IMAGE_BYTES + 1))).toThrow();
		expect(() => imageBlocks(Array(21).fill('/a.png'), () => png)).toThrow();
		expect(() => imageBlocks(Array(5).fill('/a.png'), () => new Uint8Array(MAX_IMAGE_BYTES))).toThrow();
	});
	test('start and send carry images to the session', async () => {
		const out: Out[] = [];
		const seen: unknown[] = [];
		const host = new AgentHost({
			query: ({ prompt }) =>
				Object.assign(
					(async function* () {
						for await (const m of prompt as AsyncIterable<SDKUserMessage>) seen.push(m.message.content);
					})(),
					{ interrupt: async () => {} }
				),
			write: (m) => out.push(m as Out),
			readFile: () => png
		});
		await host.handleLine(JSON.stringify({ id: 1, method: 'start', params: { runId: 9, cwd: '/w', prompt: 'x', images: ['/c/a.png'] } }));
		await host.handleLine(JSON.stringify({ id: 2, method: 'send', params: { runId: 9, text: 'y', images: ['/c/b.webp'] } }));
		await host.handleLine(JSON.stringify({ id: 3, method: 'send', params: { runId: 9, text: 'z', images: ['relative.png'] } }));
		await Bun.sleep(10);
		expect(seen).toHaveLength(2);
		expect((seen[1] as { source?: { media_type: string } }[])[0]?.source?.media_type).toBe('image/webp');
		expect(out.find((o) => o.id === 3)?.error?.message).toContain('absolute');
		await host.handleLine(JSON.stringify({ id: 4, method: 'stop', params: { runId: 9 } }));
	});
});

describe('Inbox', () => {
	test('delivers pushed messages in order and ends on close', async () => {
		const inbox = new Inbox();
		inbox.push('a');
		const it = inbox[Symbol.asyncIterator]();
		expect((await it.next()).value?.message.content).toBe('a');
		const pending = it.next();
		inbox.push('b');
		expect((await pending).value?.message.content).toBe('b');
		inbox.close();
		expect((await it.next()).done).toBe(true);
		expect(() => inbox.push('c')).toThrow();
	});
});

describe('AskUserQuestion', () => {
	const input = {
		questions: [
			{ question: 'Which library?', header: 'Library', multiSelect: false, options: [{ label: 'date-fns', description: 'small' }, { label: 'luxon', description: 'zones' }] },
			{ question: 'Which targets?', header: 'Targets', multiSelect: true, options: [{ label: 'web', description: '' }, { label: 'ios', description: '' }] }
		]
	};

	test('the answers reach the SDK in updatedInput.answers, keyed by question text', async () => {
		const { log, event, call } = setup();
		log.tool = { name: 'AskUserQuestion', input };
		await call(1, 'start', { runId: 1, cwd: '/w', prompt: 'ask me' });
		const req = await event('permission_request');
		expect(req.params.event).toMatchObject({ tool: 'AskUserQuestion', input_summary: 'Which library?\nWhich targets?', can_always: false, input });

		// "allow" without answers (what the old flow sent) is refused and the question stays open.
		const bare = await call(2, 'answer', { runId: 1, requestId: 'req-1', decision: 'allow' });
		expect(bare.error?.message).toContain('answers');
		const partial = await call(3, 'answer', { runId: 1, requestId: 'req-1', decision: 'allow', answers: { 'Which library?': 'luxon' } });
		expect(partial.error?.message).toContain('Which targets?');
		expect(log.permission).toBeUndefined();

		const ok = await call(4, 'answer', { runId: 1, requestId: 'req-1', decision: 'allow', answers: { 'Which library?': 'luxon', 'Which targets?': 'web, ios' } });
		expect(ok.result).toBeNull();
		await event('result');
		expect(log.permission).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which library?': 'luxon', 'Which targets?': 'web, ios' } } });
	});

	test('dismissing tells Claude to wait; a typed reason is passed on', () => {
		const p = { input, suggestions: [], tool: 'AskUserQuestion' };
		expect(decisionResult('deny', p, null)).toEqual({ behavior: 'deny', message: expect.stringContaining('dismissed') });
		expect(decisionResult('deny', p, 'ถามทีหลัง')).toEqual({ behavior: 'deny', message: 'ถามทีหลัง' });
		// "always" is no rule for a question: it answers like allow, with no permission update.
		expect(decisionResult('allow_always', p, null, { 'Which library?': 'my own', 'Which targets?': 'web' })).toEqual({
			behavior: 'allow',
			updatedInput: { ...input, answers: { 'Which library?': 'my own', 'Which targets?': 'web' } }
		});
		expect(() => decisionResult('allow', p, null, { 'Which library?': 'x', 'Which targets?': 'y', 'Other?': 'z' })).toThrow('not asked');
		expect(() => decisionResult('allow', p, null, { 'Which library?': ' ', 'Which targets?': 'y' })).toThrow('no answer');
	});

	test('other tools take no answers', () => {
		expect(() => decisionResult('allow', { input: {}, suggestions: [], tool: 'Bash' }, null, { a: 'b' })).toThrow('takes no answers');
	});
});

test('decisionResult saves "always" rules where the user chose', () => {
	const suggestions: PermissionUpdate[] = [
		{ type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow' as const, destination: 'localSettings' as const },
		{ type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const }
	];
	const p = { input: { command: 'npm test' }, suggestions, tool: 'Bash' };
	const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow' };
	expect(decisionResult('allow_always', p, null)).toMatchObject({ updatedPermissions: [{ ...rule, destination: 'session' }, { type: 'setMode', destination: 'session' }] });
	// A settings file only gets the allow rules, never a mode switch.
	expect(decisionResult('allow_workspace', p, null)).toEqual({ behavior: 'allow', updatedInput: p.input, updatedPermissions: [{ ...rule, destination: 'localSettings' }] as never });
	expect(decisionResult('allow_user', p, null)).toEqual({ behavior: 'allow', updatedInput: p.input, updatedPermissions: [{ ...rule, destination: 'userSettings' }] as never });
	expect(decisionResult('allow_user', { input: {}, suggestions: suggestions.slice(1), tool: 'Edit' }, null)).toMatchObject({
		updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'userSettings' }]
	});
});

test('decisionResult falls back to a tool rule when there are no suggestions', () => {
	expect(decisionResult('allow_always', { input: {}, suggestions: [], tool: 'WebFetch' }, null)).toEqual({
		behavior: 'allow',
		updatedInput: {},
		updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' }]
	});
	expect(decisionResult('deny', { input: {}, suggestions: [], tool: 'x' }, '  ')).toMatchObject({ behavior: 'deny', message: expect.stringContaining('denied') });
});
