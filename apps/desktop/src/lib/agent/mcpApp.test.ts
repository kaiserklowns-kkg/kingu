// The MCP App host (mcpApp.ts): VS Code's ChatMcpAppModel message handling, the host context and
// its style variables, links, heights, and the tools an app registers; chatParts' app part.
import { describe, expect, test } from 'bun:test';
import { buildTurns } from './chatParts';
import type { McpAppEvent, TimelineEvent } from './events';
import { clampHeight, hostContext, LATEST_PROTOCOL_VERSION, McpAppHost, openableLink, styleVariables, type AppTool, type HostDeps } from './mcpApp';

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(o: { input?: Record<string, unknown>; csp?: unknown; message?: boolean } = {}) {
	const posted: any[] = [];
	const asked: { method: string; params: any }[] = [];
	const links: string[] = [];
	const heights: number[] = [];
	const tools: AppTool[][] = [];
	const deps: HostDeps = {
		post: (m) => posted.push(m),
		serverRequest: async (method, params) => {
			asked.push({ method, params });
			if (params.name === 'boom') throw new Error('Tool not found on server: boom');
			return { content: [{ type: 'text', text: `${method} ok` }] };
		},
		openLink: async (url) => (links.push(url), true),
		message: () => o.message ?? true,
		setHeight: (h) => heights.push(h),
		wheel: () => {},
		toolsChanged: (t) => tools.push(t),
		hostInfo: { name: 'Kingu', version: '1.2.3' }
	};
	const host = new McpAppHost(deps, { input: o.input ?? { title: 'Sales' }, csp: o.csp, context: () => ({ theme: 'dark', displayMode: 'inline' }) });
	const answer = (id: number) => posted.find((m) => m.id === id && !m.method);
	return { host, posted, asked, links, heights, tools, answer };
}

const init = (caps: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, appInfo: { name: 'chart', version: '1' }, appCapabilities: caps } });

