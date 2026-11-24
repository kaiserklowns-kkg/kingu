// "Retry with updated sandbox permissions" (VS Code 1.147; src/sandbox/retry.ts): what a failed
// sandboxed command was stopped by, which rule stopped it (Kingu-only), the grant offered, and the
// Arkai flow that asks, widens the run's sandbox and runs the command again.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHost } from '../src/host.ts';
import { SANDBOX_GRANT_SKIPPED } from '../src/arkai/session.ts';
import type { SandboxConfig } from '../src/sandbox/config.ts';
import { policy, SANDBOX_EXEC } from '../src/sandbox/profile.ts';
import { RunSandbox } from '../src/sandbox/run.ts';
import { applyGrant, diagnose, domainsLabel, grantPrompt, grantWire, settingsPath, type DiagnoseContext } from '../src/sandbox/retry.ts';
import type { AgentEvent } from '../src/protocol.ts';
import { FakeLlm } from './fixtures/fake-llm.ts';

const ON: SandboxConfig = { allowNetwork: true, allowLocalNetwork: false, allowUnsandboxedCommands: true, readwritePaths: [], readonlyPaths: [], deniedPaths: [], maskedEnv: [], allowedDomains: [], deniedDomains: [] };
const same = (p: string) => p;
const HOME = '/Users/me';
const CWD = '/Users/me/proj';

/** A context over a made-up machine: `files` exist, nothing else does. */
function ctx(over: Partial<SandboxConfig> = {}, files: string[] = [], extra: Partial<DiagnoseContext> = {}): DiagnoseContext {
	const config = { ...ON, ...over };
	const fix = (p: string) => (p.startsWith('~/') ? join(HOME, p.slice(2)) : p.startsWith('/') ? p : join(CWD, p));
	return {
		config,
		policy: policy(config, { cwd: CWD, home: HOME, tmp: '/tmp/run' }, same),
		cwd: CWD,
		home: HOME,
		command: '',
		refusals: [],
		exists: (p) => p === '/' || files.some((f) => f === p || f.startsWith(p + '/')),
		realpath: (p) => fix(p),
		...extra
	};
}

