// MCP Apps (SEP-1865) in an Arkai run (src/arkai/mcpApps.ts, VS Code's chatMcpAppModel.ts,
// mcpToolCallUI.ts and agentHostMcpAppToolsService.ts): the UI extension announced, a tool with a
// `ui://` resource reported to the chat with its raw result, the app's own requests (app-only
// tools included) through the permission rules, and the tools an app registers offered to the
// model and answered by the chat. No real server, no real model.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHost } from '../src/host.ts';
import { clientCapabilities, McpHub, uiMeta, UI_EXTENSION, type McpConnection } from '../src/arkai/mcp.ts';
import { appResult, AppToolCalls, AppToolRegistry, appToolDefs, checkAppRequest, MAX_APP_RESULT } from '../src/arkai/mcpApps.ts';
import type { AgentEvent } from '../src/protocol.ts';
import { FakeLlm } from './fixtures/fake-llm.ts';

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

const CHART = { content: [{ type: 'text', text: 'Drew 3 bars' }], structuredContent: { bars: [1, 2, 3] } };

/** An apps server's answers by method. */
function answer(method: string, params: any): unknown {
	switch (method) {
		case 'initialize':
			return { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'charts', version: '1' } };
		case 'tools/list':
			return {
				tools: [
					{ name: 'show_chart', inputSchema: { type: 'object', properties: { title: { type: 'string' } } }, _meta: { ui: { resourceUri: 'ui://charts/chart.html' } } },
					{ name: 'refresh', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://charts/chart.html', visibility: ['app'] } } },
					{ name: 'model_only', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['model'] } } },
					{ name: 'plain', inputSchema: { type: 'object' } }
				]
			};
		case 'tools/call':
			if (params.name === 'show_chart') return CHART;
			if (params.name === 'refresh') return { content: [{ type: 'text', text: `refreshed ${JSON.stringify(params.arguments)}` }] };
			return { content: [{ type: 'text', text: 'ok' }] };
		case 'resources/read':
			if (params.uri === 'ui://charts/chart.html') return { contents: [{ uri: params.uri, mimeType: 'text/html;profile=mcp-app', text: '<html><body>chart</body></html>', _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] } } } }] };
			throw new Error('unknown resource');
	}
	throw new Error(`method not found: ${method}`);
}

describe('MCP Apps metadata', () => {
	test('_meta.ui as VS Code reads it, and the older flat keys', () => {
		expect(uiMeta({ name: 'x' })).toEqual({ resourceUri: null, visibility: ['model', 'app'] });
		expect(uiMeta({ name: 'x', _meta: { ui: { resourceUri: 'ui://a/b.html', visibility: ['app'] } } })).toEqual({ resourceUri: 'ui://a/b.html', visibility: ['app'] });
		expect(uiMeta({ name: 'x', _meta: { 'ui/resourceUri': 'ui://a/old.html', 'ui/visibility': ['model'] } })).toEqual({ resourceUri: 'ui://a/old.html', visibility: ['model'] });
		// Only `ui://` resources render.
		expect(uiMeta({ name: 'x', _meta: { ui: { resourceUri: 'https://evil.example/app.html' } } }).resourceUri).toBeNull();
	});

	test('the UI extension is announced with VS Code\'s MIME type', () => {
		expect(clientCapabilities({}, false, true).extensions).toEqual({ [UI_EXTENSION]: { mimeTypes: ['text/html;profile=mcp-app'] } });
		expect(clientCapabilities({}, true, true).extensions).toMatchObject({ [UI_EXTENSION]: {} });
		expect(clientCapabilities({}, false, false).extensions).toBeUndefined();
	});

	test('the hub: model tools, app tools (app-only included), the app of a model tool', async () => {
		const asked: { method: string; params: any }[] = [];
		const conn: McpConnection = { request: async (m, p) => (asked.push({ method: m, params: p }), answer(m, p)), notify: () => {}, close: () => {} };
		const h = new McpHub({ charts: { command: 'unused' } }, { cwd: '/w', env: {}, log: () => {}, onChange: () => {}, apps: true, connect: () => conn });
		cleanups.push(() => h.close());
		await h.ready;
		expect(asked[0]!.params.capabilities.extensions[UI_EXTENSION]).toEqual({ mimeTypes: ['text/html;profile=mcp-app'] });
		expect(h.defs().map((d) => d.name)).toEqual(['mcp__charts__show_chart', 'mcp__charts__model_only', 'mcp__charts__plain']);
		expect(h.appOf('mcp__charts__show_chart')).toEqual({ server: 'charts', tool: 'show_chart', resourceUri: 'ui://charts/chart.html' });
		expect(h.appOf('mcp__charts__plain')).toBeNull();
		expect(h.appTool('charts', 'refresh')?.name).toBe('refresh');
		expect(h.appTool('charts', 'plain')?.name).toBe('plain');
		// VS Code: a tool whose visibility leaves out `app` is "not found" for the app.
		expect(h.appTool('charts', 'model_only')).toBeNull();
		expect(h.appTool('other', 'refresh')).toBeNull();
		const r = await h.callRaw('mcp__charts__show_chart', { title: 'x' }, new AbortController().signal);
		expect(r).toEqual({ content: 'Drew 3 bars', isError: false, raw: CHART });
	});
});

