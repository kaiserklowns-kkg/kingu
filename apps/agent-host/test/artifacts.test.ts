// The artifact tool (src/artifacts.ts) with a fake app: no socket to a real Kingu, no model.

import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ARTIFACT_TOOL, defaultName, insideCwd, METHOD_PUBLISH, nameError, publishArtifact, readRuntime, socketCaller } from '../src/artifacts.ts';
import { askFor } from '../src/guards/asks.ts';
import { AgentHost, type QueryFn } from '../src/host.ts';
import type { AgentEvent } from '../src/protocol.ts';

const dirs: string[] = [];
const temp = () => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-art-test-')));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ID = '0123456789abcdef';
const answer = (title = 'Report') => ({ id: ID, version: 2, title, format: 'html', root: '/repo', path: `/repo/.kingu/artifacts/${ID}/v2/index.html` });

describe('names and paths', () => {
	test('only safe relative names', () => {
		for (const ok of ['index.css', 'img/a.png', 'a/b/c/d/e/f/g/h.txt', 'ไฟล์.json']) expect(nameError(ok)).toBeNull();
		for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a/.', 'a\\b', 'a\0b', 'a/b/c/d/e/f/g/h/i', 'x'.repeat(201)]) expect(nameError(bad)).not.toBeNull();
	});

	test('asset paths stay inside the folder, symlinks resolved', () => {
		const cwd = temp();
		const outside = temp();
		mkdirSync(join(cwd, 'img'));
		writeFileSync(join(cwd, 'img/a.png'), 'png');
		writeFileSync(join(outside, 'secret'), 'key');
		symlinkSync(join(outside, 'secret'), join(cwd, 'link'));
		symlinkSync(outside, join(cwd, 'dir'));
		expect(insideCwd(cwd, 'img/a.png')).toBe(join(cwd, 'img/a.png'));
		expect(insideCwd(cwd, join(cwd, 'img/a.png'))).toBe(join(cwd, 'img/a.png'));
		expect(() => insideCwd(cwd, 'link')).toThrow('inside the project folder');
		expect(() => insideCwd(cwd, 'dir/secret')).toThrow('inside the project folder');
		expect(() => insideCwd(cwd, join(outside, 'secret'))).toThrow('inside the project folder');
		expect(() => insideCwd(cwd, '../x')).toThrow();
		expect(() => insideCwd(cwd, 'img')).toThrow('not a regular file');
		expect(() => insideCwd(cwd, 'missing.png')).toThrow('no such file');
		expect(defaultName(cwd, join(cwd, 'img/a.png'))).toBe('img/a.png');
		expect(defaultName(join(cwd, 'img'), join(cwd, 'b.png'))).toBe('b.png');
	});
});