describe('MCP App host', () => {
	test('ui/initialize: VS Code\'s capabilities, then tool-input and tool-result in that order', async () => {
		const s = setup({ csp: { connectDomains: ['https://api.example.com'] } });
		await s.host.handle(init());
		const r = s.answer(1).result;
		expect(r.protocolVersion).toBe('2026-01-26');
		expect(r.hostInfo).toEqual({ name: 'Kingu', version: '1.2.3' });
		expect(r.hostCapabilities).toEqual({
			openLinks: {},
			serverTools: {},
			serverResources: {},
			logging: {},
			sandbox: { csp: { connectDomains: ['https://api.example.com'] }, permissions: { clipboardWrite: {} } }
		});
		expect(r.hostContext).toEqual({ theme: 'dark', displayMode: 'inline' });
		expect(s.host.title).toBe('chart');
		// The input goes after the answer; the result waits for the call to return.
		expect(s.posted.some((m) => m.method === 'ui/notifications/tool-input')).toBe(false);
		await tick();
		expect(s.posted.at(-1)).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { title: 'Sales' } } });
		s.host.setResult({ content: [{ type: 'text', text: 'Drew 3 bars' }] });
		expect(s.posted.at(-1)).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: 'Drew 3 bars' }] } });
		s.host.setResult({ content: [] });
		expect(s.posted.filter((m) => m.method === 'ui/notifications/tool-result')).toHaveLength(1);
		s.host.contextChanged();
		expect(s.posted.at(-1).method).toBe('ui/notifications/host-context-changed');
	});

	test('a result known before the app loads follows its input', async () => {
		const s = setup();
		s.host.setResult({ content: [{ type: 'text', text: 'done' }] });
		s.host.contextChanged();
		expect(s.posted).toEqual([]);
		await s.host.handle(init());
		await tick();
		expect(s.posted.slice(-2).map((m) => m.method)).toEqual(['ui/notifications/tool-input', 'ui/notifications/tool-result']);
	});

	test('server requests go through the run; failures are JSON-RPC errors', async () => {
		const s = setup();
		await s.host.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'refresh', arguments: { range: 'week' } } });
		expect(s.asked[0]).toEqual({ method: 'tools/call', params: { name: 'refresh', arguments: { range: 'week' } } });
		expect(s.answer(7).result).toEqual({ content: [{ type: 'text', text: 'tools/call ok' }] });
		await s.host.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'boom' } });
		expect(s.answer(8)).toEqual({ jsonrpc: '2.0', id: 8, error: { code: -32000, message: 'Tool not found on server: boom' } });
		await s.host.handle({ jsonrpc: '2.0', id: 9, method: 'resources/read', params: {} });
		expect(s.answer(9).error.message).toContain('Missing uri');
		await s.host.handle({ jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'ui://charts/data.json' } });
		expect(s.asked.at(-1)!.method).toBe('resources/read');
		await s.host.handle({ jsonrpc: '2.0', id: 11, method: 'prompts/get', params: {} });
		expect(s.answer(11).error).toEqual({ code: -32601, message: 'Method not found: prompts/get' });
		await s.host.handle({ jsonrpc: '2.0', id: 12, method: 'ping' });
		expect(s.answer(12).result).toEqual({});
		// Messages that are not JSON-RPC are dropped.
		await s.host.handle('hello');
		await s.host.handle(null);
	});

	test('links: http(s) only; messages into an empty input; display mode stays inline; no downloads', async () => {
		const s = setup();
		await s.host.handle({ jsonrpc: '2.0', id: 1, method: 'ui/open-link', params: { url: 'https://example.com/a' } });
		await s.host.handle({ jsonrpc: '2.0', id: 2, method: 'ui/open-link', params: { url: 'kingu://auth/callback?code=1' } });
		await s.host.handle({ jsonrpc: '2.0', id: 3, method: 'ui/open-link', params: { url: 'javascript:alert(1)' } });
		expect(s.links).toEqual(['https://example.com/a']);
		expect([s.answer(1).result, s.answer(2).result, s.answer(3).result]).toEqual([{ isError: false }, { isError: true }, { isError: true }]);
		await s.host.handle({ jsonrpc: '2.0', id: 4, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'Zoom in' }] } });
		expect(s.answer(4).result).toEqual({ isError: false });
		const busy = setup({ message: false });
		await busy.host.handle({ jsonrpc: '2.0', id: 5, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'x' }] } });
		expect(busy.answer(5).result).toEqual({ isError: true });
		await s.host.handle({ jsonrpc: '2.0', id: 6, method: 'ui/request-display-mode', params: { mode: 'fullscreen' } });
		expect(s.answer(6).result).toEqual({ mode: 'inline' });
		await s.host.handle({ jsonrpc: '2.0', id: 7, method: 'ui/download-file', params: { contents: [] } });
		expect(s.answer(7).result).toEqual({ isError: true });
		await s.host.handle({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 420 } });
		expect(s.heights).toEqual([420]);
	});

	test('tools the app registers: listed after initialized, called with cancel, gone on reload', async () => {
		const s = setup();
		await s.host.handle(init({ tools: { listChanged: true } }));
		const listing = s.host.handle({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
		await tick();
		const list = s.posted.find((m) => m.method === 'tools/list');
		expect(list).toMatchObject({ jsonrpc: '2.0', params: {} });
		await s.host.handle({ jsonrpc: '2.0', id: list.id, result: { tools: [{ name: 'zoom', inputSchema: { type: 'object' } }], nextCursor: 'p2' } });
		await tick();
		const page2 = s.posted.filter((m) => m.method === 'tools/list').at(-1);
		expect(page2.params).toEqual({ cursor: 'p2' });
		await s.host.handle({ jsonrpc: '2.0', id: page2.id, result: { tools: [{ name: 'reset' }] } });
		await listing;
		expect(s.tools.at(-1)!.map((t) => t.name)).toEqual(['zoom', 'reset']);

		const call = s.host.callTool('zoom', { level: 2 });
		await tick();
		const req = s.posted.find((m) => m.method === 'tools/call');
		expect(req.params).toEqual({ name: 'zoom', arguments: { level: 2 } });
		await s.host.handle({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'zoomed' }] } });
		expect(await call).toEqual({ content: [{ type: 'text', text: 'zoomed' }] });

		const ctrl = new AbortController();
		const cancelled = s.host.callTool('zoom', {}, ctrl.signal);
		await tick();
		const req2 = s.posted.filter((m) => m.method === 'tools/call').at(-1);
		ctrl.abort();
		await expect(cancelled).rejects.toThrow();
		expect(s.posted.at(-1)).toEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: req2.id, reason: 'MCP App tool call cancelled' } });

		// The app loads again: its tools are void until it lists them again.
		await s.host.handle(init());
		expect(s.tools.at(-1)).toEqual([]);
		await expect(s.host.callTool('zoom', {})).rejects.toThrow('not initialized');
	});

	test('an app that does not declare tools is never asked for them', async () => {
		const s = setup();
		await s.host.handle(init());
		await s.host.handle({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
		expect(s.posted.some((m) => m.method === 'tools/list')).toBe(false);
		await expect(s.host.callTool('zoom', {})).rejects.toThrow();
	});
});

