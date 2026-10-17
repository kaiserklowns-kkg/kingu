// Protocol tests with a fake SDK `query()`: no model calls, no Claude Code process.

import { describe, expect, test } from 'bun:test';
import type { Options, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentHost, decisionResult, Inbox, type QueryFn } from '../src/host.ts';
import type { AgentEvent } from '../src/protocol.ts';

type Out = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: any; result?: unknown; error?: { code: number; message: string } };

/** A fake session: for each user message, asks to run Bash once and reports the decision. */
function fakeQuery(log: { options?: Options; prompts: string[]; interrupted: number; permission?: PermissionResult }): QueryFn {
	return ({ prompt, options }) => {
		log.options = options;
		const gen = (async function* () {
			yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: options.model };
			for await (const m of prompt as AsyncIterable<SDKUserMessage>) {
				const text = String(m.message.content);
				log.prompts.push(text);
				yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'กำลัง' } }, parent_tool_use_id: null };
				yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf build' } }] } };
				const r = await options.canUseTool!('Bash', { command: 'rm -rf build', description: 'Clean' }, {
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
		// "Always" is turned into a session-scoped rule, never written to settings files.
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

	test('passes model and resume through', async () => {
		const { log, call } = setup();
		await call(1, 'start', { runId: 1, cwd: '/w', prompt: 'x', model: 'claude-sonnet-5', resume: 'sess-0' });
		expect(log.options).toMatchObject({ model: 'claude-sonnet-5', resume: 'sess-0', permissionMode: 'default' });
	});

	test('rejects bad requests', async () => {
		const { host, out, call } = setup();
		expect((await call(1, 'start', { runId: 1, cwd: 'relative', prompt: 'x' })).error?.code).toBe(-32602);
		expect((await call(2, 'start', { runId: 1, cwd: '/w', prompt: '  ' })).error?.message).toBe('prompt is empty');
		expect((await call(3, 'start', { runId: 1, cwd: '/w', prompt: 'x', permissionMode: 'bypassPermissions' })).error?.message).toContain('unsupported permission mode');
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

test('decisionResult falls back to a tool rule when there are no suggestions', () => {
	expect(decisionResult('allow_always', { input: {}, suggestions: [], tool: 'WebFetch' }, null)).toEqual({
		behavior: 'allow',
		updatedInput: {},
		updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' }]
	});
	expect(decisionResult('deny', { input: {}, suggestions: [], tool: 'x' }, '  ')).toMatchObject({ behavior: 'deny', message: expect.stringContaining('denied') });
});
