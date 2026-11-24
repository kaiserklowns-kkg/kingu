// The sandbox's domain lists (src/sandbox/domains.ts), its filtering proxy (proxy.ts), its read
// confinement (reads.ts, profile.ts) and, on macOS, all of them under the real `sandbox-exec`.
// Every server here is local: fake names resolve to 127.0.0.1 through the proxy's test hooks.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from '../src/arkai/tools.ts';
import { claudeSandbox, sandboxConfig, SandboxConfigError, type SandboxConfig } from '../src/sandbox/config.ts';
import { hostAllowed, needsProxy, normalizeDomainPattern, requestHost } from '../src/sandbox/domains.ts';
import { macosProfile, policy, SANDBOX_EXEC, withGrants } from '../src/sandbox/profile.ts';
import { DomainProxy, isLocalAddress, upstreamFrom } from '../src/sandbox/proxy.ts';
import { commandGrants, commandKeywords, pathDirsInHome } from '../src/sandbox/reads.ts';
import { classifyDenial, failureNote, RunSandbox, sandboxLines } from '../src/sandbox/run.ts';

const ON: SandboxConfig = { allowNetwork: true, allowLocalNetwork: false, allowUnsandboxedCommands: true, readwritePaths: [], readonlyPaths: [], deniedPaths: [], maskedEnv: [], allowedDomains: [], deniedDomains: [] };
const same = (p: string) => p;

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (name: string) => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), `kingu-${name}-`)));
	dirs.push(d);
	return d;
};

const canSandbox = (() => {
	if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) return false;
	return Bun.spawnSync([SANDBOX_EXEC, '-p', '(version 1)\n(allow default)\n', '--', '/usr/bin/true']).exitCode === 0;
})();
const real = canSandbox && existsSync('/usr/bin/curl') ? test : test.skip;

/** A local HTTP server answering `pong <Host header>`, and recording each request head. */
function httpServer(): Promise<{ port: number; heads: string[]; server: Server }> {
	const heads: string[] = [];
	const server = createServer((sock) => {
		let buf = '';
		sock.on('data', (d) => {
			buf += d.toString('latin1');
			const end = buf.indexOf('\r\n\r\n');
			if (end < 0) return;
			const head = buf.slice(0, end);
			heads.push(head);
			const host = /^host:\s*(.*)$/im.exec(head)?.[1] ?? '';
			const body = `pong ${host}`;
			sock.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
		});
		sock.on('error', () => {});
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, heads, server })));
}

/** Sends `text` to 127.0.0.1:`port` and returns everything until the other side closes. */
function exchange(port: number, text: string | ((sock: ReturnType<typeof connect>, got: string) => void)): Promise<string> {
	return new Promise((resolve) => {
		const sock = connect({ host: '127.0.0.1', port });
		let out = '';
		sock.on('connect', () => (typeof text === 'string' ? sock.write(text) : text(sock, '')));
		sock.on('data', (d) => {
			out += d.toString('latin1');
			if (typeof text !== 'string') text(sock, out);
		});
		sock.on('close', () => resolve(out));
		sock.on('error', () => resolve(out));
	});
}