describe('MCP Apps helpers', () => {
	test('requests an app may make, checked', () => {
		expect(checkAppRequest({ runId: 1, server: 's', method: 'resources/read', params: { uri: 'ui://s/x' } }).method).toBe('resources/read');
		expect(() => checkAppRequest({ runId: 1, server: 's', method: 'resources/read', params: {} })).toThrow('Missing uri');
		expect(() => checkAppRequest({ runId: 1, server: 's', method: 'tools/call', params: {} })).toThrow('Missing tool name');
		expect(() => checkAppRequest({ runId: 1, server: 's', method: 'tools/call', params: { name: 'x', arguments: [1] } })).toThrow('arguments');
		for (const method of ['tools/list', 'prompts/get', 'completion/complete', 'ui/initialize']) expect(() => checkAppRequest({ runId: 1, server: 's', method })).toThrow('Method not found');
		expect(() => checkAppRequest({ runId: 1, server: '', method: 'resources/read' })).toThrow('server');
	});

	test('a result too large reaches the app as null; a failure as an error result', () => {
		expect(appResult(CHART, { content: '', isError: false })).toEqual(CHART);
		expect(appResult({ content: [{ type: 'text', text: 'x'.repeat(MAX_APP_RESULT) }] }, { content: '', isError: false })).toBeNull();
		expect(appResult(null, { content: 'server gone', isError: true })).toEqual({ content: [{ type: 'text', text: 'server gone' }], isError: true });
	});

	test('app tools: valid names, the last app wins a name, gone with an empty list', () => {
		const defs = appToolDefs([{ name: 'zoom', description: 'Zoom the chart', inputSchema: { type: 'object', properties: { level: { type: 'number' } } } }, { name: 'bad name' }, { name: 'zoom' }, { name: 'reset', title: 'Reset view' }]);
		expect(defs.map((d) => d.name)).toEqual(['zoom', 'reset']);
		expect(defs[1]!.description).toBe('Reset view (MCP App tool)');
		expect(() => appToolDefs('nope')).toThrow();
		const reg = new AppToolRegistry();
		reg.set('a', defs);
		reg.set('b', appToolDefs([{ name: 'zoom' }]));
		expect(reg.owner('zoom')).toBe('b');
		expect(reg.owner('reset')).toBe('a');
		reg.set('b', []);
		expect(reg.owner('zoom')).toBe('a');
		expect(reg.defs().map((d) => d.name)).toEqual(['zoom', 'reset']);
	});

	test('an app tool call: sent, answered, cancelled', async () => {
		const sent: AgentEvent[] = [];
		let n = 0;
		const calls = new AppToolCalls((ev) => sent.push(ev), () => `r${++n}`);
		const p = calls.call('app-1', 'zoom', { level: 2 }, new AbortController().signal);
		expect(sent[0]).toEqual({ kind: 'mcp_app_tool_call', request_id: 'r1', app_id: 'app-1', name: 'zoom', arguments: { level: 2 } });
		calls.answer({ runId: 1, requestId: 'r1', result: { content: [{ type: 'text', text: 'zoomed' }] } });
		expect(await p).toEqual({ result: { content: [{ type: 'text', text: 'zoomed' }] }, error: null });
		expect(() => calls.answer({ runId: 1, requestId: 'r1', result: {} })).toThrow('no pending');
		const ac = new AbortController();
		const q = calls.call('app-1', 'zoom', {}, ac.signal);
		ac.abort();
		expect(await q).toMatchObject({ cancelled: true });
		expect(sent.at(-1)).toEqual({ kind: 'mcp_app_tool_cancel', request_id: 'r2' });
		const t = calls.call('app-1', 'zoom', {}, new AbortController().signal, 20);
		expect((await t).error).toContain('did not answer');
	});
});