describe('what the sandbox stopped, and the grant', () => {
	test('a write outside the writable folders: the nearest existing folder, read/write', () => {
		const d = diagnose('filesystem', '/bin/bash: line 1: /opt/out/new.txt: Operation not permitted', ctx({}, ['/opt/out']));
		expect(d.grant).toEqual({ kind: 'path', path: '/opt/out', access: 'readWrite', deniedPath: '/opt/out/new.txt', persistedPath: '/opt/out', removedReadonlyPaths: [] });
		expect(d.blocked).toEqual([{ target: '/opt/out/new.txt', rule: 'the folders sandboxed commands may write: the project folder, $TMPDIR and chat.agent.sandbox.fileSystem.userConfiguredPaths.readwritePaths' }]);
		// An existing file is granted itself; node's error puts the path after the words.
		const node = diagnose('filesystem', "Error: EPERM: operation not permitted, open '/opt/out/a.json'", ctx({}, ['/opt/out/a.json']));
		expect(node.grant).toMatchObject({ path: '/opt/out/a.json', access: 'readWrite' });
	});

	test('a read in the home folder: read access, written as ~/… in the settings', () => {
		const d = diagnose('filesystem', 'cat: /Users/me/notes/todo.md: Operation not permitted', ctx({}, ['/Users/me/notes/todo.md']));
		expect(d.grant).toEqual({ kind: 'path', path: '/Users/me/notes/todo.md', access: 'read', deniedPath: '/Users/me/notes/todo.md', persistedPath: '~/notes/todo.md', removedReadonlyPaths: [] });
		expect(d.blocked[0]!.rule).toContain('the home folder');
		// Linux hides home: an existing file reads as missing; a really missing one is not offered.
		expect(diagnose('filesystem', 'cat: /Users/me/a.txt: No such file or directory', ctx({}, ['/Users/me/a.txt'])).grant).toMatchObject({ access: 'read' });
		expect(diagnose('filesystem', 'cat: /Users/me/gone.txt: No such file or directory', ctx()).grant).toBeNull();
		// A write in home (a shell redirection) needs read/write.
		expect(diagnose('filesystem', 'bash: /Users/me/out/log.txt: Operation not permitted', ctx({}, ['/Users/me/out'])).grant).toMatchObject({ path: '/Users/me/out', access: 'readWrite' });
	});

	test('a denied path names the entry and offers nothing (Kingu-only)', () => {
		const d = diagnose('filesystem', 'cat: /Users/me/.ssh/id_ed25519: Operation not permitted', ctx({ deniedPaths: ['~/.ssh'] }, ['/Users/me/.ssh/id_ed25519']));
		expect(d).toEqual({ grant: null, blocked: [{ target: '~/.ssh/id_ed25519', rule: 'chat.agent.sandbox.fileSystem.userConfiguredPaths.deniedPaths entry `~/.ssh`' }] });
	});

	test('a read-only path: the upgrade replaces its entry', () => {
		const d = diagnose('filesystem', 'bash: /Users/me/proj/docs/a.md: Operation not permitted', ctx({ readonlyPaths: ['docs'] }, ['/Users/me/proj/docs/a.md']));
		expect(d.grant).toEqual({ kind: 'path', path: '/Users/me/proj/docs', access: 'readWrite', deniedPath: '/Users/me/proj/docs/a.md', persistedPath: 'docs', removedReadonlyPaths: ['docs'] });
		expect(d.blocked[0]!.rule).toBe('chat.agent.sandbox.fileSystem.userConfiguredPaths.readonlyPaths entry `docs`');
		expect(grantPrompt(d.grant!, HOME, d.blocked).detail.split('\n')[0]).toBe('Change access to `~/proj/docs` from read-only to read/write and retry inside the sandbox.');
	});

	test('git hooks, the whole home folder or disk, and errors that are not the sandbox: nothing offered', () => {
		const hooks = diagnose('filesystem', 'bash: /Users/me/proj/.git/hooks/pre-commit: Operation not permitted', ctx({}, ['/Users/me/proj/.git/hooks']));
		expect(hooks.grant).toBeNull();
		expect(hooks.blocked[0]!.rule).toContain('git hooks and config');
		expect(diagnose('filesystem', 'touch: /x: Operation not permitted', ctx()).grant).toBeNull();
		expect(diagnose('filesystem', 'touch: /Users/me/new: Operation not permitted', ctx({}, ['/Users/me'])).grant).toMatchObject({ path: '/Users/me/new' });
		// A writable path or an ordinary permission error is not the sandbox's doing.
		expect(diagnose('filesystem', 'bash: /Users/me/proj/a: Operation not permitted', ctx({}, ['/Users/me/proj/a'])).grant).toBeNull();
		expect(diagnose('filesystem', 'cat: /etc/sudoers: Permission denied', ctx({}, ['/etc/sudoers'])).grant).toBeNull();
	});

	test('the network: hosts from the proxy, the output or the command, checked against the lists', () => {
		const off = ctx({ allowNetwork: false });
		const d = diagnose('network', 'curl: (6) Could not resolve host: registry.npmjs.org', off);
		expect(d.grant).toEqual({ kind: 'domain', domains: ['registry.npmjs.org'] });
		expect(d.blocked).toEqual([{ target: 'registry.npmjs.org', rule: 'chat.agent.sandbox.network.allowNetwork (off: no outbound network)' }]);
		const list = ctx({ allowedDomains: ['github.com'] }, [], { refusals: [{ host: 'api.github.com', why: 'denied' }] });
		expect(diagnose('network', 'whatever', list)).toMatchObject({ grant: { domains: ['api.github.com'] }, blocked: [{ rule: 'chat.agent.sandbox.network.allowedDomains (it is not in the list)' }] });
		// The command's URLs only when nothing else named a host.
		expect(diagnose('network', 'Network is unreachable', { ...off, command: 'git clone https://gitlab.com/a/b && curl https://x.dev' }).grant).toEqual({ kind: 'domain', domains: ['gitlab.com', 'x.dev'] });
		// A denied domain names its entry, and nothing is offered while it is involved.
		const denied = diagnose('network', 'x', ctx({ deniedDomains: ['*.evil.example'] }, [], { refusals: [{ host: 'a.evil.example', why: 'denied' }] }));
		expect(denied).toEqual({ grant: null, blocked: [{ target: 'a.evil.example', rule: 'chat.agent.sandbox.network.deniedDomains entry `*.evil.example`' }] });
		// Local addresses are allowLocalNetwork's, never a domain to add.
		expect(diagnose('network', 'x', ctx({ allowedDomains: ['a.dev'] }, [], { refusals: [{ host: 'a.dev', why: 'local' }] }))).toMatchObject({ grant: null, blocked: [{ rule: expect.stringContaining('allowLocalNetwork') }] });
		expect(diagnose('network', 'Failed to connect to localhost port 3000', off).grant).toBeNull();
	});

	test('the grant applied to the run, and the prompt in VS Code\'s words', () => {
		const path = { kind: 'path' as const, path: '/opt/out', access: 'readWrite' as const, deniedPath: '/opt/out/x', persistedPath: '/opt/out', removedReadonlyPaths: [] };
		expect(applyGrant(ON, path).readwritePaths).toEqual(['/opt/out']);
		expect(applyGrant({ ...ON, readonlyPaths: ['docs'] }, { ...path, path: '/p/docs', removedReadonlyPaths: ['docs'] })).toMatchObject({ readonlyPaths: [], readwritePaths: ['/p/docs'] });
		expect(applyGrant(ON, { ...path, access: 'read' }).readonlyPaths).toEqual(['/opt/out']);
		expect(applyGrant({ ...ON, allowedDomains: ['a.dev'] }, { kind: 'domain', domains: ['b.dev', 'a.dev'] }).allowedDomains).toEqual(['a.dev', 'b.dev']);

		const p = grantPrompt(path, HOME, [{ target: '/opt/out/x', rule: 'R' }]);
		expect(p.title).toBe('Allow sandbox path access and retry?');
		expect(p.detail).toBe('Allow read/write access to `/opt/out` and retry inside the sandbox.\n\nThe blocked path was `/opt/out/x`. Access will cover `/opt/out`, including its contents if it is a folder.\n\nBlocked by `/opt/out/x`: R.');
		expect(grantPrompt({ ...path, access: 'read', deniedPath: '/opt/out' }, HOME, []).detail).toBe('Allow read access to `/opt/out` and retry inside the sandbox.');
		expect(grantPrompt({ kind: 'domain', domains: ['a.dev'] }, HOME, []).title).toBe('Retry `Bash` command in the sandbox by allowing network access to `a.dev`?');
		expect(domainsLabel(['a.dev', 'b.dev', 'c.dev'])).toBe('`a.dev` and 2 more domains');
		expect(settingsPath('/Users/me/x', HOME)).toBe('~/x');
		expect(grantWire(path, [])).toEqual({ kind: 'path', path: '/opt/out', access: 'readWrite', denied_path: '/opt/out/x', persisted_path: '/opt/out', removed_readonly_paths: [], blocked: [] });
	});
});