describe('domain patterns (VS Code domainMatcher.ts)', () => {
	test('normalized like VS Code', () => {
		expect(normalizeDomainPattern('GitHub.com')).toBe('github.com');
		expect(normalizeDomainPattern('*.Example.COM')).toBe('*.example.com');
		expect(normalizeDomainPattern('*')).toBe('*');
		expect(normalizeDomainPattern('https://registry.npmjs.org/some/path')).toBe('registry.npmjs.org');
		expect(normalizeDomainPattern('example.com:8443')).toBe('example.com');
		expect(normalizeDomainPattern('example.com.')).toBe('example.com');
		expect(normalizeDomainPattern('10.0.0.1')).toBe('10.0.0.1');
		expect(normalizeDomainPattern('::1')).toBe('[::1]');
		expect(normalizeDomainPattern('internal.corp')).toBe('internal.corp');
		for (const bad of ['', 'exa mple.com', 'a/b', '$(evil)', 'user@', '-x.com', '*.*.com']) expect([bad, normalizeDomainPattern(bad)]).toEqual([bad, undefined]);
	});

	test('a request host in the same form', () => {
		expect(requestHost('API.GitHub.com')).toBe('api.github.com');
		expect(requestHost('[::1]')).toBe('[::1]');
		expect(requestHost('127.0.0.1')).toBe('127.0.0.1');
		expect(requestHost('a b')).toBeUndefined();
	});

	test('denied wins; an allow list is the only way out; otherwise the network setting', () => {
		const lists = { allowed: ['*.github.com', 'registry.npmjs.org'], denied: ['gist.github.com'] };
		for (const open of [true, false]) {
			const r = { open, ...lists };
			expect([hostAllowed('github.com', r), hostAllowed('api.github.com', r), hostAllowed('registry.npmjs.org', r)]).toEqual([true, true, true]);
			expect([hostAllowed('gist.github.com', r), hostAllowed('evil.com', r), hostAllowed('github.com.evil.com', r)]).toEqual([false, false, false]);
		}
		expect(hostAllowed('evil.com', { open: true, allowed: [], denied: ['gist.github.com'] })).toBe(true);
		expect(hostAllowed('gist.github.com', { open: true, allowed: [], denied: ['gist.github.com'] })).toBe(false);
		expect(hostAllowed('evil.com', { open: false, allowed: [], denied: [] })).toBe(false);
		expect(hostAllowed('[::ffff:7f00:1]', { open: false, allowed: ['127.0.0.1'], denied: [] })).toBe(true);
		// Only when a list changes something does the run need the proxy.
		expect([needsProxy({ open: true, allowed: [], denied: [] }), needsProxy({ open: false, allowed: [], denied: ['x.com'] }), needsProxy({ open: false, allowed: ['x.com'], denied: [] }), needsProxy({ open: true, allowed: [], denied: ['x.com'] })]).toEqual([false, false, true, true]);
	});
});

describe('the domain settings', () => {
	test('read, normalized, and a pattern that is not one refuses the run', () => {
		const c = sandboxConfig({ enabled: 'on', allowedNetworkDomains: ['GitHub.com', '*.npmjs.org', 'github.com'], deniedNetworkDomains: ['https://gist.github.com/'] })!;
		expect([c.allowedDomains, c.deniedDomains]).toEqual([['github.com', '*.npmjs.org'], ['gist.github.com']]);
		expect(sandboxConfig({ enabled: 'on', allowedNetworkDomains: null })!.allowedDomains).toEqual([]);
		for (const bad of [{ allowedNetworkDomains: 'github.com' }, { allowedNetworkDomains: ['github.com', 3] }, { deniedNetworkDomains: ['$(curl evil)'] }, { allowedNetworkDomains: Array(501).fill('a.com') }])
			expect(() => sandboxConfig({ enabled: 'on', ...bad })).toThrow(SandboxConfigError);
		expect(() => sandboxConfig({ enabled: 'on', deniedNetworkDomains: ['not a domain'] })).toThrow(/chat\.agent\.sandbox\.network\.deniedDomains: "not a domain" is not a domain pattern/);
	});

	test("the Claude SDK's network option gets the same lists", () => {
		const allowed = ['github.com', '*.npmjs.org'];
		expect(claudeSandbox({ ...ON, allowedDomains: allowed, deniedDomains: ['gist.github.com'] }).network).toEqual({ allowedDomains: allowed, deniedDomains: ['gist.github.com'], strictAllowlist: true, allowLocalBinding: true });
		expect(claudeSandbox({ ...ON, deniedDomains: ['gist.github.com'] }).network).toEqual({ allowedDomains: ['*'], deniedDomains: ['gist.github.com'], allowLocalBinding: true });
		expect(claudeSandbox({ ...ON, allowNetwork: false, allowedDomains: allowed }).network).toEqual({ allowedDomains: allowed, strictAllowlist: true });
		expect(claudeSandbox({ ...ON, allowNetwork: false }).network).toEqual({ allowedDomains: [], strictAllowlist: true });
	});

	test('what the model is told', () => {
		const lines = sandboxLines({ ...ON, allowNetwork: false, allowedDomains: ['github.com'], deniedDomains: ['gist.github.com'] });
		expect(lines).toContain("limited to these domains, through the sandbox's proxy: github.com; except gist.github.com.");
		expect(lines).toContain('git over ssh GIT_SSH_COMMAND; for ssh itself run `eval "$GIT_SSH_COMMAND" user@host`');
		expect(classifyDenial('nc: connection failed, SOCKS error 2\nConnection closed by UNKNOWN port 65535')).toBe('network');
		expect(sandboxLines({ ...ON, deniedDomains: ['x.com'] })).toContain('except these domains: x.com.');
		const note = failureNote({ ...ON, allowedDomains: ['github.com'] }, 'curl: (56) CONNECT tunnel failed, response 403');
		expect(note).toContain('only reaches the domains chat.agent.sandbox.network.allowedDomains allows');
		expect(classifyDenial('Kingu sandbox: network access blocked: evil.com is not allowed')).toBe('network');
	});
});

