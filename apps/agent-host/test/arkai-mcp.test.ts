// Arkai as an MCP client (src/arkai/mcp.ts) against a fake server in this process
// (fixtures/fake-mcp.ts): over line pipes, Streamable HTTP and HTTP+SSE; then a whole run whose
// model calls an MCP tool through the permission prompt. No real server, no real model.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentHost } from '../src/host.ts';
import { exposedName, HttpConnection, McpHub, pipeConnection, resultText, SseConnection, sseEvents, type McpConnection } from '../src/arkai/mcp.ts';
import type { AgentEvent, McpServerLive } from '../src/protocol.ts';
import { FakeMcp } from './fixtures/fake-mcp.ts';
import { FakeLlm } from './fixtures/fake-llm.ts';

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

function fake() {
	const f = new FakeMcp();
	cleanups.push(() => f.stop());
	return f;
}

function hub(connect: (name: string) => McpConnection, names = ['fake']) {
	const changes: McpServerLive[][] = [];
	const logs: string[] = [];
	const h = new McpHub(Object.fromEntries(names.map((n) => [n, { command: 'unused' }])), { cwd: '/w', env: {}, log: (l) => logs.push(l), onChange: (s) => changes.push(s), connect: (name) => connect(name) });
	cleanups.push(() => h.close());
	return { h, changes, logs };
}

const signal = () => new AbortController().signal;

describe('MCP pieces', () => {
	test('tool names as Claude Code writes them, fit for every provider', () => {
		expect(exposedName('github', 'create_issue')).toBe('mcp__github__create_issue');
		expect(exposedName('my server', 'a.b/c')).toBe('mcp__my_server__a_b_c');
		expect(exposedName('s', 'x'.repeat(100)).length).toBe(64);
	});

	test('a result as text for the model', () => {
		expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: '' }, { type: 'resource', resource: { uri: 'file:///x', text: 'body' } }] })).toEqual({ content: 'a\n[image image/png]\nbody', isError: false });
		expect(resultText({ content: [], structuredContent: { n: 1 }, isError: true })).toEqual({ content: '{"n":1}', isError: true });
		expect(resultText(null)).toEqual({ content: '', isError: false });
	});

	test('event streams', async () => {
		const body = new Response(': c\nevent: endpoint\ndata: /m\n\ndata: {"a":\ndata: 1}\n\nevent: x\ndata: tail').body!;
		const evs = [];
		for await (const e of sseEvents(body)) evs.push(e);
		expect(evs).toEqual([
			{ event: 'endpoint', data: '/m' },
			{ event: 'message', data: '{"a":\n1}' },
			{ event: 'x', data: 'tail' }
		]);
	});
});

describe('McpHub', () => {
	test('over pipes: initialized, both pages of tools, calls, roots, status, close', async () => {
		const f = fake();
		const pipes = f.pipes();
		let closed = 0;
		const { h, changes, logs } = hub(() =>
			pipeConnection(pipes, '/w', () => {
				closed++;
				pipes.closed = true;
			})
		);
		expect(h.status()).toEqual([{ name: 'fake', status: 'pending', error: null, source: null, tools: [] }]);
		await h.ready;
		expect(f.asked.slice(0, 4)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
		expect(changes.at(-1)).toEqual([{ name: 'fake', status: 'connected', error: null, source: null, tools: ['echo', 'fail', 'slow', 'ask.root'] }]);
		expect(h.defs().map((d) => d.name)).toEqual(['mcp__fake__echo', 'mcp__fake__fail', 'mcp__fake__slow', 'mcp__fake__ask_root']);
		expect(h.defs()[0]!.parameters).toEqual({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] });
		// A tool without a description gets one naming its server.
		expect(h.defs()[3]!.description).toBe('ask.root (MCP server fake)');
		expect(await h.call('mcp__fake__echo', { text: 'hi' }, signal())).toEqual({ content: 'echo: hi\n[image image/png]', isError: false });
		expect(await h.call('mcp__fake__fail', {}, signal())).toEqual({ content: 'it broke', isError: true });
		expect(JSON.parse((await h.call('mcp__fake__ask_root', {}, signal())).content)).toEqual({ roots: [{ uri: pathToFileURL('/w').href, name: 'project' }] });
		expect((await h.call('mcp__fake__nope', {}, signal())).isError).toBe(true);
		expect(logs).toEqual(['mcp fake: connected, 4 tools']);
		h.close();
		expect(closed).toBe(1);
		expect(h.defs()).toEqual([]);
	});

	test('an interrupted call ends at once; a server that does not start is failed', async () => {
		const f = fake();
		const { h, changes } = hub((name) => {
			if (name === 'broken') throw new Error('spawn nope ENOENT');
			return pipeConnection(f.pipes(), '/w');
		}, ['fake', 'broken']);
		await h.ready;
		expect(changes.at(-1)!.find((s) => s.name === 'broken')).toEqual({ name: 'broken', status: 'failed', error: 'spawn nope ENOENT', source: null, tools: [] });
		const ac = new AbortController();
		const call = h.call('mcp__fake__slow', {}, ac.signal);
		ac.abort();
		expect(await call).toEqual({ content: 'MCP server fake: interrupted', isError: true });
	});

	test('two servers whose names clean to the same tool name both keep their tool', async () => {
		const f = fake();
		f.paged = false;
		const { h } = hub(() => pipeConnection(f.pipes(), '/w'), ['a.b', 'a_b']);
		await h.ready;
		const names = h.defs().map((d) => d.name);
		expect(names.filter((n) => n.startsWith('mcp__a_b__echo'))).toEqual(['mcp__a_b__echo', 'mcp__a_b__echo_2']);
		expect(new Set(names).size).toBe(names.length);
	});

	test('Streamable HTTP: session and protocol headers, answers as JSON or a stream, DELETE on close', async () => {
		const f = fake();
		const url = `${f.serve()}/mcp`;
		const { h, changes } = hub(() => new HttpConnection(url, { 'x-team': 't1' }, '/w'));
		await h.ready;
		expect(changes.at(-1)![0]!.status).toBe('connected');
		expect(await h.call('mcp__fake__echo', { text: 'web' }, signal())).toEqual({ content: 'echo: web\n[image image/png]', isError: false });
		expect(f.headers[0]!['x-team']).toBe('t1');
		expect(f.headers[0]!['mcp-session-id']).toBeUndefined();
		expect(f.headers.at(-1)).toMatchObject({ 'mcp-session-id': 'sess-1', 'mcp-protocol-version': '2025-03-26' });
		h.close();
		await Bun.sleep(30);
		expect(f.deleted).toBe(1);
	});

	test('HTTP+SSE: the endpoint from the stream, answers on it', async () => {
		const f = fake();
		const url = `${f.serve()}/sse`;
		const { h } = hub(() => new SseConnection(url, {}, '/w'));
		await h.ready;
		expect(h.defs().length).toBe(4);
		expect(await h.call('mcp__fake__echo', { text: 'old' }, signal())).toEqual({ content: 'echo: old\n[image image/png]', isError: false });
	});

	test('a server that wants a sign-in is reported as needing it', async () => {
		const f = fake();
		f.unauthorized = true;
		const url = f.serve();
		const { h, changes } = hub(() => new HttpConnection(`${url}/mcp`, {}, '/w'));
		await h.ready;
		expect(changes.at(-1)![0]).toMatchObject({ status: 'needs-auth', error: 'HTTP 401: the server needs authorization' });
	});
});