// ---------------------------------------------------------------------------------------------
// Under the real sandbox (macOS)

const dirs: string[] = [];
const hosts: AgentHost[] = [];
const llms: FakeLlm[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.dispatch('shutdown', null)));
	for (const s of llms.splice(0)) s.stop();
	for (const c of closers.splice(0)) c();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (name: string) => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), `kingu-${name}-`)));
	dirs.push(d);
	return d;
};
const canSandbox = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) && Bun.spawnSync([SANDBOX_EXEC, '-p', '(version 1)\n(allow default)\n', '--', '/usr/bin/true']).exitCode === 0;
const real = canSandbox ? test : test.skip;

type Out = { id?: number | string | null; method?: string; params?: any };
function arkai() {
	const llm = new FakeLlm();
	llms.push(llm);
	const out: Out[] = [];
	let n = 0;
	const host = new AgentHost({ query: () => { throw new Error('the Claude SDK must not run'); }, write: (m) => void out.push(JSON.parse(JSON.stringify(m))), newId: () => `req-${++n}`, log: () => {} });
	hosts.push(host);
	const events = () => out.filter((o) => o.method === 'event' && o.params.runId === 1).map((o) => o.params.event as AgentEvent);
	const nth = async <K extends AgentEvent['kind']>(kind: K, k = 1) => {
		for (let i = 0; i < 1500; i++) {
			const seen = events().filter((e) => e.kind === kind);
			if (seen.length >= k) return seen[k - 1] as Extract<AgentEvent, { kind: K }>;
			await Bun.sleep(10);
		}
		throw new Error(`timed out waiting for ${kind} #${k}`);
	};
	const call = (id: number, method: string, params: unknown) => host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
	const runtime = { kind: 'arkai', provider: { id: 'local', name: 'Local', api: 'openai', baseUrl: `${llm.url}/v1`, apiKey: 'sk', models: [{ id: 'coder', contextWindow: 64_000 }] }, model: 'coder' };
	const toolResults = (request: number) => llm.requests[request]!.body.messages.filter((m: { role: string }) => m.role === 'tool').map((m: { content: string }) => m.content) as string[];
	return { llm, events, nth, call, runtime, toolResults };
}