describe('publishArtifact', () => {
	test('stages inline content privately, calls the app, emits the card and cleans up', async () => {
		const cwd = temp();
		const tmp = temp();
		writeFileSync(join(cwd, 'logo.svg'), '<svg/>');
		const events: AgentEvent[] = [];
		let seen: { method: string; params: any; staged: Record<string, string> } | null = null;
		const call = async (method: string, params: any) => {
			const stagedDir = join(params.file, '..');
			const staged: Record<string, string> = { [params.file.split('/').pop()]: readFileSync(params.file, 'utf8') };
			for (const a of params.assets) staged[a.name] = readFileSync(a.path, 'utf8');
			expect(Number(statSync(stagedDir).mode & 0o777)).toBe(0o700);
			expect(Number(statSync(params.file).mode & 0o777)).toBe(0o600);
			seen = { method, params, staged };
			return answer();
		};
		const res = await publishArtifact(
			{ title: ' Report ', html: '<h1>Hi</h1>', description: 'd', assets: [{ path: 'logo.svg' }], files: [{ name: 'data/p.json', content: '[1]' }, { name: 'b.bin', content: Buffer.from('xyz').toString('base64'), encoding: 'base64' }] },
			{ cwd, call, emit: (e) => events.push(e), tmp }
		);
		expect(res.isError).toBeUndefined();
		expect(res.content[0]!.text).toContain(`id ${ID}, version 2`);
		expect(seen!.method).toBe(METHOD_PUBLISH);
		expect(seen!.params).toMatchObject({ cwd, title: 'Report', description: 'd', id: null, source: 'agent' });
		expect(seen!.params.file.startsWith(tmp)).toBe(true);
		expect(seen!.staged).toEqual({ 'index.html': '<h1>Hi</h1>', 'logo.svg': '<svg/>', 'data/p.json': '[1]', 'b.bin': 'xyz' });
		expect(seen!.params.assets[0]).toEqual({ path: join(cwd, 'logo.svg'), name: 'logo.svg' });
		expect(events).toEqual([{ kind: 'artifact', id: ID, title: 'Report', version: 2, format: 'html', root: '/repo' }]);
		expect(readdirSync(tmp)).toEqual([]);
	});

	test('a file in the folder goes as is (nothing staged)', async () => {
		const cwd = temp();
		const tmp = temp();
		writeFileSync(join(cwd, 'notes.md'), '# Notes');
		let file = '';
		const res = await publishArtifact({ title: 'Notes', path: 'notes.md', id: ID }, { cwd, tmp, emit: () => {}, call: async (_m, p: any) => ((file = p.file), expect(p.id).toBe(ID), answer('Notes')) });
		expect(res.isError).toBeUndefined();
		expect(file).toBe(join(cwd, 'notes.md'));
		expect(readdirSync(tmp)).toEqual([]);
	});

	test('errors come back to the model and leave nothing behind', async () => {
		const cwd = temp();
		const tmp = temp();
		writeFileSync(join(cwd, 'a.txt'), 'x');
		const events: AgentEvent[] = [];
		const run = (input: any, call = async () => answer()) => publishArtifact(input, { cwd, tmp, call, emit: (e) => events.push(e) });
		for (const [input, why] of [
			[{ title: 'x' }, 'exactly one'],
			[{ title: 'x', html: 'a', markdown: 'b' }, 'exactly one'],
			[{ title: ' ', html: 'a' }, 'title'],
			[{ title: 'x', html: 'a', id: 'nope' }, 'id'],
			[{ title: 'x', path: 'a.txt' }, '.html'],
			[{ title: 'x', html: 'a', files: [{ name: '../evil', content: '' }] }, '..'],
			[{ title: 'x', html: 'a', files: [{ name: 'index.html', content: '' }] }, 'same name'],
			[{ title: 'x', html: 'a', assets: [{ path: '/etc/hosts' }] }, 'inside the project folder']
		] as const) {
			const res = await run(input);
			expect(res.isError).toBe(true);
			expect(res.content[0]!.text).toContain(why);
		}
		const refused = await run({ title: 'x', html: 'a' }, async () => {
			throw new Error('No folder is open in Kingu');
		});
		expect(refused.content[0]!.text).toBe('Artifact not published: No folder is open in Kingu');
		const odd = await run({ title: 'x', html: 'a' }, async () => ({ id: 'x' }) as any);
		expect(odd.isError).toBe(true);
		expect(events).toEqual([]);
		expect(readdirSync(tmp)).toEqual([]);
	});
});

describe('the app socket', () => {
	const runtimeFile = (dir: string, socket: string, mode = 0o600) => {
		const f = join(dir, 'runtime.json');
		writeFileSync(f, JSON.stringify({ version: 1, pid: 1, socket, token: 'a'.repeat(64), app_version: '0' }));
		chmodSync(f, mode);
		return f;
	};

	test('refuses a runtime file others can read, or a missing one', () => {
		const dir = temp();
		expect(() => readRuntime(join(dir, 'none.json'))).toThrow('not running');
		expect(() => readRuntime(runtimeFile(dir, '/x.sock', 0o644))).toThrow('other users');
		expect(readRuntime(runtimeFile(dir, '/x.sock'))).toEqual({ socket: '/x.sock', token: 'a'.repeat(64) });
		symlinkSync(join(dir, 'runtime.json'), join(dir, 'link.json'));
		expect(() => readRuntime(join(dir, 'link.json'))).toThrow('not a regular file');
	});

	test('sends one line with the token and reads the answer', async () => {
		const dir = temp();
		const sock = join(dir, 's.sock');
		const got: any[] = [];
		const server = createServer((c) => {
			let buf = '';
			c.on('data', (d) => {
				buf += d;
				if (!buf.includes('\n')) return;
				const req = JSON.parse(buf);
				got.push(req);
				c.write(`${JSON.stringify(req.params.fail ? { id: req.id, ok: false, error: { code: 'failed', message: 'nope' } } : { id: req.id, ok: true, result: { echo: req.params } })}\n`);
			});
		});
		await new Promise<void>((r) => server.listen(sock, r));
		try {
			const call = socketCaller(runtimeFile(dir, sock));
			expect(await call('artifact.publish', { a: 1 })).toEqual({ echo: { a: 1 } });
			expect(got[0]).toMatchObject({ id: 1, authToken: 'a'.repeat(64), method: 'artifact.publish' });
			await expect(call('artifact.publish', { fail: true })).rejects.toThrow('nope');
			await expect(socketCaller(runtimeFile(dir, join(dir, 'missing.sock')))('x', {})).rejects.toThrow('not reachable');
		} finally {
			server.close();
		}
	});
});

