// Signing an ACP agent in from the chat (src/runtimes/acpSignIn.ts, Orca's Antigravity sign-in):
// the link reader, then runs of the fake agent (fixtures/fake-acp.ts) under the program names of
// Antigravity's managed server and of `agy`, the way Rust starts them.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHost } from '../src/host.ts';
import type { AgentEvent } from '../src/protocol.ts';
import { readSignInLine, signInUrl, SIGN_IN_PROMPT, BROWSER_MARKER } from '../src/runtimes/acpSignIn.ts';
import { acpDialect } from '../src/runtimes/acpDialects.ts';

type Out = { id?: number | string | null; method?: string; params?: any; result?: unknown; error?: { code: number; message: string } };
type SignIn = Extract<AgentEvent, { kind: 'sign_in' }>;

const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F&response_type=code&state=s1';

describe('the sign-in link', () => {
	test("only Google's sign-in that returns to a loopback port here is shown", () => {
		expect(signInUrl(GOOGLE)).toBe(GOOGLE);
		for (const bad of [
			GOOGLE.replace('accounts.google.com', 'accounts.google.com.evil.test'),
			GOOGLE.replace('http%3A%2F%2F127.0.0.1%3A43123%2F', 'https%3A%2F%2Fevil.test%2F'),
			GOOGLE.replace('43123', '80'),
			GOOGLE.replace('response_type=code', 'response_type=token'),
			GOOGLE.replace('&state=s1', ''),
			`${GOOGLE}&state=again`,
			`${GOOGLE}#frag`,
			'https://user:pw@accounts.google.com/o/oauth2/v2/auth',
			'not a url'
		])
			expect(signInUrl(bad)).toBeNull();
	});

	test("the server's printed line and the browser helper's are read; other lines are not sign-in lines", () => {
		expect(readSignInLine(`${SIGN_IN_PROMPT}${GOOGLE}\r`, 'stdout')).toBe(GOOGLE);
		expect(readSignInLine(`${BROWSER_MARKER}${GOOGLE}`, 'stderr')).toBe(GOOGLE);
		// The helper's marker counts on stderr only; an unsafe link is a sign-in line that shows nothing.
		expect(readSignInLine(`${BROWSER_MARKER}${GOOGLE}`, 'stdout')).toBeUndefined();
		expect(readSignInLine(`${SIGN_IN_PROMPT}https://evil.test/`, 'stdout')).toBeNull();
		expect(readSignInLine('loading model catalog', 'stderr')).toBeUndefined();
	});

	test("Antigravity's two programs sign in their own ways", () => {
		expect(acpDialect('/data/agent-runtimes/antigravity/1.5.2/agy_acp_server.par').signIn).toEqual({ via: 'browser', method: 'oauth-personal' });
		expect(acpDialect('C:\\kingu\\agy_acp_server.exe').signIn?.via).toBe('browser');
		expect(acpDialect('/opt/bin/agy').signIn).toEqual({ via: 'terminal', login: ['env', 'AGY_CLI_DISABLE_AUTO_UPDATE=true', 'agy'] });
		expect(acpDialect('/opt/bin/gemini').signIn).toBeUndefined();
		expect(acpDialect('agy_acp_server.par').sessionMeta).toEqual({ antigravity: { disabledTools: ['run_workflow'] } });
	});
});

const dirs: string[] = [];
const hosts: AgentHost[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.dispatch('shutdown', null)));
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A run of the fake agent whose program is called `program` (a link to this bun). */
function setup(program: string) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-signin-')));
	dirs.push(cwd);
	const command = join(cwd, program);
	symlinkSync(process.execPath, command);
	const runtime = { kind: 'acp', command, args: [join(import.meta.dir, 'fixtures/fake-acp.ts')] };
	const out: Out[] = [];
	const waiters: { pred: (o: Out) => boolean; resolve: (o: Out) => void }[] = [];
	const host = new AgentHost({
		query: () => {
			throw new Error('the Claude SDK must not run');
		},
		write: (m) => {
			const o = JSON.parse(JSON.stringify(m)) as Out;
			out.push(o);
			for (const w of [...waiters]) if (w.pred(o)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(o));
		},
		newId: () => 'req'
	});
	hosts.push(host);
	const next = (pred: (o: Out) => boolean, ms = 8000) =>
		new Promise<Out>((resolve, reject) => {
			const hit = out.find(pred);
			if (hit) return resolve(hit);
			waiters.push({ pred, resolve });
			setTimeout(() => reject(new Error('timed out waiting for host output')), ms);
		});
	const events = () => out.filter((o) => o.method === 'event').map((o) => o.params.event as AgentEvent);
	const signIn = (state: SignIn['state'], after = 0) => next((o) => o.method === 'event' && o.params.event.kind === 'sign_in' && o.params.event.state === state && out.indexOf(o) >= after).then((o) => o.params.event as SignIn);
	const event = <K extends AgentEvent['kind']>(kind: K) => next((o) => o.method === 'event' && o.params.event.kind === kind).then((o) => o.params.event as Extract<AgentEvent, { kind: K }>);
	let id = 0;
	const call = async (method: string, params: unknown) => {
		const n = ++id;
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }));
		return out.findLast((o) => o.id === n)!;
	};
	const start = (env: Record<string, string>) => call('start', { runId: 1, cwd, prompt: 'hi', runtime, env });
	return { cwd, out, events, signIn, event, call, start, next };
}

