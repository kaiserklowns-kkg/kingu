import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers';
import { watchErrors } from './mock';

// MCP Apps (SEP-1865, VS Code's chatMcpAppModel.ts): a tool's `ui://` page under its call in the
// chat, in VS Code's sandboxed frame on an origin of its own (src-tauri/src/mcp_app.rs, served
// here by the test), talking to the chat only over the ext-apps postMessage bridge
// (agent/mcpApp.ts). The run side (permission rules on the app's calls, the model calling the
// app's tools) is covered by agent-host test/arkai-mcp-apps.test.ts; Rust's CSP and origins by
// `cargo test mcp_app`.

/** A small ext-apps client: initialize, show the input and result, call an app-only tool, register `zoom`, probe its reach. */
const APP = `<!doctype html><html><head><title>Chart</title></head><body>
<h1 id="title">loading</h1><p id="result"></p><p id="refresh"></p><p id="probe"></p><p id="host"></p>
<button id="refreshBtn">Refresh</button>
<script>
let n = 0; const pending = {};
const req = (method, params) => new Promise((resolve, reject) => { const id = ++n; pending[id] = { resolve, reject }; parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*'); });
const notify = (method, params) => parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
const answer = (id, result) => parent.postMessage({ jsonrpc: '2.0', id, result }, '*');
addEventListener('message', (e) => {
	if (e.source !== parent) return;
	const m = e.data;
	if (m.id !== undefined && !m.method) { const p = pending[m.id]; delete pending[m.id]; m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
	if (m.method === 'ui/notifications/tool-input') document.getElementById('title').textContent = 'Chart: ' + m.params.arguments.title;
	if (m.method === 'ui/notifications/tool-result') document.getElementById('result').textContent = m.params.content[0].text;
	if (m.method === 'tools/list') answer(m.id, { tools: [{ name: 'zoom', description: 'Zoom the chart', inputSchema: { type: 'object', properties: { level: { type: 'number' } } } }] });
	if (m.method === 'tools/call') answer(m.id, { content: [{ type: 'text', text: 'zoomed to ' + m.params.arguments.level }] });
});
const probe = ['tauri:' + typeof window.__TAURI_INTERNALS__, 'ipc:' + typeof window.ipc];
try { probe.push('parent:' + (parent.document ? 'open' : 'none')); } catch { probe.push('parent:blocked'); }
try { probe.push('top:' + (top.location.href ? 'open' : 'none')); } catch { probe.push('top:blocked'); }
document.getElementById('probe').textContent = probe.join(' ');
(async () => {
	const init = await req('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'chart', version: '1' }, appCapabilities: { tools: { listChanged: true } } });
	document.getElementById('host').textContent = init.hostInfo.name + ' ' + init.protocolVersion + ' ' + init.hostContext.displayMode + ' ' + init.hostContext.theme;
	notify('ui/notifications/initialized', {});
	notify('ui/notifications/size-changed', { height: 240 });
})();
document.getElementById('refreshBtn').onclick = async () => {
	try { const r = await req('tools/call', { name: 'refresh', arguments: { range: 'week' } }); document.getElementById('refresh').textContent = r.content[0].text; }
	catch (e) { document.getElementById('refresh').textContent = 'error: ' + e.message; }
};
</script></body></html>`;