describe('reads in the home folder (VS Code terminalSandboxReadAllowList.ts)', () => {
	test("a command line's programs: past VAR=value and env, every part of a pipeline", () => {
		expect(commandKeywords('FOO=1 git status && /usr/local/bin/NPM test | tee out; env -u X BAR=2 cargo build')).toEqual(['git', 'npm', 'tee', 'cargo']);
		expect(commandKeywords('env -- python3 -c "print(1)"')).toEqual(['python3']);
		expect(commandKeywords('')).toEqual([]);
	});

	test('the folders each needs; key material only for git, ssh and gpg', () => {
		const git = commandGrants('git push');
		expect(git.read).toContain('~/.gitconfig');
		expect(git.read).toContain('~/.ssh');
		expect(git.read).toContain('~/.gnupg');
		expect(git.write).toEqual(['~/.gnupg']);
		const npm = commandGrants('npm install');
		expect(npm.read).toContain('~/.npm');
		expect(npm.read).not.toContain('~/.ssh');
		expect(npm.write).toEqual(['~/.volta']);
		expect(commandGrants('cat README.md')).toEqual({ read: [], write: [] });
		// Next to docker, git's gpg write (VS Code also opens all unix sockets there) is not given.
		expect(commandGrants('docker run x && git log').write).toEqual([]);
	});

	test('PATH folders inside home, never home itself', () => {
		expect(pathDirsInHome('/Users/me/.cargo/bin:/usr/bin:/Users/me:/Users/me/../x:/Users/meow/bin:/Users/me/.local/bin', '/Users/me')).toEqual(['/Users/me/.cargo/bin', '/Users/me/.local/bin']);
		expect(pathDirsInHome(undefined, '/Users/me')).toEqual([]);
	});

	test("the profile: home unreadable but for the run's folders and the command's grants; denied paths still win", () => {
		const base = policy({ ...ON, readonlyPaths: ['~/docs'], deniedPaths: ['~/.ssh'] }, { cwd: '/Users/me/repo', home: '/Users/me', tmp: '/t/x' }, same);
		const p = withGrants(base, commandGrants('git fetch'), '/Users/me', same);
		const s = macosProfile(p);
		expect(s).toContain('(deny file-read* (subpath "/Users/me"))\n(allow file-read-metadata (require-all (subpath "/Users/me") (vnode-type DIRECTORY)))\n(allow file-read* (subpath "/Users/me/repo") (subpath "/t/x") (subpath "/Users/me/docs") (subpath "/Users/me/.gitconfig")');
		expect(s).toContain('(subpath "/Users/me/.ssh")');
		expect(s.trimEnd().endsWith('(deny file-read* file-write* (subpath "/Users/me/.ssh"))')).toBe(true);
		// Home as the working folder: nothing in it is confined (it is all readable).
		expect(macosProfile(policy(ON, { cwd: '/Users/me', home: '/Users/me', tmp: '/t/x' }, same))).toContain('(allow file-read* (subpath "/Users/me")');
	});

	test('a granted dotfile that is a symlink: both the link and its target', () => {
		const home = temp('sbx-home');
		mkdirSync(join(home, 'dotfiles'));
		writeFileSync(join(home, 'dotfiles/gitconfig'), '[user]\n');
		symlinkSync(join(home, 'dotfiles/gitconfig'), join(home, '.gitconfig'));
		const p = withGrants(policy(ON, { cwd: join(home, 'repo'), home, tmp: '/t/x' }), { read: ['~/.gitconfig'], write: [] }, home);
		expect(p.readable).toContain(join(home, '.gitconfig'));
		expect(p.readable).toContain(join(home, 'dotfiles/gitconfig'));
	});

	test('the proxy port is the only network rule when a list applies', () => {
		const c = { ...ON, allowNetwork: false, allowedDomains: ['github.com'] };
		const s = macosProfile(policy(c, { cwd: '/w', home: '/h', tmp: '/t', proxyPort: 4321 }, same));
		expect(s).toContain('(deny network*)');
		expect(s).toContain('(allow network-outbound (remote ip "localhost:4321"))');
		expect(s).not.toContain('localhost:*');
		// Open network with a denied list: no longer open, the proxy decides.
		expect(policy({ ...ON, deniedDomains: ['x.com'] }, { cwd: '/w', home: '/h', tmp: '/t', proxyPort: 9 }, same)).toMatchObject({ network: false, proxyPort: 9 });
		// Not started: no way out at all (fails closed).
		expect(macosProfile(policy(c, { cwd: '/w', home: '/h', tmp: '/t' }, same))).not.toContain('remote ip');
	});
});