describe("Kingu's Antigravity server signs in from the chat", () => {
	test('signed out, the run waits; Sign in runs the agent’s own Google sign-in and shows its link, then the chat goes on', async () => {
		const r = setup('agy_acp_server.par');
		await r.start({ FAKE_ACP_AUTH: 'google' });
		const required = await r.signIn('required');
		expect(required).toEqual({ kind: 'sign_in', state: 'required', via: 'browser', agent: 'Antigravity' });
		expect(r.events().some((e) => e.kind === 'error' || e.kind === 'exit')).toBe(false);
		expect((await r.call('sign_in', { runId: 1 })).error).toBeUndefined();
		await r.signIn('starting');
		const waiting = await r.signIn('waiting');
		expect(waiting.url).toBe(GOOGLE);
		await r.signIn('verifying');
		await r.signIn('signed_in');
		const result = await r.event('result');
		expect(result.is_error).toBe(false);
		// The link was shown once, on the card only, never as agent output.
		expect(r.events().filter((e) => e.kind === 'sign_in' && e.state === 'waiting')).toHaveLength(1);
		expect(r.events().some((e) => (e.kind === 'stderr' || e.kind === 'raw') && e.line.includes('accounts.google.com'))).toBe(false);
		// The session was opened with the server's _meta.
		expect(r.events().some((e) => e.kind === 'stderr' && e.line === 'meta {"antigravity":{"disabledTools":["run_workflow"]}}')).toBe(true);
	});

	test('a failed sign-in says why and can be tried again; stopping ends the wait', async () => {
		const r = setup('agy_acp_server.par');
		await r.start({ FAKE_ACP_AUTH: 'google', FAKE_ACP_AUTH_FAIL: '1' });
		await r.signIn('required');
		await r.call('sign_in', { runId: 1 });
		const failed = await r.signIn('failed');
		expect(failed.error).toContain('cancelled');
		await r.call('stop', { runId: 1 });
		const exit = await r.event('exit');
		expect(exit.stopped).toBe(true);
		expect(r.events().some((e) => e.kind === 'error')).toBe(false);
	});

	test("the chat's Stop (interrupt) while waiting for a sign-in ends the run", async () => {
		const r = setup('agy_acp_server.par');
		await r.start({ FAKE_ACP_AUTH: 'google' });
		await r.signIn('required');
		expect((await r.call('interrupt', { runId: 1 })).error).toBeUndefined();
		const exit = await r.event('exit');
		expect(exit.stopped).toBe(true);
		expect(r.events().some((e) => e.kind === 'error')).toBe(false);
	});

	test('a Gemini API key account signs in with that method, no link, and the method is on the card', async () => {
		const r = setup('agy_acp_server.par');
		await r.start({ FAKE_ACP_AUTH: 'key', KINGU_ANTIGRAVITY_AUTH_METHOD: 'gemini-api-key', GEMINI_API_KEY: 'k' });
		const required = await r.signIn('required');
		expect(required).toEqual({ kind: 'sign_in', state: 'required', via: 'browser', agent: 'Antigravity', method: 'gemini-api-key' });
		await r.call('sign_in', { runId: 1 });
		await r.signIn('signed_in');
		expect((await r.event('result')).is_error).toBe(false);
		expect(r.events().some((e) => e.kind === 'stderr' && e.line === 'authenticate gemini-api-key')).toBe(true);
		expect(r.events().some((e) => e.kind === 'sign_in' && e.state === 'waiting')).toBe(false);
	});

	test('without a key the server refuses, and the card says why', async () => {
		const r = setup('agy_acp_server.par');
		await r.start({ FAKE_ACP_AUTH: 'key', KINGU_ANTIGRAVITY_AUTH_METHOD: 'gemini-api-key' });
		await r.signIn('required');
		await r.call('sign_in', { runId: 1 });
		const failed = await r.signIn('failed');
		expect(failed.error).toContain('GEMINI_API_KEY');
		expect(failed.method).toBe('gemini-api-key');
	});

	test('the method comes only from the launch, only for the server, only a known one', () => {
		expect(acpDialect('agy_acp_server.par', { KINGU_ANTIGRAVITY_AUTH_METHOD: 'agent-platform' }).signIn).toEqual({ via: 'browser', method: 'agent-platform' });
		expect(acpDialect('agy_acp_server.par', { KINGU_ANTIGRAVITY_AUTH_METHOD: 'oauth-business' }).signIn).toEqual({ via: 'browser', method: 'oauth-personal' });
		expect(acpDialect('agy', { KINGU_ANTIGRAVITY_AUTH_METHOD: 'gemini-api-key' }).signIn?.via).toBe('terminal');
		expect(acpDialect('qwen').signIn).toEqual({ via: 'terminal', login: ['qwen'] });
		// Cursor (Orca `agentSessionSetupFor('cursor').loginCommand`), Kingu's managed copy too.
		expect(acpDialect('/data/agent-runtimes/cursor/2026.11.22/dist-package/cursor-agent').signIn).toEqual({ via: 'terminal', login: ['cursor-agent', 'login'] });
		expect(acpDialect('cursor-agent.cmd').label).toBe('Cursor');
	});

	test("the server's rejected-key reply fails the turn instead of answering it", async () => {
		const r = setup('agy_acp_server.par');
		await r.start({});
		await r.event('result');
		await r.call('send', { runId: 1, text: 'notice API key not valid. Please pass a valid API key.' });
		const failed = await r.next((o) => o.method === 'event' && o.params.event.kind === 'result' && o.params.event.is_error === true);
		expect(JSON.stringify(failed.params.event)).toContain('API key not valid');
		expect(r.events().some((e) => e.kind === 'delta' && JSON.stringify(e).includes('API key not valid'))).toBe(false);
	});

	test('a run that is not waiting refuses Sign in', async () => {
		const r = setup('agy_acp_server.par');
		await r.start({});
		await r.event('result');
		expect((await r.call('sign_in', { runId: 1 })).error?.message).toContain('not waiting');
	});
});