describe('An Arkai run with an MCP App', () => {
	async function run() {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-arkai-apps-')));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const asked: { method: string; params: any }[] = [];
		const server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				if (req.method !== 'POST') return new Response(null, { status: 405 });
				const m: any = await req.json();
				if (m.id === undefined) return new Response(null, { status: 202 });
				asked.push({ method: m.method, params: m.params });
				try {
					return Response.json({ jsonrpc: '2.0', id: m.id, result: answer(m.method, m.params ?? {}) });
				} catch (e) {
					return Response.json({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: (e as Error).message } });
				}
			}
		});
		cleanups.push(() => server.stop(true));
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
		const start = (mode = 'default') =>
			host.handleLine(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'start',
					params: {
						runId: 1,
						cwd,
						prompt: 'Chart it',
						permissionMode: mode,
						mcpServers: { charts: { type: 'http', url: `http://127.0.0.1:${server.port}/mcp` } },
						runtime: { kind: 'arkai', provider: { id: 'local', name: 'Local', api: 'openai', baseUrl: `${llm.url}/v1`, models: [{ id: 'coder', contextWindow: 64_000 }] }, model: 'coder' }
					}
				})
			);
		const call = (method: string, params: object) => host.dispatch(method, { runId: 1, ...params });
		return { host, llm, events, until, start, call, asked };
	}

	test('a tool with a UI resource: the chat hears of it before and after, with the server\'s own result', async () => {
		const r = await run();
		r.llm.reply({ calls: [{ id: 'c1', name: 'mcp__charts__show_chart', args: JSON.stringify({ title: 'Sales' }) }] }, { text: ['Here is the chart.'] });
		await r.start('bypassPermissions');
		await r.until(() => r.events().some((e) => e.kind === 'result'));
		// app-only tools are never offered to the model.
		const offered = r.llm.requests[0]!.body.tools.map((t: any) => t.function.name);
		expect(offered).toContain('mcp__charts__show_chart');
		expect(offered).not.toContain('mcp__charts__refresh');
		const apps = r.events().filter((e) => e.kind === 'mcp_app');
		expect(apps).toEqual([
			{ kind: 'mcp_app', tool_use_id: 'c1', server: 'charts', tool: 'show_chart', resource_uri: 'ui://charts/chart.html', input: { title: 'Sales' }, done: false },
			{ kind: 'mcp_app', tool_use_id: 'c1', server: 'charts', tool: 'show_chart', resource_uri: 'ui://charts/chart.html', input: { title: 'Sales' }, done: true, result: CHART }
		]);
		const kinds = r.events().map((e) => e.kind);
		expect(kinds.indexOf('tool_use')).toBeLessThan(kinds.indexOf('mcp_app'));
		expect(kinds.lastIndexOf('mcp_app')).toBeLessThan(kinds.indexOf('tool_result'));
		// The app reads its resource through the run.
		const read = (await r.call('mcp_app', { server: 'charts', method: 'resources/read', params: { uri: 'ui://charts/chart.html' } })) as any;
		expect(read.contents[0].text).toContain('chart');
	});

	test('the app calls an app-only tool: asked like the model\'s call, refused when denied, unknown tools not found', async () => {
		const r = await run();
		r.llm.reply({ text: ['Ready.'] });
		await r.start('default');
		await r.until(() => r.events().some((e) => e.kind === 'result'));
		const p = r.call('mcp_app', { server: 'charts', method: 'tools/call', params: { name: 'refresh', arguments: { range: 'week' } } });
		await r.until(() => r.events().some((e) => e.kind === 'permission_request'));
		const ask = r.events().find((e) => e.kind === 'permission_request') as any;
		expect(ask).toMatchObject({ tool: 'mcp__charts__refresh', tool_use_id: null, title: 'The MCP App of charts wants to run refresh', input: { range: 'week' } });
		await r.call('answer', { requestId: ask.request_id, decision: 'allow' });
		expect(await p).toEqual({ content: [{ type: 'text', text: 'refreshed {"range":"week"}' }] });

		const q = r.call('mcp_app', { server: 'charts', method: 'tools/call', params: { name: 'refresh', arguments: {} } });
		await r.until(() => r.events().filter((e) => e.kind === 'permission_request').length === 2);
		const ask2 = r.events().filter((e) => e.kind === 'permission_request').at(-1) as any;
		await r.call('answer', { requestId: ask2.request_id, decision: 'deny' });
		await expect(q).rejects.toThrow();
		expect(r.asked.filter((a) => a.method === 'tools/call')).toHaveLength(1);

		await expect(r.call('mcp_app', { server: 'charts', method: 'tools/call', params: { name: 'model_only' } })).rejects.toThrow('Tool not found on server: model_only');
		await expect(r.call('mcp_app', { server: 'nope', method: 'resources/read', params: { uri: 'ui://x' } })).rejects.toThrow('not connected');
		await expect(r.call('mcp_app', { server: 'charts', method: 'prompts/get', params: {} })).rejects.toThrow('Method not found');
	});

	test('tools the app registers are offered from the next request and answered by the chat', async () => {
		const r = await run();
		r.llm.reply({ text: ['Ready.'] });
		await r.start('bypassPermissions');
		await r.until(() => r.events().some((e) => e.kind === 'result'));
		await r.call('mcp_app_tools', { appId: 'app-c1', tools: [{ name: 'zoom', description: 'Zoom the chart', inputSchema: { type: 'object', properties: { level: { type: 'number' } } } }, { name: 'mcp__charts__show_chart' }] });
		r.llm.reply({ calls: [{ id: 'c2', name: 'zoom', args: JSON.stringify({ level: 3 }) }] }, { text: ['Zoomed.'] });
		await r.call('send', { text: 'Zoom in' });
		await r.until(() => r.events().some((e) => e.kind === 'mcp_app_tool_call'));
		const offered = r.llm.requests.at(-1)!.body.tools.map((t: any) => t.function.name);
		expect(offered.filter((n: string) => n === 'zoom' || n === 'mcp__charts__show_chart')).toEqual(['mcp__charts__show_chart', 'zoom']);
		const callEv = r.events().find((e) => e.kind === 'mcp_app_tool_call') as any;
		expect(callEv).toMatchObject({ app_id: 'app-c1', name: 'zoom', arguments: { level: 3 } });
		await r.call('mcp_app_tool_result', { requestId: callEv.request_id, result: { content: [{ type: 'text', text: 'zoomed to 3' }] } });
		await r.until(() => r.events().filter((e) => e.kind === 'result').length === 2);
		const result = r.events().find((e) => e.kind === 'tool_result' && e.tool_use_id === 'c2') as any;
		expect(result).toMatchObject({ content: 'zoomed to 3', is_error: false });
		// Gone with the app.
		await r.call('mcp_app_tools', { appId: 'app-c1', tools: [] });
		r.llm.reply({ text: ['ok'] });
		await r.call('send', { text: 'again' });
		await r.until(() => r.events().filter((e) => e.kind === 'result').length === 3);
		expect(r.llm.requests.at(-1)!.body.tools.map((t: any) => t.function.name)).not.toContain('zoom');
	});
});