describe('An Arkai run with an MCP server', () => {
	test('the tool is offered, asked about, called, and its result goes back', async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-arkai-mcp-')));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const f = fake();
		const mcpUrl = `${f.serve()}/mcp`;
		const llm = new FakeLlm();
		cleanups.push(() => llm.stop());
		const out: any[] = [];
		let n = 0;
		const host = new AgentHost({
			query: () => {
				throw new Error('the Claude SDK must not run');
			},
			write: (m) => void out.push(JSON.parse(JSON.stringify(m))),
			newId: () => `req-${++n}`,
			log: () => {}
		});
		cleanups.push(() => host.dispatch('shutdown', null));
		const events = () => out.filter((o) => o.method === 'event').map((o) => o.params.event as AgentEvent);
		const until = async (pred: () => boolean) => {
			for (let i = 0; i < 400 && !pred(); i++) await Bun.sleep(10);
			expect(pred()).toBe(true);
		};
		llm.reply({ calls: [{ id: 'm1', name: 'mcp__docs__echo', args: JSON.stringify({ text: 'ping' }) }] }, { text: ['Got it.'] });
		await host.handleLine(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'start',
				params: {
					runId: 1,
					cwd,
					prompt: 'use the docs',
					mcpServers: { docs: { type: 'http', url: mcpUrl } },
					guardAsks: { mcpTools: true },
					runtime: { kind: 'arkai', provider: { id: 'local', name: 'Local', api: 'openai', baseUrl: `${llm.url}/v1`, models: [{ id: 'coder', contextWindow: 64_000 }] }, model: 'coder' }
				}
			})
		);
		await until(() => events().some((e) => e.kind === 'permission_request'));
		const status = events().filter((e) => e.kind === 'mcp_status') as Extract<AgentEvent, { kind: 'mcp_status' }>[];
		expect(status.at(-1)!.servers).toEqual([{ name: 'docs', status: 'connected', error: null, source: null, tools: ['echo', 'fail', 'slow', 'ask.root'] }]);
		expect(llm.requests[0]!.body.tools.map((t: any) => t.function.name)).toContain('mcp__docs__echo');
		// The always-ask MCP check asks first; allowing there is enough.
		const ask = events().find((e) => e.kind === 'guard_asked') as Extract<AgentEvent, { kind: 'guard_asked' }>;
		expect(ask).toMatchObject({ tool: 'mcp__docs__echo', check: 'mcp' });
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'answer', params: { runId: 1, requestId: ask.request_id, decision: 'allow' } }));
		await until(() => events().some((e) => e.kind === 'result'));
		expect(events().find((e) => e.kind === 'tool_result')).toEqual({ kind: 'tool_result', tool_use_id: 'm1', content: 'echo: ping\n[image image/png]', is_error: false });
		const sent = llm.requests[1]!.body.messages.find((m: any) => m.role === 'tool');
		expect(sent.content).toBe('echo: ping\n[image image/png]');
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'stop', params: { runId: 1 } }));
		await until(() => f.deleted === 1);
	});
});