describe('Cursor signs in from a terminal', () => {
	test("signed out, the card offers `cursor-agent login`; I've signed in opens the session again", async () => {
		const r = setup('cursor-agent');
		const login = join(r.cwd, 'logged-in');
		await r.start({ FAKE_ACP_AUTH: `file:${login}` });
		const required = await r.signIn('required');
		expect(required).toEqual({ kind: 'sign_in', state: 'required', via: 'terminal', agent: 'Cursor', login: ['cursor-agent', 'login'] });
		expect(r.events().some((e) => e.kind === 'error' || e.kind === 'exit')).toBe(false);
		writeFileSync(login, 'ok');
		await r.call('sign_in', { runId: 1 });
		await r.signIn('signed_in');
		expect((await r.event('result')).is_error).toBe(false);
	});
});

describe("the host's agy signs in from a terminal", () => {
	test('the card names the login; Sign in asks again, and the chat goes on once agy is signed in', async () => {
		const r = setup('agy');
		const login = join(r.cwd, 'logged-in');
		await r.start({ FAKE_ACP_AUTH: `file:${login}` });
		const required = await r.signIn('required');
		expect(required).toEqual({ kind: 'sign_in', state: 'required', via: 'terminal', agent: 'Antigravity', login: ['env', 'AGY_CLI_DISABLE_AUTO_UPDATE=true', 'agy'] });
		// Not signed in yet: asked again, and told so.
		await r.call('sign_in', { runId: 1 });
		const again = await r.signIn('required', r.out.indexOf(r.out.find((o) => o.params?.event?.state === 'verifying')!));
		expect(again.error).toContain('still not signed in');
		writeFileSync(login, 'ok');
		await r.call('sign_in', { runId: 1 });
		await r.signIn('signed_in');
		expect((await r.event('result')).is_error).toBe(false);
	});

	test('an agent without a sign-in of its own still fails with "sign in in a terminal first"', async () => {
		const r = setup('gemini');
		await r.start({ FAKE_ACP_AUTH: '1' });
		const error = await r.event('error');
		// One language (the chat shows it in the UI's), then the agent's own words.
		expect(error.message).toMatch(/^Sign in to gemini in a terminal first\. \S/);
		expect(error.message).not.toMatch(/[\u0E00-\u0E7F]/);
		expect(r.events().some((e) => e.kind === 'sign_in')).toBe(false);
	});
});