describe('MCP App context', () => {
	test('VS Code\'s style variables with this window\'s values', () => {
		const values: Record<string, string> = { '--vscode-editor-background': '#1e1e1e', '--vscode-foreground': ' #ccc ', '--vscode-widget-shadow': 'rgba(0,0,0,.5)' };
		const v = styleVariables((name) => values[name] ?? '');
		expect(v['--color-background-primary']).toBe('#1e1e1e');
		expect(v['--color-text-primary']).toBe('#ccc');
		expect(v['--color-text-inverse']).toBe('#1e1e1e');
		expect(v['--color-background-secondary']).toBeUndefined();
		expect(v['--font-text-md-size']).toBe('13px');
		expect(v['--shadow-sm']).toBe('0 1px 2px 0 rgba(0,0,0,.5)');
		const c = hostContext({ theme: 'light', variables: v, locale: 'en-US', width: 640.4, maxHeight: 600, toolCallId: 'c1', toolName: 'show_chart' });
		expect(c).toMatchObject({ theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline'], platform: 'desktop', containerDimensions: { width: 640, maxHeight: 600 }, toolCall: { toolCallId: 'c1', toolName: 'show_chart' } });
	});

	test('heights and links', () => {
		expect(clampHeight(20, 1000)).toBe(100);
		expect(clampHeight(5000, 1000)).toBe(750);
		expect(clampHeight(420.6, 1000)).toBe(421);
		expect(openableLink('http://a.example/')).toBe('http://a.example/');
		for (const bad of ['file:///etc/passwd', 'tauri://localhost', 'mailto:a@b', 'not a url', 42]) expect(openableLink(bad)).toBeNull();
	});
});

describe('chat parts', () => {
	test('an MCP App is a part after its tool call; its result updates it', () => {
		const start: McpAppEvent = { kind: 'mcp_app', tool_use_id: 'c1', server: 'charts', tool: 'show', resource_uri: 'ui://charts/a.html', input: {}, done: false };
		const items: TimelineEvent[] = [
			{ kind: 'message', role: 'user', text: 'Chart it' },
			{ kind: 'tool_use', id: 'c1', name: 'mcp__charts__show', input: {} },
			start,
			{ ...start, done: true, result: { content: [] } },
			{ kind: 'tool_result', tool_use_id: 'c1', content: 'ok', is_error: false }
		];
		const turns = buildTurns({ items, draft: { text: '', thinking: '' }, decisions: {}, ended: false });
		const parts = turns[0]!.parts;
		expect(parts.map((p) => p.kind)).toEqual(['tool', 'mcpApp']);
		expect(parts[1]).toEqual({ kind: 'mcpApp', app: { ...start, done: true, result: { content: [] } } });
	});
});