describe('the filtering proxy', () => {
	const fake = { resolve: async () => ['127.0.0.1'], isLocal: () => false };

	test('addresses on this machine or the local network', () => {
		for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) expect([ip, isLocalAddress(ip)]).toEqual([ip, true]);
		for (const ip of ['1.1.1.1', '140.82.112.3', '172.32.0.1', '2606:4700::1111']) expect([ip, isLocalAddress(ip)]).toEqual([ip, false]);
	});

	test('the upstream proxy from the environment: http only, with its credentials and bypass list', () => {
		expect(upstreamFrom({ HTTPS_PROXY: 'http://u:p%40ss@proxy.corp:3128', NO_PROXY: 'localhost, .corp.example' })).toEqual({ host: 'proxy.corp', port: 3128, auth: `Basic ${Buffer.from('u:p@ss').toString('base64')}`, noProxy: ['localhost', '.corp.example'] });
		expect(upstreamFrom({ https_proxy: 'socks5://p:1080' })).toBeNull();
		expect(upstreamFrom({})).toBeNull();
	});

	test('allowed hosts pass, plain HTTP and CONNECT; others get a 403 naming the host; nothing reaches the server for them', async () => {
		const srv = await httpServer();
		const proxy = await DomainProxy.start({ rules: { open: false, allowed: ['allowed.example'], denied: [] }, localNetwork: false, ...fake });
		cleanups.push(() => (proxy.close(), srv.server.close()));
		const plain = await exchange(proxy.port, `GET http://allowed.example:${srv.port}/x?y=1 HTTP/1.1\r\nHost: allowed.example:${srv.port}\r\nProxy-Authorization: Basic c2VjcmV0\r\nProxy-Connection: keep-alive\r\n\r\n`);
		expect(plain).toContain(`pong allowed.example:${srv.port}`);
		// Forwarded in origin form, without the proxy's own headers.
		expect(srv.heads[0]!.split('\r\n')[0]).toBe('GET /x?y=1 HTTP/1.1');
		expect(srv.heads[0]).not.toMatch(/proxy-/i);
		expect(srv.heads[0]).toContain('Connection: close');

		const tunnel = await exchange(proxy.port, (sock, got) => {
			if (got === '') sock.write(`CONNECT allowed.example:${srv.port} HTTP/1.1\r\nHost: allowed.example:${srv.port}\r\n\r\n`);
			else if (got === 'HTTP/1.1 200 Connection Established\r\n\r\n') sock.write(`GET / HTTP/1.1\r\nHost: through-tunnel\r\n\r\n`);
		});
		expect(tunnel).toContain('pong through-tunnel');

		const before = srv.heads.length;
		const denied = await exchange(proxy.port, `CONNECT evil.example:${srv.port} HTTP/1.1\r\n\r\n`);
		expect(denied.startsWith('HTTP/1.1 403 Forbidden')).toBe(true);
		expect(denied).toContain('network access blocked: evil.example is not allowed by chat.agent.sandbox.network.allowedDomains');
		const literal = await exchange(proxy.port, `GET http://127.0.0.1:${srv.port}/ HTTP/1.1\r\n\r\n`);
		expect(literal.startsWith('HTTP/1.1 403')).toBe(true);
		expect(await exchange(proxy.port, 'GET / HTTP/1.1\r\n\r\n')).toContain('400 Bad Request');
		expect(await exchange(proxy.port, `GET https://allowed.example:${srv.port}/ HTTP/1.1\r\n\r\n`)).toContain('400 Bad Request');
		expect(srv.heads.length).toBe(before);
	});

	test('an allowed name that resolves to this machine is refused unless allowLocalNetwork', async () => {
		const srv = await httpServer();
		const rules = { open: false, allowed: ['sneaky.example'], denied: [] };
		const strict = await DomainProxy.start({ rules, localNetwork: false, resolve: fake.resolve });
		const local = await DomainProxy.start({ rules, localNetwork: true, resolve: fake.resolve });
		cleanups.push(() => (strict.close(), local.close(), srv.server.close()));
		const req = `GET http://sneaky.example:${srv.port}/ HTTP/1.1\r\nHost: sneaky.example\r\n\r\n`;
		const refused = await exchange(strict.port, req);
		expect(refused.startsWith('HTTP/1.1 403')).toBe(true);
		expect(refused).toContain('chat.agent.sandbox.network.allowLocalNetwork is off');
		expect(await exchange(local.port, req)).toContain('pong sneaky.example');
		expect(srv.heads.length).toBe(1);
	});

	test("an upstream proxy gets the tunnel with its own credentials, not the client's", async () => {
		const heads: string[] = [];
		const up = createServer((sock) => {
			sock.once('data', (d) => {
				heads.push(d.toString('latin1'));
				sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				sock.on('data', () => sock.end('HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nupstream'));
			});
			sock.on('error', () => {});
		});
		await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
		const upPort = (up.address() as { port: number }).port;
		const proxy = await DomainProxy.start({ rules: { open: true, allowed: [], denied: ['evil.example'] }, localNetwork: false, upstream: upstreamFrom({ HTTPS_PROXY: `http://corp:pw@127.0.0.1:${upPort}` }) });
		cleanups.push(() => (proxy.close(), up.close()));
		const out = await exchange(proxy.port, (sock, got) => {
			if (got === '') sock.write('CONNECT api.example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic Y2xpZW50\r\n\r\n');
			else if (got === 'HTTP/1.1 200 Connection Established\r\n\r\n') sock.write('hello');
		});
		expect(out).toContain('upstream');
		expect(heads[0]).toContain('CONNECT api.example.com:443 HTTP/1.1');
		expect(heads[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from('corp:pw').toString('base64')}`);
		expect(heads[0]).not.toContain('Y2xpZW50');
		expect(await exchange(proxy.port, 'CONNECT evil.example:443 HTTP/1.1\r\n\r\n')).toContain('403');
		expect(heads.length).toBe(1);
	});
});

describe('the filtering proxy over SOCKS5 (the sandbox runtime\'s socks-proxy.js)', () => {
	const fake = { resolve: async () => ['127.0.0.1'], isLocal: () => false };

	/** A SOCKS5 CONNECT for `host` (a name, or an IPv4 literal as 4 bytes) on `port`, then `payload` once granted. */
	function socks(proxyPort: number, host: string | number[], port: number, payload = 'ping', cmd = 1): Promise<{ reply: number[]; rest: string }> {
		return new Promise((resolve) => {
			const sock = connect({ host: '127.0.0.1', port: proxyPort });
			let buf = Buffer.alloc(0);
			let step = 0;
			sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
			sock.on('data', (d: Buffer) => {
				buf = Buffer.concat([buf, d]);
				if (step === 0 && buf.length >= 2) {
					step = 1;
					buf = buf.subarray(2);
					const addr = typeof host === 'string' ? [3, host.length, ...Buffer.from(host, 'latin1')] : [1, ...host];
					sock.write(Buffer.from([5, cmd, 0, ...addr, port >> 8, port & 0xff]));
				}
				if (step === 1 && buf.length >= 10) {
					step = 2;
					if (buf[1] === 0) sock.write(payload);
				}
			});
			const done = () => resolve({ reply: [...buf.subarray(0, 2)], rest: buf.subarray(10).toString('latin1') });
			sock.on('close', done);
			sock.on('error', done);
		});
	}

	test('an allowed name is tunnelled to any port; a denied, unlisted or literal one gets "not allowed by ruleset" and nothing reaches the server', async () => {
		const seen: string[] = [];
		const echo = createServer((s) => {
			s.on('data', (d) => (seen.push(d.toString()), s.end(`echo ${d}`)));
			s.on('error', () => {});
		});
		await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
		const port = (echo.address() as { port: number }).port;
		const proxy = await DomainProxy.start({ rules: { open: false, allowed: ['*.example.org'], denied: ['gist.example.org'] }, localNetwork: false, ...fake });
		cleanups.push(() => (proxy.close(), echo.close()));
		expect(await socks(proxy.port, 'git.example.org', port)).toEqual({ reply: [5, 0], rest: 'echo ping' });
		expect(await socks(proxy.port, 'gist.example.org', port)).toEqual({ reply: [5, 2], rest: '' });
		expect(await socks(proxy.port, 'evil.example', port)).toEqual({ reply: [5, 2], rest: '' });
		expect(await socks(proxy.port, [127, 0, 0, 1], port)).toEqual({ reply: [5, 2], rest: '' });
		// A name with control characters never reaches the matcher; BIND / UDP are not offered.
		expect((await socks(proxy.port, 'gist.example.org\0.git.example.org', port)).reply).toEqual([5, 1]);
		expect((await socks(proxy.port, 'git.example.org', port, 'x', 2)).reply).toEqual([5, 7]);
		expect(seen).toEqual(['ping']);
		// HTTP on the same port still works.
		expect(await exchange(proxy.port, `CONNECT evil.example:${port} HTTP/1.1\r\n\r\n`)).toContain('403');
	});

	test('an allowed name on this machine is refused unless allowLocalNetwork', async () => {
		const proxy = await DomainProxy.start({ rules: { open: false, allowed: ['sneaky.example'], denied: [] }, localNetwork: false, resolve: fake.resolve });
		cleanups.push(() => proxy.close());
		expect((await socks(proxy.port, 'sneaky.example', 22)).reply).toEqual([5, 2]);
	});

	test('the variables: HTTP proxy, SOCKS ALL_PROXY, and git\'s ssh through it per platform', async () => {
		const proxy = await DomainProxy.start({ rules: { open: false, allowed: ['x.com'], denied: [] }, localNetwork: false });
		cleanups.push(() => proxy.close());
		const at = `127.0.0.1:${proxy.port}`;
		expect(proxy.env(false, 'darwin')).toMatchObject({ HTTPS_PROXY: `http://${at}`, ALL_PROXY: `socks5h://${at}`, all_proxy: `socks5h://${at}`, RSYNC_PROXY: at, GIT_SSH_COMMAND: `ssh -o ProxyCommand='/usr/bin/nc -X 5 -x ${at} %h %p'` });
		expect(proxy.env(false, 'linux').GIT_SSH_COMMAND).toBe(`ssh -o ProxyCommand='socat - PROXY:127.0.0.1:%h:%p,proxyport=${proxy.port}'`);
		expect(proxy.env(false, 'win32').GIT_SSH_COMMAND).toBeUndefined();
	});
});

