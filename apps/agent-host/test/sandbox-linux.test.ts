// The Linux backend of the agent sandbox (src/sandbox/linux.ts): which machines can sandbox, the
// bubblewrap mounts a policy becomes, the argv with and without the proxy bridge, the bridge
// itself, and RunSandbox on Linux (with bwrap's probe and the file system faked: this runs on
// macOS, where bwrap itself cannot run).

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxConfig } from '../src/sandbox/config.ts';
import { findSystemExecutable, linuxArgv, linuxMounts, ProxyBridge, removeMountPoints, RESOLVER_SOCKETS, shellQuote, wslVersion, type FsView } from '../src/sandbox/linux.ts';
import { policy, sandboxBackend, type Policy } from '../src/sandbox/profile.ts';
import { commandGrants } from '../src/sandbox/reads.ts';
import { applyFailed, RunSandbox, SandboxUnavailable } from '../src/sandbox/run.ts';

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

const ON: SandboxConfig = { allowNetwork: true, allowLocalNetwork: false, allowUnsandboxedCommands: true, readwritePaths: [], readonlyPaths: [], deniedPaths: [], maskedEnv: [], allowedDomains: [], deniedDomains: [] };
const same = (p: string) => p;

/** A file system of these folders and files (their parents exist as folders). */
function fakeFs(dirsIn: string[], files: string[] = []): FsView {
	const kinds = new Map<string, 'dir' | 'file'>([['/', 'dir']]);
	const addParents = (p: string) => {
		let cur = '';
		for (const part of p.split('/').filter(Boolean).slice(0, -1)) {
			cur += `/${part}`;
			kinds.set(cur, 'dir');
		}
	};
	for (const d of dirsIn) {
		addParents(d);
		kinds.set(d, 'dir');
	}
	for (const f of files) {
		addParents(f);
		kinds.set(f, 'file');
	}
	return { kind: (p) => kinds.get(p) ?? null };
}

/** The index of `seq` (consecutive items) in `xs`, or -1. */
function indexOfSeq(xs: string[], seq: string[]): number {
	for (let i = 0; i + seq.length <= xs.length; i++) if (seq.every((s, j) => xs[i + j] === s)) return i;
	return -1;
}