async function chartRun(page: Page, settings: Record<string, unknown> = {}) {
	await page.route('http://kingu-mcp-app.localhost/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: APP }));
	await openApp(page, undefined, settings, { mcpApp: true });
	const chat = page.getByRole('complementary', { name: 'Chat' });
	const input = chat.getByRole('combobox', { name: /Chat with/ });
	await input.fill('Chart the sales');
	await input.press('Enter');
	await expect(chat.getByText('Here is the chart.')).toBeVisible({ timeout: 10_000 });
	return chat;
}

const mcp = (page: Page) => page.evaluate(() => (window as any).__e2e.mcpApp as { opened: any[]; requests: any[]; tools: any[]; results: any[] });

test('a tool\'s MCP App renders under its call in VS Code\'s sandbox, isolated from Kingu', async ({ page }) => {
	const errors = watchErrors(page);
	const chat = await chartRun(page);
	const frame = chat.locator('iframe[title="MCP App: charts"]');
	await expect(frame).toBeVisible();
	// VS Code's frame for webview content: these sandbox and allow lists, nothing more.
	await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin allow-pointer-lock allow-scripts allow-downloads allow-forms');
	await expect(frame).toHaveAttribute('allow', 'cross-origin-isolated; autoplay; clipboard-read; clipboard-write');
	expect((await mcp(page)).opened).toEqual([{ runId: 1, chatId: expect.any(String), server: 'charts', uri: 'ui://charts/chart.html' }]);

	const app = page.frameLocator('iframe[title="MCP App: charts"]');
	await expect(app.locator('#host')).toHaveText('Kingu 2026-01-26 inline dark');
	await expect(app.locator('#title')).toHaveText('Chart: Sales');
	await expect(app.locator('#result')).toHaveText('Drew 3 bars');
	// No Tauri IPC, no way into the chat's window.
	await expect(app.locator('#probe')).toHaveText('tauri:undefined ipc:undefined parent:blocked top:blocked');
	// The app asked for 240 px.
	await expect(frame).toHaveCSS('height', '240px');
	// After the next turn the first folds its steps into "Worked for"; the app stays, still loaded.
	await page.evaluate(() => {
		const send = (window as any).__e2e.mcpApp.send;
		send({ kind: 'message', role: 'user', text: 'Thanks' });
		send({ kind: 'message', role: 'assistant', text: 'You are welcome.' });
		send({ kind: 'result', subtype: 'success', is_error: false, result: 'You are welcome.', session_id: 'session-e2e', num_turns: 2, duration_ms: 5, total_cost_usd: 0 });
	});
	await expect(chat.getByText('You are welcome.')).toBeVisible();
	await expect(chat.getByRole('button', { name: /Worked/ }).first()).toBeVisible();
	await expect(chat.getByRole('button', { name: 'Ran show_chart (charts)' })).toHaveCount(0);
	await expect(frame).toBeVisible();
	await expect(app.locator('#result')).toHaveText('Drew 3 bars');
	expect((await mcp(page)).opened).toHaveLength(1);
	expect(errors).toEqual([]);
});

test('the app calls an app-only tool through the run, and the model calls the tool the app registered', async ({ page }) => {
	const errors = watchErrors(page);
	await chartRun(page);
	const app = page.frameLocator('iframe[title="MCP App: charts"]');
	await expect(app.locator('#result')).toHaveText('Drew 3 bars');

	// The app's own call goes to its server through the chat's run (which applies the permission rules).
	await app.getByRole('button', { name: 'Refresh' }).click();
	await expect(app.locator('#refresh')).toHaveText('refreshed week');
	expect((await mcp(page)).requests).toEqual([{ runId: 1, server: 'charts', method: 'tools/call', params: { name: 'refresh', arguments: { range: 'week' } } }]);

	// The tool it registered is published for the model's next request.
	await expect.poll(async () => (await mcp(page)).tools.at(-1)?.tools?.map((t: any) => t.name)).toEqual(['zoom']);
	const { appId } = (await mcp(page)).tools.at(-1);
	expect(appId).toMatch(/^app-1:/);

	// The model calls it: the app answers, the chat sends the result to the run.
	await page.evaluate((appId) => (window as any).__e2e.mcpApp.send({ kind: 'mcp_app_tool_call', request_id: 'tc-1', app_id: appId, name: 'zoom', arguments: { level: 3 } }), appId);
	await expect.poll(async () => (await mcp(page)).results).toEqual([{ runId: 1, requestId: 'tc-1', result: { content: [{ type: 'text', text: 'zoomed to 3' }] }, error: null }]);
	// A tool no app provides is answered with VS Code's error.
	await page.evaluate(() => (window as any).__e2e.mcpApp.send({ kind: 'mcp_app_tool_call', request_id: 'tc-2', app_id: 'gone', name: 'zoom', arguments: {} }));
	await expect.poll(async () => (await mcp(page)).results.at(-1)).toEqual({ runId: 1, requestId: 'tc-2', result: null, error: 'MCP app tool "zoom" is no longer available.' });
	expect(errors).toEqual([]);
});

test('chat.mcp.apps.enabled off: no app is loaded', async ({ page }) => {
	const errors = watchErrors(page);
	const chat = await chartRun(page, { 'chat.mcp.apps.enabled': false });
	await expect(chat.getByRole('button', { name: /Worked/ })).toBeVisible();
	await expect(chat.locator('iframe[title="MCP App: charts"]')).toHaveCount(0);
	expect((await mcp(page)).opened).toEqual([]);
	expect(errors).toEqual([]);
});
