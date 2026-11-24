// The browser tools (src/browser.ts) with a fake app: which calls ask (VS Code's confirmations),
// what reaches the app, and that a run gets the tools only with a session from the app.

import { describe, expect, test } from 'bun:test';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { BROWSER_TOOLS, browserConfirmation, browserToolOf, callBrowser, toResult, UNASKED_BROWSER_TOOLS } from '../src/browser.ts';
import { AgentHost, type QueryFn } from '../src/host.ts';

describe('VS Code\'s confirmations', () => {
	test('opening a page and navigating to an address ask; the rest do not', () => {
		expect(browserConfirmation('mcp__kingu__open_browser_page', { url: 'https://a.dev' })).toEqual({
			title: 'Open Browser Page?',
			message: "This will open https://a.dev in Kingu's browser. The agent will be able to read and interact with its contents."
		});
		expect(browserConfirmation('mcp__kingu__navigate_page', { pageId: 'p', url: 'https://b.dev' })?.title).toBe('Navigate Browser?');
		expect(browserConfirmation('mcp__kingu__navigate_page', { pageId: 'p', type: 'url', url: 'https://b.dev' })?.title).toBe('Navigate Browser?');
		for (const type of ['back', 'forward', 'reload']) expect(browserConfirmation('mcp__kingu__navigate_page', { pageId: 'p', type })).toBeNull();
		for (const t of ['read_page', 'click_element', 'type_in_page', 'screenshot_page']) expect(browserConfirmation(`mcp__kingu__${t}`, { pageId: 'p' })).toBeNull();
		// Another server's tool of the same name is not Kingu's.
		expect(browserToolOf('mcp__other__open_browser_page')).toBeNull();
		expect(UNASKED_BROWSER_TOOLS).not.toContain('mcp__kingu__open_browser_page');
		expect(UNASKED_BROWSER_TOOLS).not.toContain('mcp__kingu__navigate_page');
	});

	test('calls carry the session and folder; a screenshot comes back as a picture; a refusal is an error result', async () => {
		const seen: [string, unknown][] = [];
		const call = async (method: string, params: unknown) => {
			seen.push([method, params]);
			if (method === 'browser.screenshot') return { text: 'Screenshot of page p.', png: 'iVBOR' };
			if (method === 'browser.click') throw new Error('The user stopped agents from using page p.');
			return { text: 'ok' };
		};
		const deps = { session: 'tok', cwd: '/repo', call };
		expect(await callBrowser('read_page', { pageId: 'p' }, deps)).toEqual({ content: [{ type: 'text', text: 'ok' }] });
		expect(seen[0]).toEqual(['browser.read', { pageId: 'p', session: 'tok', cwd: '/repo' }]);
		// The agent's own `session` never replaces the run's.
		await callBrowser('read_page', { pageId: 'p', session: 'forged' }, deps);
		expect((seen[1]?.[1] as { session: string }).session).toBe('tok');
		const shot = await callBrowser('screenshot_page', { pageId: 'p' }, deps);
		expect(shot.content[1]).toEqual({ type: 'image', data: 'iVBOR', mimeType: 'image/png' });
		const stopped = await callBrowser('click_element', { pageId: 'p', ref: 'e1' }, deps);
		expect(stopped.isError).toBe(true);
		expect(stopped.content[0]).toEqual({ type: 'text', text: 'The user stopped agents from using page p.' });
		expect(toResult(null)).toEqual({ content: [{ type: 'text', text: 'Done.' }] });
		expect(Object.values(BROWSER_TOOLS).every((m) => m.startsWith('browser.'))).toBe(true);
	});
});

describe('in the host', () => {
	function fakeQuery(tools: [string, Record<string, unknown>][], calls: { tool: string; behavior: string }[], seen: { options?: Options }) {
		const query: QueryFn = ({ prompt, options: o }) => {
			seen.options = o;
			const gen = (async function* () {
				for await (const _m of prompt as AsyncIterable<SDKUserMessage>) {
					for (const [tool, input] of tools) {
						const r = await o.canUseTool!(tool, input, { signal: o.abortController!.signal, suggestions: [], toolUseID: `tu-${tool}`, requestId: 'r' } as any);
						calls.push({ tool, behavior: r?.behavior ?? 'none' });
					}
					yield { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's', num_turns: 1, duration_ms: 1, total_cost_usd: 0 };
				}
			})();
			return Object.assign(gen, { interrupt: async () => {} });
		};
		return query;
	}

	test('with a session the run gets the tools: clicks run unasked, opening a page asks with VS Code\'s words', async () => {
		const calls: { tool: string; behavior: string }[] = [];
		const seen: { options?: Options } = {};
		const query = fakeQuery(
			[
				['mcp__kingu__click_element', { pageId: 'p', ref: 'e1' }],
				['mcp__kingu__open_browser_page', { url: 'https://a.dev' }]
			],
			calls,
			seen
		);
		const out: any[] = [];
		const host = new AgentHost({ query, write: (m) => out.push(m), callApp: async () => ({ text: 'ok' }) });
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'start', params: { runId: 1, cwd: '/repo', prompt: 'go', guardAsks: { mcpTools: true }, browser: { session: 'tok' } } }));
		await Bun.sleep(30);
		const tools = (seen.options!.mcpServers!.kingu as any).instance;
		expect(tools).toBeDefined();
		expect(calls).toEqual([{ tool: 'mcp__kingu__click_element', behavior: 'allow' }]);
		// The open waits for the person, on a card that says what it does.
		const asks = out.filter((m) => m.params?.event?.kind === 'permission_request' || m.params?.event?.kind === 'guard_asked');
		const ask = asks.find((m) => m.params.event.kind === 'permission_request')?.params.event;
		expect(ask?.tool).toBe('mcp__kingu__open_browser_page');
		expect(ask?.input_summary).toBe('https://a.dev');
		await host.dispatch('shutdown', {});
	});

	test('without a session from the app there are no browser tools, and a call is not waved through', async () => {
		const calls: { tool: string; behavior: string }[] = [];
		const seen: { options?: Options } = {};
		const query = fakeQuery([['mcp__kingu__click_element', { pageId: 'p', ref: 'e1' }]], calls, seen);
		const out: any[] = [];
		const host = new AgentHost({ query, write: (m) => out.push(m), callApp: async () => ({ text: 'ok' }) });
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'start', params: { runId: 1, cwd: '/repo', prompt: 'go' } }));
		await Bun.sleep(30);
		expect(calls).toEqual([]);
		expect(out.some((m) => m.params?.event?.kind === 'permission_request' && m.params.event.tool === 'mcp__kingu__click_element')).toBe(true);
		await host.dispatch('shutdown', {});
	});
});