describe('which machines sandbox', () => {
	test('Linux finds bwrap in system folders only, never through PATH', () => {
		expect(findSystemExecutable('bwrap', (p) => p === '/usr/local/bin/bwrap')).toBe('/usr/local/bin/bwrap');
		expect(findSystemExecutable('bwrap', (p) => p === '/home/me/.local/bin/bwrap')).toBeNull();
		expect(sandboxBackend('linux', (p) => p === '/usr/bin/bwrap', () => 'Linux version 6.8.0')).toEqual({ kind: 'bwrap', bwrap: '/usr/bin/bwrap' });
	});

	test('a missing bwrap, WSL 1, Windows and other systems are refused with the reason', () => {
		const missing = sandboxBackend('linux', () => false, () => null);
		expect(missing.kind).toBe('none');
		expect(missing.kind === 'none' && missing.problem).toMatch(/^bubblewrap \(bwrap\) is not installed \(Debian\/Ubuntu: sudo apt install bubblewrap/);
		const wsl1 = sandboxBackend('linux', () => true, () => 'Linux version 4.4.0-19041-Microsoft');
		expect(wsl1.kind === 'none' && wsl1.problem).toContain('WSL 2');
		expect(sandboxBackend('linux', () => true, () => 'Linux version 5.15.167.4-microsoft-standard-WSL2').kind).toBe('bwrap');
		const win = sandboxBackend('win32', () => true);
		expect(win.kind === 'none' && win.problem).toBe('the sandbox is not supported on Windows (VS Code does not sandbox agent commands there either)');
		expect(sandboxBackend('freebsd', () => true).kind).toBe('none');
	});

	test('WSL versions from /proc/version', () => {
		expect(wslVersion(null)).toBeNull();
		expect(wslVersion('Linux version 6.8.0-45-generic (buildd@lcy02)')).toBeNull();
		expect(wslVersion('Linux version 4.4.0-19041-Microsoft')).toBe('1');
		expect(wslVersion('Linux version 5.15.90.1-microsoft-standard-WSL2')).toBe('2');
	});
});

describe('bubblewrap mounts', () => {
	const home = '/home/me';
	const cwd = '/home/me/repo';
	const at = { cwd, home, tmp: '/tmp/kingu-sandbox-1' };
	const fs = fakeFs([cwd, `${cwd}/.git/hooks`, '/tmp/kingu-sandbox-1', `${home}/.cargo/bin`, `${home}/secrets`, '/run/systemd/resolve'], [`${cwd}/.git/config`, `${cwd}/.env`]);

	test('read-only root, home hidden, readable folders back read-only, writable folders back writable', () => {
		const p: Policy = { ...policy(ON, at, same), readable: [...policy(ON, at, same).readable, `${home}/.cargo/bin`, `${cwd}/src`] };
		const { args } = linuxMounts(p, { cwd }, fs);
		expect(args.slice(0, 3)).toEqual(['--new-session', '--die-with-parent', '--unshare-pid']);
		// Open network (VS Code's default): no network namespace of its own.
		expect(args).not.toContain('--unshare-net');
		const root = indexOfSeq(args, ['--ro-bind', '/', '/']);
		const tmpfs = indexOfSeq(args, ['--tmpfs', home]);
		const cargo = indexOfSeq(args, ['--ro-bind-try', `${home}/.cargo/bin`, `${home}/.cargo/bin`]);
		const repo = indexOfSeq(args, ['--bind', cwd, cwd]);
		const tmp = indexOfSeq(args, ['--bind', '/tmp/kingu-sandbox-1', '/tmp/kingu-sandbox-1']);
		expect([root < tmpfs, tmpfs < cargo, tmpfs < repo, tmp > root]).toEqual([true, true, true, true]);
		// A readable folder inside a writable one is not bound read-only over it.
		expect(indexOfSeq(args, ['--ro-bind-try', `${cwd}/src`, `${cwd}/src`])).toBe(-1);
		// Git hooks and config: read-only over the writable folder, after it.
		expect(indexOfSeq(args, ['--ro-bind', `${cwd}/.git/hooks`, `${cwd}/.git/hooks`])).toBeGreaterThan(repo);
		expect(indexOfSeq(args, ['--ro-bind', `${cwd}/.git/config`, `${cwd}/.git/config`])).toBeGreaterThan(repo);
		expect(args.slice(-6)).toEqual(['--dev', '/dev', '--proc', '/proc', '--chdir', cwd]);
	});

	test('no network: its own namespace, and the resolver daemons hidden', () => {
		const { args } = linuxMounts(policy({ ...ON, allowNetwork: false }, at, same), { cwd }, fs);
		expect(args).toContain('--unshare-net');
		expect(indexOfSeq(args, ['--tmpfs', '/run/systemd/resolve', '--remount-ro', '/run/systemd/resolve'])).toBeGreaterThan(0);
		// Only the ones that exist.
		expect(args).not.toContain(RESOLVER_SOCKETS[1]);
		// Local network on Linux is the sandbox's own loopback: still no host network.
		expect(linuxMounts(policy({ ...ON, allowNetwork: false, allowLocalNetwork: true }, at, same), { cwd }, fs).args).toContain('--unshare-net');
	});

	test('denied: an empty read-only folder or /dev/null over it, applied last', () => {
		const p = policy({ ...ON, deniedPaths: ['.env', '~/secrets'], readonlyPaths: ['docs'] }, at, same);
		const { args, created } = linuxMounts(p, { cwd }, fs);
		const env = indexOfSeq(args, ['--ro-bind', '/dev/null', `${cwd}/.env`]);
		const secrets = indexOfSeq(args, ['--tmpfs', `${home}/secrets`, '--remount-ro', `${home}/secrets`]);
		expect(env).toBeGreaterThan(indexOfSeq(args, ['--bind', cwd, cwd]));
		expect(secrets).toBeGreaterThan(0);
		// A missing read-only path inside the working folder: blocked from being created, and remembered for cleanup.
		expect(indexOfSeq(args, ['--ro-bind', '/dev/null', `${cwd}/docs`])).toBeGreaterThan(0);
		expect(created).toEqual([`${cwd}/docs`]);
	});

	test('a missing path: its first missing part is blocked; not under a file, not a missing .git, not outside writable folders', () => {
		const p = policy({ ...ON, deniedPaths: ['build/out/key.pem', '.env/x', '/opt/nothere'] }, at, same);
		const { args, created } = linuxMounts(p, { cwd }, fs);
		expect(indexOfSeq(args, ['--tmpfs', `${cwd}/build`, '--remount-ro', `${cwd}/build`])).toBeGreaterThan(0);
		expect(created).toEqual([`${cwd}/build`]);
		expect(args.join(' ')).not.toContain('.env/x');
		expect(args.join(' ')).not.toContain('/opt/nothere');
		// Not a repository: `.git/hooks` and `.git/config` are not blocked, so `git init` works.
		const plain = linuxMounts(policy(ON, at, same), { cwd }, fakeFs([cwd, '/tmp/kingu-sandbox-1']));
		expect(plain.args.join(' ')).not.toContain('.git');
		expect(plain.created).toEqual([]);
	});

	test('a home folder that is the working folder is not hidden from itself', () => {
		const { args } = linuxMounts(policy(ON, { cwd: home, home, tmp: '/tmp/kingu-sandbox-1' }, same), { cwd: home }, fs);
		expect(indexOfSeq(args, ['--tmpfs', home])).toBeLessThan(indexOfSeq(args, ['--bind', home, home]));
	});
});

describe('bubblewrap argv', () => {
	const fs = fakeFs(['/w', '/t']);
	const at = { cwd: '/w', home: '/h', tmp: '/t' };

	test('the command after `--`, as its own arguments', () => {
		const { argv } = linuxArgv('/usr/bin/bwrap', policy(ON, at, same), ['/bin/bash', '-c', 'echo "a b"; rm -rf /'], { cwd: '/w' }, fs);
		expect(argv[0]).toBe('/usr/bin/bwrap');
		expect(argv.slice(argv.indexOf('--'))).toEqual(['--', '/bin/bash', '-c', 'echo "a b"; rm -rf /']);
	});

	test('a domain list: no network but the proxy, reached through socat on its port inside', () => {
		const p = policy({ ...ON, allowedDomains: ['example.com'] }, { ...at, proxyPort: 41234 }, same);
		expect([p.network, p.proxyPort]).toEqual([false, 41234]);
		const link = { socket: '/tmp/kingu-sbx-net-a/proxy.sock', port: 41234, socat: '/usr/bin/socat' };
		const { argv } = linuxArgv('/usr/bin/bwrap', p, ['/bin/bash', '-c', 'curl https://example.com'], { cwd: '/w', link }, fs);
		expect(argv).toContain('--unshare-net');
		expect(indexOfSeq(argv, ['--bind', link.socket, link.socket])).toBeGreaterThan(0);
		const tail = argv.slice(argv.indexOf('--'));
		expect(tail).toEqual([
			'--',
			'/bin/sh',
			'-c',
			`'/usr/bin/socat' TCP-LISTEN:41234,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/tmp/kingu-sbx-net-a/proxy.sock >/dev/null 2>&1 &\n"$@"`,
			'kingu-sandbox',
			'/bin/bash',
			'-c',
			'curl https://example.com'
		]);
		// Without the bridge: no network at all, never an open one.
		const bare = linuxArgv('/usr/bin/bwrap', p, ['/bin/sh', '-c', 'x'], { cwd: '/w', link: null }, fs).argv;
		expect(bare).toContain('--unshare-net');
		expect(bare.join(' ')).not.toContain('socat');
		// A socket path socat would misread is refused.
		expect(() => linuxArgv('/usr/bin/bwrap', p, ['sh'], { cwd: '/w', link: { ...link, socket: '/tmp/a,b:c.sock' } }, fs)).toThrow(/cannot be used/);
	});

	test('shell quoting and bwrap failures', () => {
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		expect(applyFailed(1, 'bwrap: No permissions to creating new namespace, likely because the kernel does not allow non-privileged user namespaces.')).toBe(true);
		expect(applyFailed(1, 'cat: x: bwrap: no')).toBe(false);
		expect(applyFailed(0, 'bwrap: x')).toBe(false);
	});

	test('the Linux read list of each tool (VS Code\'s per-OS entries)', () => {
		expect(commandGrants('npm ci', 'linux').read).toContain('~/.cache/node/corepack');
		expect(commandGrants('npm ci', 'linux').read.some((p) => p.includes('Library'))).toBe(false);
		expect(commandGrants('go build', 'linux').read).toContain('~/.cache/go-build');
		expect(commandGrants('pip install x', 'linux').read).toContain('~/.cache/pip');
		expect(commandGrants('cargo build', 'linux').read).toEqual(commandGrants('cargo build', 'darwin').read);
	});
});

describe('RunSandbox on Linux', () => {
	const env = { PATH: '/usr/bin:/bin', HOME: '/h', GH_TOKEN: 'ghp_0123456789abcdef' };
	const linuxDeps = (cwd: string, over: Partial<ConstructorParameters<typeof RunSandbox>[2]> = {}) => ({
		platform: 'linux',
		exists: () => true,
		procVersion: () => 'Linux version 6.8.0',
		probe: () => null,
		tmpRoot: join(cwd, '.tmp'),
		home: '/nonexistent-home',
		...over
	});

	test('a command runs under bwrap with the run\'s TMPDIR and without masked variables', () => {
		const cwd = temp('lsbx');
		const run = new RunSandbox({ ...ON, maskedEnv: ['GH_TOKEN'] }, cwd, linuxDeps(cwd));
		cleanups.push(() => run.dispose());
		const l = run.launch(['/bin/bash', '-c', 'echo hi'], env, false);
		expect([l.sandboxed, l.argv[0], 'GH_TOKEN' in l.env]).toEqual([true, '/usr/bin/bwrap', false]);
		expect(indexOfSeq(l.argv, ['--bind', l.env.TMPDIR!, l.env.TMPDIR!])).toBeGreaterThan(0);
		expect(indexOfSeq(l.argv, ['--bind', cwd, cwd])).toBeGreaterThan(0);
		expect(l.argv.slice(-3)).toEqual(['/bin/bash', '-c', 'echo hi']);
		l.done?.();
	});

	test('bwrap missing, or present but unable to sandbox: the command is refused, never run bare', () => {
		const cwd = temp('lsbx-missing');
		const missing = new RunSandbox(ON, cwd, linuxDeps(cwd, { exists: () => false }));
		expect(() => missing.launch(['/bin/sh', '-c', 'true'], env, false)).toThrow(/was not run.*bubblewrap \(bwrap\) is not installed/);
		let probes = 0;
		const broken = new RunSandbox(ON, cwd, linuxDeps(cwd, { probe: () => (probes++, 'bubblewrap (/usr/bin/bwrap) cannot create the sandbox\'s namespaces: setting up uid map: Permission denied') }));
		cleanups.push(() => broken.dispose());
		expect(() => broken.launch(['/bin/sh', '-c', 'true'], env, false)).toThrow(SandboxUnavailable);
		expect(() => broken.launch(['/bin/sh', '-c', 'true'], env, false)).toThrow(/uid map/);
		// Probed once per run.
		expect(probes).toBe(1);
		// Outside only with the user's approval.
		expect(broken.launch(['/bin/sh', '-c', 'true'], env, true).sandboxed).toBe(false);
	});

	test('mount points left for missing paths go once the last command is done', () => {
		const cwd = temp('lsbx-mp');
		const run = new RunSandbox({ ...ON, deniedPaths: ['.env'] }, cwd, linuxDeps(cwd));
		cleanups.push(() => run.dispose());
		const a = run.launch(['/bin/sh', '-c', 'true'], env, false);
		const b = run.launch(['/bin/sh', '-c', 'true'], env, false);
		expect(indexOfSeq(a.argv, ['--ro-bind', '/dev/null', join(cwd, '.env')])).toBeGreaterThan(0);
		// What bwrap would leave on the host.
		writeFileSync(join(cwd, '.env'), '');
		a.done?.();
		expect(existsSync(join(cwd, '.env'))).toBe(true);
		b.done?.();
		b.done?.();
		expect(existsSync(join(cwd, '.env'))).toBe(false);
		// One with content is not removed.
		writeFileSync(join(cwd, 'kept'), 'x');
		mkdirSync(join(cwd, 'full'));
		writeFileSync(join(cwd, 'full', 'f'), 'x');
		removeMountPoints([join(cwd, 'kept'), join(cwd, 'full')]);
		expect([existsSync(join(cwd, 'kept')), existsSync(join(cwd, 'full'))]).toEqual([true, true]);
	});

	test('a domain list without socat refuses to start the proxy', async () => {
		const cwd = temp('lsbx-nobridge');
		const run = new RunSandbox({ ...ON, allowedDomains: ['example.com'] }, cwd, linuxDeps(cwd, { exists: (p) => p.endsWith('/bwrap') }));
		cleanups.push(() => run.dispose());
		await expect(run.ready(env)).rejects.toThrow(/socat is not installed/);
		// The launch has no network at all then.
		const l = run.launch(['/bin/sh', '-c', 'true'], env, false);
		expect(l.argv).toContain('--unshare-net');
		expect(l.argv.join(' ')).not.toContain('TCP-LISTEN');
	});

	test('a domain list: the bridge carries the sandbox to the proxy', async () => {
		const cwd = temp('lsbx-bridge');
		const run = new RunSandbox({ ...ON, allowedDomains: ['example.com'] }, cwd, linuxDeps(cwd, { tmpRoot: '/tmp' }));
		cleanups.push(() => run.dispose());
		await run.ready(env);
		const l = run.launch(['/bin/sh', '-c', 'curl https://example.com'], env, false);
		const port = run.policy().proxyPort!;
		expect(l.env.HTTPS_PROXY).toBe(`http://127.0.0.1:${port}`);
		const bind = l.argv.indexOf('--bind');
		const socket = l.argv[bind + 1]!;
		expect(socket).toMatch(/kingu-sbx-net-.*\/proxy\.sock$/);
		expect(l.argv.join('\n')).toContain(`TCP-LISTEN:${port},bind=127.0.0.1`);
		// The socket is the proxy: a request through it gets the proxy's answer for a denied host.
		const reply = await new Promise<string>((resolve, reject) => {
			const s = connect(socket, () => s.write('CONNECT denied.test:443 HTTP/1.1\r\nHost: denied.test:443\r\n\r\n'));
			let got = '';
			s.on('data', (d) => {
				got += d.toString();
				if (got.includes('\r\n\r\n')) {
					s.destroy();
					resolve(got);
				}
			});
			s.on('error', reject);
		});
		expect(reply).toMatch(/^HTTP\/1\.[01] 403/);
		run.dispose();
		expect(existsSync(socket)).toBe(false);
	});
});

describe('the proxy bridge', () => {
	test('pipes each connection on the Unix socket to the TCP port', async () => {
		const echo = createServer((s) => s.pipe(s));
		await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
		cleanups.push(() => echo.close());
		const port = (echo.address() as { port: number }).port;
		const dir = realpathSync(mkdtempSync('/tmp/kingu-br-'));
		dirs.push(dir);
		const bridge = await ProxyBridge.start(join(dir, 'p.sock'), port);
		cleanups.push(() => bridge.close());
		const got = await new Promise<string>((resolve, reject) => {
			const s = connect(join(dir, 'p.sock'), () => s.write('ping'));
			s.on('data', (d) => {
				s.destroy();
				resolve(d.toString());
			});
			s.on('error', reject);
		});
		expect(got).toBe('ping');
	});
});