describe('retry with updated sandbox permissions (real sandbox-exec)', () => {
	real('allowed for the session: the folder joins the sandbox, the command runs again inside it, and the next one needs no prompt', async () => {
		const cwd = temp('sbr-ws');
		const outside = temp('sbr-out');
		const { llm, events, nth, call, runtime, toolResults } = arkai();
		const write = (f: string) => JSON.stringify({ command: `echo hi > ${JSON.stringify(join(outside, f))}` });
		llm.reply({ calls: [{ id: 'w1', name: 'Bash', args: write('a.txt') }] }, { calls: [{ id: 'w2', name: 'Bash', args: write('b.txt') }] }, { text: ['done'] });
		await call(1, 'start', { runId: 1, cwd, prompt: 'write', runtime, permissionMode: 'bypassPermissions', sandbox: { enabled: 'on' } });
		const req = await nth('permission_request');
		expect(req).toMatchObject({ title: 'Allow sandbox path access and retry?', can_always: false, sandbox_grant: { kind: 'path', path: outside, access: 'readWrite', denied_path: join(outside, 'a.txt') } });
		expect(req.detail).toContain(`Allow read/write access to \`${outside}\` and retry inside the sandbox.`);
		expect(existsSync(join(outside, 'a.txt'))).toBe(false);
		await call(2, 'answer', { runId: 1, requestId: req.request_id, decision: 'allow_always' });
		expect(await nth('result')).toMatchObject({ is_error: false });
		expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('hi\n');
		expect(readFileSync(join(outside, 'b.txt'), 'utf8')).toBe('hi\n');
		expect(toolResults(1)[0]).toStartWith(`The user allowed read/write access to ${outside} in the sandbox for this session; the command ran again.`);
		expect(events().filter((e) => e.kind === 'permission_request').length).toBe(1);
		expect(events().filter((e) => e.kind === 'tool_result').map((e) => (e as { is_error: boolean }).is_error)).toEqual([false, false]);
	});

	real('Skip: the command is not retried and the model is told', async () => {
		const cwd = temp('sbr-ws');
		const outside = temp('sbr-out');
		const { llm, nth, call, runtime, toolResults } = arkai();
		llm.reply({ calls: [{ id: 's1', name: 'Bash', args: JSON.stringify({ command: `touch ${JSON.stringify(join(outside, 'x'))}` }) }] }, { text: ['ok'] });
		await call(1, 'start', { runId: 1, cwd, prompt: 'x', runtime, permissionMode: 'bypassPermissions', sandbox: { enabled: 'on' } });
		const req = await nth('permission_request');
		await call(2, 'answer', { runId: 1, requestId: req.request_id, decision: 'deny', message: 'use the project folder' });
		await nth('result');
		expect(existsSync(join(outside, 'x'))).toBe(false);
		expect(toolResults(1)[0]).toContain(`${SANDBOX_GRANT_SKIPPED} They said: use the project folder`);
	});

	real('a domain the proxy refused: allowed for the session, the request goes through on the retry', async () => {
		const srv = createServer((q, s) => s.end(`pong ${q.headers.host}`));
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
		closers.push(() => srv.close());
		const port = (srv.address() as { port: number }).port;
		const cwd = temp('sbr-net');
		const run = new RunSandbox({ ...ON, allowNetwork: false, allowedDomains: ['allowed.example'] }, cwd, { proxy: { resolve: async () => ['127.0.0.1'], isLocal: () => false } });
		closers.push(() => run.dispose());
		const { runTool } = await import('../src/arkai/tools.ts');
		const signal = new AbortController().signal;
		const bash = (command: string) => runTool('Bash', { command }, { cwd, env: { ...process.env }, signal, sandbox: { run, unsandboxed: false } });
		const url = `http://other.example:${port}/`;
		const first = await bash(`curl -sS -f --max-time 5 ${url}`);
		expect(first.isError).toBe(true);
		expect(first.sandbox?.grant).toEqual({ kind: 'domain', domains: ['other.example'] });
		expect(first.content).toContain('- Blocked by: other.example (chat.agent.sandbox.network.allowedDomains (it is not in the list))');
		run.grant(first.sandbox!.grant!);
		const again = await bash(`curl -sS -f --max-time 5 ${url}`);
		expect(again).toMatchObject({ isError: false, content: `pong other.example:${port}` });
	});
});