describe('real sandbox-exec: domains and reads', () => {
	const signal = new AbortController().signal;

	real('only the allowed domain, only through the proxy; a direct connection is stopped by Seatbelt', async () => {
		const srv = await httpServer();
		cleanups.push(() => srv.server.close());
		const cwd = temp('sbx-net');
		const run = new RunSandbox({ ...ON, allowNetwork: false, allowedDomains: ['allowed.example'] }, cwd, { proxy: { resolve: async () => ['127.0.0.1'], isLocal: () => false } });
		cleanups.push(() => run.dispose());
		const bash = (command: string) => runTool('Bash', { command }, { cwd, env: { ...process.env, HTTPS_PROXY: undefined, HTTP_PROXY: undefined, https_proxy: undefined, http_proxy: undefined, ALL_PROXY: undefined, all_proxy: undefined }, signal, sandbox: { run, unsandboxed: false } });
		const curl = `/usr/bin/curl -sS --max-time 5`;
		expect((await bash(`${curl} http://allowed.example:${srv.port}/`)).content).toBe(`pong allowed.example:${srv.port}`);
		// CONNECT, as HTTPS goes.
		expect((await bash(`${curl} -p http://allowed.example:${srv.port}/`)).content).toBe('pong allowed.example:' + srv.port);
		const denied = await bash(`${curl} -p http://evil.example:${srv.port}/`);
		expect(denied.isError).toBe(true);
		expect(denied.content).toMatch(/CONNECT tunnel failed, response 403|Received HTTP code 403/);
		expect(denied.content).toContain('only reaches the domains chat.agent.sandbox.network.allowedDomains allows');
		const plainDenied = await bash(`${curl} http://evil.example:${srv.port}/`);
		expect(plainDenied.content).toContain('network access blocked: evil.example');
		// Around the proxy: Seatbelt stops it.
		const direct = await bash(`${curl} --noproxy '*' http://127.0.0.1:${srv.port}/`);
		expect(direct.isError).toBe(true);
		expect(direct.content).not.toContain('pong');
		expect(srv.heads.length).toBe(2);
	});

	real('git over ssh reaches an allowed host through the proxy; a denied one is refused before any byte is sent', async () => {
		const banners: string[] = [];
		const sshd = createServer((s) => {
			s.write('SSH-2.0-OpenSSH_fake\r\n');
			s.on('data', (d) => (banners.push(d.toString('latin1').split('\r\n')[0]!), s.end()));
			s.on('error', () => {});
		});
		await new Promise<void>((r) => sshd.listen(0, '127.0.0.1', () => r()));
		const port = (sshd.address() as { port: number }).port;
		const cwd = temp('sbx-ssh');
		const run = new RunSandbox({ ...ON, allowNetwork: false, allowedDomains: ['git.example'] }, cwd, { proxy: { resolve: async () => ['127.0.0.1'], isLocal: () => false } });
		cleanups.push(() => (run.dispose(), sshd.close()));
		const bash = (command: string) => runTool('Bash', { command }, { cwd, env: { ...process.env, GIT_SSH_COMMAND: undefined }, signal, sandbox: { run, unsandboxed: false } });
		const opts = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=5';
		const lsRemote = (host: string) => bash(`GIT_SSH_COMMAND="$GIT_SSH_COMMAND ${opts}" git ls-remote ssh://git@${host}:${port}/x.git`);
		// The fake server ends the session after the client's banner: the connection was made.
		await lsRemote('git.example');
		expect(banners.length).toBe(1);
		expect(banners[0]).toStartWith('SSH-2.0-');
		const denied = await lsRemote('evil.example');
		expect(denied.isError).toBe(true);
		expect(denied.content).toContain('SOCKS error 2');
		expect(denied.content).toContain('only reaches the domains chat.agent.sandbox.network.allowedDomains allows');
		// ssh itself, the way the model is told to run it.
		await bash(`eval "$GIT_SSH_COMMAND" ${opts} -p ${port} git@git.example true`);
		expect(banners.length).toBe(2);
		// Without the proxy command, ssh cannot even resolve the name.
		expect((await bash(`ssh ${opts} -p ${port} git@git.example true`)).content).toContain('Could not resolve hostname');
		expect(banners.length).toBe(2);
	});

	real('the home folder is unreadable except the working folder and what the command needs', async () => {
		const home = temp('sbx-fakehome');
		const cwd = join(home, 'repo');
		mkdirSync(cwd);
		writeFileSync(join(cwd, 'in.txt'), 'inside\n');
		writeFileSync(join(home, 'secret.txt'), 'secret\n');
		writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Sandbox Test\n');
		mkdirSync(join(home, 'bin'));
		writeFileSync(join(home, 'bin/hello'), '#!/bin/sh\necho hello\n', { mode: 0o755 });
		const run = new RunSandbox(ON, cwd, { home });
		cleanups.push(() => run.dispose());
		const bash = (command: string, path = process.env.PATH) => runTool('Bash', { command }, { cwd, env: { ...process.env, HOME: home, PATH: path }, signal, sandbox: { run, unsandboxed: false } });
		expect((await bash('cat in.txt')).content).toBe('inside');
		const secret = await bash(`cat ${JSON.stringify(join(home, 'secret.txt'))}`);
		expect([secret.isError, secret.content.includes('secret\n')]).toEqual([true, false]);
		expect(secret.content).toContain('Operation not permitted');
		expect((await bash(`ls ${JSON.stringify(home)}`)).isError).toBe(true);
		// git's config is readable for a git command, not for cat alone.
		expect((await bash(`cat ${JSON.stringify(join(home, '.gitconfig'))}`)).isError).toBe(true);
		expect((await bash(`git config --global user.name`)).content).toBe('Sandbox Test');
		// A program in a PATH folder inside home still starts.
		expect((await bash('hello', `${join(home, 'bin')}:${process.env.PATH}`)).content).toBe('hello');
		// Reads outside home are open.
		expect((await bash('head -c 1 /etc/hosts | wc -c')).content.trim()).toBe('1');
	});
});