describe('in the host', () => {
	test('a Claude run gets the kingu server; its tool is allowed outside plan mode and exempt from the MCP ask', async () => {
		const calls: { mode: string; behavior: string }[] = [];
		let options: Options | undefined;
		const query: QueryFn = ({ prompt, options: o }) => {
			options = o;
			const gen = (async function* () {
				for await (const _m of prompt as AsyncIterable<SDKUserMessage>) {
					const r = await o.canUseTool!(ARTIFACT_TOOL, { title: 't', html: 'x' }, { signal: o.abortController!.signal, suggestions: [], toolUseID: 'tu1', requestId: 'r' } as any);
					calls.push({ mode: o.permissionMode!, behavior: r?.behavior ?? 'none' });
					yield { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's', num_turns: 1, duration_ms: 1, total_cost_usd: 0 };
				}
			})();
			return Object.assign(gen, { interrupt: async () => {} });
		};
		const out: any[] = [];
		const host = new AgentHost({ query, write: (m) => out.push(m), callApp: async () => answer() });
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'start', params: { runId: 1, cwd: '/repo', prompt: 'go', guardAsks: { mcpTools: true } } }));
		await Bun.sleep(20);
		expect(Object.keys(options!.mcpServers ?? {})).toEqual(['kingu']);
		expect((options!.mcpServers!.kingu as any).type).toBe('sdk');
		expect(calls).toEqual([{ mode: 'default', behavior: 'allow' }]);
		expect(out.some((m) => m.params?.event?.kind === 'permission_request')).toBe(false);
		// Plan mode asks.
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'start', params: { runId: 2, cwd: '/repo', prompt: 'go', permissionMode: 'plan' } }));
		await Bun.sleep(20);
		expect(out.some((m) => m.params?.runId === 2 && m.params.event.kind === 'permission_request' && m.params.event.tool === ARTIFACT_TOOL)).toBe(true);
		// A server of the run named `kingu` wins: no artifact tool.
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'start', params: { runId: 3, cwd: '/repo', prompt: 'go', mcpServers: { kingu: { command: '/bin/x' } } } }));
		await Bun.sleep(20);
		expect((options!.mcpServers!.kingu as any).type).toBe('stdio');
		await host.dispatch('shutdown', {});
	});

	test('without the app (no runtime file, no callApp) there is no server', async () => {
		const prev = process.env.KINGU_CLI_RUNTIME;
		delete process.env.KINGU_CLI_RUNTIME;
		try {
			let options: Options | undefined;
			const query: QueryFn = ({ options: o }) => ((options = o), Object.assign((async function* () {})(), { interrupt: async () => {} }));
			const host = new AgentHost({ query, write: () => {} });
			await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'start', params: { runId: 1, cwd: '/repo', prompt: 'go' } }));
			expect(options!.mcpServers).toBeUndefined();
		} finally {
			if (prev !== undefined) process.env.KINGU_CLI_RUNTIME = prev;
		}
	});

	test('the MCP ask skips only trusted tools', () => {
		const cfg = { mcpTools: true, trustedTools: [ARTIFACT_TOOL] };
		expect(askFor(ARTIFACT_TOOL, {}, '/repo', cfg, [])).toBeNull();
		expect(askFor('mcp__other__x', {}, '/repo', cfg, [])?.check).toBe('mcp');
		expect(askFor(ARTIFACT_TOOL, {}, '/repo', { mcpTools: true }, [])?.check).toBe('mcp');
	});
});

test('staging dirs are never left behind by a throwing app', async () => {
	const cwd = temp();
	const tmp = temp();
	await publishArtifact({ title: 'x', markdown: '# x' }, { cwd, tmp, emit: () => {}, call: async () => Promise.reject(new Error('boom')) });
	expect(existsSync(tmp) && readdirSync(tmp).length).toBe(0);
});
