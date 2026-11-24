// The agent sandbox (src/sandbox/): the settings check, the Seatbelt profile and its path
// escaping, masked variables (and how they fail closed), denial classification, and on macOS the
// real `sandbox-exec` through Arkai's Bash tool: a write inside the folder works, one outside is
// refused. Then a whole Arkai run: the sandboxed failure, the retry prompt, the user's answer.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHost, claudeEnv } from '../src/host.ts';
import { askFor } from '../src/guards/asks.ts';
import { runTool, sandboxedBash, toolDefs } from '../src/arkai/tools.ts';
import { SANDBOX_GRANT_SKIPPED, UNSANDBOXED_DECLINED, UNSANDBOXED_DISABLED } from '../src/arkai/session.ts';
import { claudeSandbox, sandboxConfig, SandboxConfigError, type SandboxConfig } from '../src/sandbox/config.ts';
import { gitDirs, macosArgv, macosProfile, policy, SANDBOX_EXEC, sandboxPath, sbplString, unsupported } from '../src/sandbox/profile.ts';
import { applyFailed, classifyDenial, failureNote, maskEnv, RunSandbox, SandboxUnavailable } from '../src/sandbox/run.ts';
import type { AgentEvent } from '../src/protocol.ts';
import { FakeLlm } from './fixtures/fake-llm.ts';

const dirs: string[] = [];
const hosts: AgentHost[] = [];
const servers: FakeLlm[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.dispatch('shutdown', null)));
	for (const s of servers.splice(0)) s.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (name: string) => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), `kingu-${name}-`)));
	dirs.push(d);
	return d;
};

const ON: SandboxConfig = { allowNetwork: true, allowLocalNetwork: false, allowUnsandboxedCommands: true, readwritePaths: [], readonlyPaths: [], deniedPaths: [], maskedEnv: [], allowedDomains: [], deniedDomains: [] };
const same = (p: string) => p;

/** Whether this process can run `sandbox-exec` at all (not macOS, or already inside a sandbox: no). */
const canSandbox = (() => {
	if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) return false;
	return Bun.spawnSync([SANDBOX_EXEC, '-p', '(version 1)\n(allow default)\n', '--', '/usr/bin/true']).exitCode === 0;
})();
const real = canSandbox ? test : test.skip;
if (!canSandbox) console.warn('sandbox-exec cannot run here: the real sandbox tests are skipped');

describe('sandbox settings', () => {
	test('off unless enabled is on; VS Code defaults', () => {
		expect(sandboxConfig(undefined)).toBeNull();
		expect(sandboxConfig(null)).toBeNull();
		expect(sandboxConfig({})).toBeNull();
		expect(sandboxConfig({ enabled: 'off', credentials: 'ignored while off' })).toBeNull();
		expect(sandboxConfig({ enabled: 'on' })).toEqual(ON);
		expect(sandboxConfig({ enabled: true })).toEqual(ON);
	});

	test('paths: each in one list, denied > readonly > readwrite', () => {
		const c = sandboxConfig({ enabled: 'on', allowNetwork: false, allowLocalNetwork: true, allowUnsandboxedCommands: false, 'fileSystem.userConfiguredPaths': { readwritePaths: ['/a', '/b', '/c', '/a'], readonlyPaths: ['/b', '/d'], deniedPaths: ['/c', '/d'] } })!;
		expect([c.readwritePaths, c.readonlyPaths, c.deniedPaths]).toEqual([['/a'], ['/b'], ['/c', '/d']]);
		expect([c.allowNetwork, c.allowLocalNetwork, c.allowUnsandboxedCommands]).toEqual([false, true, false]);
	});

	test('a value that does not fit refuses the run (never "on, minus the bad part")', () => {
		const bad: unknown[] = [
			[],
			{ enabled: 'yes' },
			{ enabled: 'on', allowNetwork: 'false' },
			{ enabled: 'on', allowUnsandboxedCommands: 0 },
			{ enabled: 'on', 'fileSystem.userConfiguredPaths': [] },
			{ enabled: 'on', 'fileSystem.userConfiguredPaths': { deniedPaths: '~/.ssh' } },
			{ enabled: 'on', 'fileSystem.userConfiguredPaths': { deniedPaths: ['~/.ssh', 3] } },
			{ enabled: 'on', 'fileSystem.userConfiguredPaths': { readwritePaths: ['/a\n(allow default)'] } },
			{ enabled: 'on', credentials: ['GH_TOKEN'] },
			{ enabled: 'on', credentials: { envVars: ['GH_TOKEN'] } },
			{ enabled: 'on', credentials: { envVars: { 'GH TOKEN': { injectHosts: [] } } } },
			{ enabled: 'on', credentials: { envVars: { GH_TOKEN: true } } },
			{ enabled: 'on', credentials: { envVars: { GH_TOKEN: {} } } },
			{ enabled: 'on', credentials: { envVars: { GH_TOKEN: { injectHosts: 'api.github.com' } } } }
		];
		for (const b of bad) expect(() => sandboxConfig(b)).toThrow(SandboxConfigError);
		expect(sandboxConfig({ enabled: 'on', credentials: null })!.maskedEnv).toEqual([]);
		expect(sandboxConfig({ enabled: 'on', credentials: { envVars: { GH_TOKEN: { injectHosts: ['api.github.com'] }, npm_token: { injectHosts: [] } } } })!.maskedEnv).toEqual(['GH_TOKEN', 'npm_token']);
	});

	test('a bad variable name is named, its value never is', () => {
		try {
			sandboxConfig({ enabled: 'on', credentials: { envVars: { 'ghp=secretvalue': { injectHosts: [] } } } });
			throw new Error('accepted');
		} catch (e) {
			expect(e).toBeInstanceOf(SandboxConfigError);
		}
	});

	test("the Claude SDK's sandbox option", () => {
		expect(claudeSandbox(ON)).toEqual({ enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: true, network: { allowedDomains: ['*'], allowLocalBinding: true } });
		expect(claudeSandbox({ ...ON, allowNetwork: false }).network).toEqual({ allowedDomains: [], strictAllowlist: true });
		// A masked variable the session itself signs in with stays in its environment: then nothing may leave the sandbox.
		expect(claudeSandbox(ON, ['ANTHROPIC_API_KEY']).allowUnsandboxedCommands).toBe(false);
		const c = sandboxConfig({
			enabled: 'on',
			allowNetwork: false,
			allowLocalNetwork: true,
			allowUnsandboxedCommands: false,
			credentials: { envVars: { GH_TOKEN: { injectHosts: ['api.github.com'] } } },
			'fileSystem.userConfiguredPaths': { readwritePaths: ['~/out'], readonlyPaths: ['/ro'], deniedPaths: ['~/.ssh'] }
		})!;
		expect(claudeSandbox(c)).toEqual({
			enabled: true,
			autoAllowBashIfSandboxed: false,
			allowUnsandboxedCommands: false,
			network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: true },
			filesystem: { allowWrite: ['~/out'], denyWrite: ['/ro', '~/.ssh'], denyRead: ['~/.ssh'] },
			// Hidden, not given back at a proxy.
			credentials: { envVars: [{ name: 'GH_TOKEN', mode: 'deny' }] }
		});
	});
});

describe('Seatbelt profile', () => {
	test('path escaping: quotes and backslashes are escaped, control characters refused', () => {
		expect(sbplString('/w/my repo')).toBe('"/w/my repo"');
		expect(sbplString('/w/a"b')).toBe('"/w/a\\"b"');
		expect(sbplString('/w/a\\b')).toBe('"/w/a\\\\b"');
		// A path that would close the string and add a rule stays one string.
		expect(sbplString('/w/x") (allow file-write* (subpath "/')).toBe('"/w/x\\") (allow file-write* (subpath \\"/"');
		expect(sbplString('/w/ไทย (1)')).toBe('"/w/ไทย (1)"');
		for (const bad of ['/w/a\nb', '/w/a\0b', '/w/a\tb', '/w/a\x7fb', '/w/a\rb']) expect(() => sbplString(bad)).toThrow(/control characters/);
	});

	test('configured paths: ~, relative to the folder, no trailing slash, not globs', () => {
		expect(sandboxPath('~', '/w/repo', '/Users/me', same)).toBe('/Users/me');
		expect(sandboxPath('~/.ssh/', '/w/repo', '/Users/me', same)).toBe('/Users/me/.ssh');
		expect(sandboxPath('./out/', '/w/repo', '/Users/me', same)).toBe('/w/repo/out');
		expect(sandboxPath('../other', '/w/repo', '/Users/me', same)).toBe('/w/other');
		expect(sandboxPath('/a/../b/*.txt', '/w/repo', '/Users/me', same)).toBe('/b/*.txt');
		expect(sandboxPath('~user/x', '/w/repo', '/Users/me', same)).toBe('/w/repo/~user/x');
		expect(sandboxPath('/', '/w/repo', '/Users/me', same)).toBe('/');
	});

	test('symlinks are resolved, also above a path that does not exist yet', () => {
		const d = temp('sbx-link');
		mkdirSync(join(d, 'real'));
		symlinkSync(join(d, 'real'), join(d, 'link'));
		expect(sandboxPath(join(d, 'link'), d, '/h')).toBe(join(d, 'real'));
		expect(sandboxPath(join(d, 'link/new/file'), d, '/h')).toBe(join(d, 'real/new/file'));
	});

	test('default: network open, writes only in the folder and the temp folder, git hooks and config read-only', () => {
		const p = policy(ON, { cwd: '/w/repo', home: '/Users/me', tmp: '/t/kingu-sandbox-1' }, same);
		expect(p).toEqual({
			network: true,
			localNetwork: false,
			proxyPort: null,
			readRoot: '/Users/me',
			readable: ['/w/repo', '/t/kingu-sandbox-1'],
			writable: ['/w/repo', '/t/kingu-sandbox-1'],
			readonly: ['/w/repo/.git/hooks', '/w/repo/.git/config'],
			denied: []
		});
		const s = macosProfile(p);
		expect(s).toBe(
			[
				'(version 1)',
				'(allow default)',
				'(deny file-write*)',
				'(allow file-write* (subpath "/w/repo") (subpath "/t/kingu-sandbox-1") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/ptmx") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
				'(deny file-write* (subpath "/w/repo/.git/hooks") (subpath "/w/repo/.git/config"))',
				'(deny file-read* (subpath "/Users/me"))',
				'(allow file-read-metadata (require-all (subpath "/Users/me") (vnode-type DIRECTORY)))',
				'(allow file-read* (subpath "/w/repo") (subpath "/t/kingu-sandbox-1"))',
				''
			].join('\n')
		);
		expect(s).not.toContain('network');
	});

	test('network off, user paths: later rules win, denied > readonly > readwrite', () => {
		const c: SandboxConfig = { ...ON, allowNetwork: false, readwritePaths: ['~/out', 'build'], readonlyPaths: ['docs'], deniedPaths: ['~/.ssh', '.env'] };
		const s = macosProfile(policy(c, { cwd: '/w/repo', home: '/Users/me', tmp: '/t/x', git: ['/w/main/.git/worktrees/t', '/w/main/.git'] }, same));
		expect(s).toContain('(deny network*)\n(allow network* (local unix-socket))\n(allow network* (remote unix-socket))\n(deny network-outbound (literal "/private/var/run/mDNSResponder"))\n(deny file-write*)');
		expect(s).not.toContain('localhost');
		expect(s).toContain('(allow file-write* (subpath "/w/repo") (subpath "/t/x") (subpath "/w/main/.git/worktrees/t") (subpath "/w/main/.git") (subpath "/Users/me/out") (subpath "/w/repo/build") (literal "/dev/null")');
		const ro = s.indexOf('(deny file-write* (subpath "/w/main/.git/worktrees/t/hooks") (subpath "/w/main/.git/worktrees/t/config") (subpath "/w/main/.git/hooks") (subpath "/w/main/.git/config") (subpath "/w/repo/docs"))');
		const denied = s.indexOf('(deny file-read* file-write* (subpath "/Users/me/.ssh") (subpath "/w/repo/.env"))');
		expect(ro).toBeGreaterThan(s.indexOf('(allow file-write*'));
		expect(denied).toBeGreaterThan(ro);
		expect(s.trimEnd().endsWith('(subpath "/w/repo/.env"))')).toBe(true);
		const local = macosProfile(policy({ ...c, allowLocalNetwork: true }, { cwd: '/w/repo', home: '/Users/me', tmp: '/t/x' }, same));
		expect(local).toContain('(allow network* (local ip "localhost:*"))\n(allow network* (remote ip "localhost:*"))\n(deny file-write*)');
	});

	test('a denied or read-only working folder is not writable; a hostile folder name stays a string', () => {
		const s = macosProfile(policy({ ...ON, readonlyPaths: ['.'] }, { cwd: '/w/repo', home: '/h', tmp: '/t/x' }, same));
		expect(s.lastIndexOf('(deny file-write* (subpath "/w/repo/.git/hooks") (subpath "/w/repo/.git/config") (subpath "/w/repo"))')).toBeGreaterThan(s.indexOf('(allow file-write*'));
		const evil = '/w/x") (allow file-write* (subpath "/y';
		const p = macosProfile(policy(ON, { cwd: evil, home: '/h', tmp: '/t/x' }, same));
		expect(p).toContain('(allow file-write* (subpath "/w/x\\") (allow file-write* (subpath \\"/y") (subpath "/t/x")');
		expect(() => macosProfile(policy(ON, { cwd: '/w/a\nb', home: '/h', tmp: '/t/x' }, same))).toThrow(/control characters/);
	});

	test('the argv: the profile is one argument, the command is not re-quoted', () => {
		const argv = macosArgv(policy(ON, { cwd: '/w/repo', home: '/h', tmp: '/t/x' }, same), ['/bin/bash', '-c', 'echo "a b" > $TMPDIR/x; rm -rf /']);
		expect(argv.length).toBe(7);
		expect(argv.slice(0, 2)).toEqual([SANDBOX_EXEC, '-p']);
		expect(argv[2]!.startsWith('(version 1)')).toBe(true);
		expect(argv.slice(3)).toEqual(['--', '/bin/bash', '-c', 'echo "a b" > $TMPDIR/x; rm -rf /']);
	});

	test("a linked worktree's git dirs", () => {
		const d = temp('sbx-git');
		const main = join(d, 'main/.git');
		const wt = join(d, 'wt');
		mkdirSync(join(main, 'worktrees/wt'), { recursive: true });
		mkdirSync(wt);
		writeFileSync(join(main, 'worktrees/wt/commondir'), '../..\n');
		writeFileSync(join(wt, '.git'), `gitdir: ${join(main, 'worktrees/wt')}\n`);
		expect(gitDirs(wt)).toEqual([join(main, 'worktrees/wt'), main]);
		expect(gitDirs(join(d, 'main'))).toEqual([]);
		expect(gitDirs(join(d, 'nope'))).toEqual([]);
	});

	test('macOS and Linux are supported; Windows says it is not', () => {
		expect(unsupported('darwin', () => true)).toBeNull();
		expect(unsupported('darwin', () => false)).toBe('/usr/bin/sandbox-exec is missing');
		expect(unsupported('linux', () => true, () => null)).toBeNull();
		expect(unsupported('linux', () => false, () => null)).toContain('bubblewrap (bwrap) is not installed');
		expect(unsupported('win32', () => true)).toContain('not supported on Windows');
	});
});

describe('masked variables', () => {
	const env = { PATH: '/bin', GH_TOKEN: 'ghp_0123456789abcdef', GITHUB_TOKEN: 'ghp_0123456789abcdef', DATABASE_URL: 'postgres://u:ghp_0123456789abcdef@db/x', gh_token: 'lowercase-other', SHORT: 'ab', COPY_OF_SHORT: 'ab', EMPTY: undefined };

	test('a masked variable is gone, and so is its value under another name', () => {
		const out = maskEnv(env, ['GH_TOKEN', 'SHORT'], 'darwin');
		expect(out).toEqual({ PATH: '/bin', gh_token: 'lowercase-other', COPY_OF_SHORT: 'ab', EMPTY: undefined });
		expect(JSON.stringify(out)).not.toContain('ghp_');
		// The caller's env is not changed.
		expect(env.GH_TOKEN).toBe('ghp_0123456789abcdef');
	});

	test('names are exact, except on Windows where the environment has no case', () => {
		expect(Object.keys(maskEnv(env, ['gh_token'], 'darwin'))).toContain('GH_TOKEN');
		const win = maskEnv(env, ['gh_token'], 'win32');
		expect([Object.keys(win).includes('GH_TOKEN'), Object.keys(win).includes('gh_token'), Object.keys(win).includes('GITHUB_TOKEN')]).toEqual([false, false, false]);
	});

	test('nothing masked: the same variables; a masked name that is not set: nothing else goes', () => {
		expect(maskEnv({ A: '1' }, [])).toEqual({ A: '1' });
		expect(maskEnv({ A: '1', B: 'bbbbbbbbbbbb' }, ['NOT_SET'])).toEqual({ A: '1', B: 'bbbbbbbbbbbb' });
	});

	test('fail closed: masked in the sandboxed launch, in the approved unsandboxed one, and when the sandbox is unavailable', () => {
		const cwd = temp('sbx-mask');
		const c: SandboxConfig = { ...ON, maskedEnv: ['GH_TOKEN'] };
		const mac = new RunSandbox(c, cwd, { platform: 'darwin', exists: () => true, tmpRoot: join(cwd, '.tmp') });
		const inside = mac.launch(['/bin/sh', '-c', 'env'], env, false);
		expect([inside.sandboxed, inside.argv[0], 'GH_TOKEN' in inside.env, 'GITHUB_TOKEN' in inside.env, 'DATABASE_URL' in inside.env]).toEqual([true, SANDBOX_EXEC, false, false, false]);
		expect(inside.env.TMPDIR!.startsWith(join(cwd, '.tmp', 'kingu-sandbox-'))).toBe(true);
		const outside = mac.launch(['/bin/sh', '-c', 'env'], env, true);
		expect([outside.sandboxed, outside.argv, 'GH_TOKEN' in outside.env, 'GITHUB_TOKEN' in outside.env, outside.env.PATH]).toEqual([false, ['/bin/sh', '-c', 'env'], false, false, '/bin']);
		mac.dispose();
		expect(existsSync(inside.env.TMPDIR!)).toBe(false);

		// A platform without the sandbox: the command is refused, never run bare; outside only by approval, still masked.
		const win = new RunSandbox(c, cwd, { platform: 'win32', exists: () => true });
		expect(win.problem).toContain('Windows');
		expect(() => win.launch(['sh', '-c', 'env'], env, false)).toThrow(SandboxUnavailable);
		expect(() => win.launch(['sh', '-c', 'env'], env, false)).toThrow(/was not run.*requestUnsandboxedExecution=true/);
		expect('GH_TOKEN' in win.launch(['sh', '-c', 'env'], env, true).env).toBe(false);
		// Unsandboxed runs turned off: not even with the flag.
		const strict = new RunSandbox({ ...c, allowUnsandboxedCommands: false }, cwd, { platform: 'win32', exists: () => true });
		expect(() => strict.launch(['sh', '-c', 'env'], env, true)).toThrow(/allowUnsandboxedCommands/);
		expect(() => strict.launch(['sh', '-c', 'env'], env, false)).toThrow(/^The command was not run[^R]*$/);
	});
});

describe('denial classification', () => {
	test('file access the sandbox stops', () => {
		for (const out of [
			'/bin/bash: /etc/x: Operation not permitted',
			'touch: /Users/me/.zshrc: Operation not permitted',
			'mkdir: /opt/x: Permission denied',
			'cp: x: Read-only file system',
			'sandbox-exec: execvp() of foo failed',
			'deny(1) file-write-create sandbox_violation',
			'cat: /tmp/x: No such file or\ndirectory'
		])
			expect([out, classifyDenial(out)]).toEqual([out, 'filesystem']);
	});

	test('network the sandbox stops (checked first: a blocked connect also says "not permitted")', () => {
		for (const out of [
			'curl: (6) Could not resolve host: example.com',
			'ssh: connect to host github.com port 22: Operation not permitted',
			'getaddrinfo EAI_AGAIN registry.npmjs.org',
			'fatal: unable to access: Network is unreachable',
			'connect ENETUNREACH 1.1.1.1:443',
			'Temporary failure in name resolution',
			'socket: Permission denied',
			'Operation not permitted\n(os error 1) while calling connect'
		])
			expect([out, classifyDenial(out)]).toEqual([out, 'network']);
	});

	test('an ordinary failure is not a denial', () => {
		for (const out of ['', '1 test failed', 'error TS2322: Type string is not assignable', 'fatal: not a git repository', 'command not found: foo']) expect([out, classifyDenial(out)]).toEqual([out, null]);
	});

	test('sandbox-exec could not apply the profile: not a denial of the command', () => {
		expect(applyFailed(71, 'sandbox-exec: sandbox_apply: Operation not permitted')).toBe(true);
		expect(applyFailed(1, 'touch: /x: Operation not permitted')).toBe(false);
		expect(applyFailed(0, 'sandbox-exec: fine')).toBe(false);
	});

	test('the note before a failed sandboxed command', () => {
		const fs = failureNote(ON, 'touch: /etc/x: Operation not permitted');
		expect(fs.startsWith('Command failed while running in sandboxed mode. If the command failed due to sandboxing:\n- The output looks like a blocked file access')).toBe(true);
		expect(fs).toContain('retry the command with requestUnsandboxedExecution=true and provide requestUnsandboxedExecutionReason');
		expect(fs.endsWith('Here is the output of the command:\n')).toBe(true);
		const off = failureNote({ allowUnsandboxedCommands: false, allowNetwork: false }, 'curl: (6) Could not resolve host: x.dev');
		expect(off).toContain('blocked network access');
		expect(off).toContain('Do not set requestUnsandboxedExecution=true');
		expect(off).not.toContain('retry the command with');
		// Network is open: a DNS failure is not blamed on the sandbox.
		expect(failureNote(ON, 'curl: (6) Could not resolve host: x.dev')).not.toContain('blocked network access');
		expect(failureNote(ON, '1 test failed')).not.toContain('looks like');
	});
});

describe('the Bash tool and the guards', () => {
	test('a sandboxed run offers the two retry parameters; one that may not leave the sandbox does not', () => {
		const bash = toolDefs(false, ON).find((t) => t.name === 'Bash')!;
		const props = (bash.parameters as { properties: Record<string, unknown> }).properties;
		expect(Object.keys(props)).toEqual(['command', 'description', 'timeout', 'requestUnsandboxedExecution', 'requestUnsandboxedExecutionReason']);
		expect(bash.description).toContain('Sandboxing:');
		expect(bash.description).toContain('The network is available in the sandbox.');
		const strict = sandboxedBash({ allowUnsandboxedCommands: false, allowNetwork: false, allowLocalNetwork: true });
		expect(Object.keys((strict.parameters as { properties: Record<string, unknown> }).properties)).toEqual(['command', 'description', 'timeout']);
		expect(strict.description).toContain('All network access is blocked in the sandbox except localhost.');
		expect(strict.description).toContain('Do not set requestUnsandboxedExecution=true');
		const plain = toolDefs(false).find((t) => t.name === 'Bash')!;
		expect([plain.description.includes('Sandboxing'), Object.keys((plain.parameters as { properties: Record<string, unknown> }).properties)]).toEqual([false, ['command', 'description', 'timeout']]);
	});

	test("Claude's Bash asking to leave the sandbox is asked about first, only in a sandboxed run", () => {
		const input = { command: 'rm a.txt', dangerouslyDisableSandbox: true };
		expect(askFor('Bash', input, '/w', { sandboxed: true, deletes: true }, [], same)).toEqual({ check: 'unsandboxed', paths: [] });
		expect(askFor('Bash', input, '/w', { deletes: true }, [], same)).toEqual({ check: 'delete', paths: ['a.txt'] });
		expect(askFor('Bash', { command: 'ls', dangerouslyDisableSandbox: false }, '/w', { sandboxed: true }, [], same)).toBeNull();
		expect(askFor('Bash', { command: 'ls', dangerouslyDisableSandbox: 'true' }, '/w', { sandboxed: true }, [], same)).toBeNull();
		expect(askFor('Write', { file_path: 'a', dangerouslyDisableSandbox: true }, '/w', { sandboxed: true }, [], same)).toBeNull();
	});
});

describe('real sandbox-exec', () => {
	const signal = new AbortController().signal;
	const setup = (over: Partial<SandboxConfig> = {}) => {
		const cwd = temp('sbx-ws');
		const outside = temp('sbx-out');
		const run = new RunSandbox({ ...ON, ...over }, cwd);
		const bash = (command: string, unsandboxed = false, env: Record<string, string | undefined> = { ...process.env }) => runTool('Bash', { command }, { cwd, env, signal, sandbox: { run, unsandboxed } });
		return { cwd, outside, run, bash };
	};

	real('a write inside the folder succeeds, one outside is refused', async () => {
		const { cwd, outside, run, bash } = setup();
		const inside = await bash('echo in > a.txt && mkdir -p sub && echo deep > sub/b.txt && cat a.txt sub/b.txt');
		expect(inside).toEqual({ content: 'in\ndeep', isError: false });
		expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('in\n');

		const out = await bash(`echo out > ${JSON.stringify(join(outside, 'b.txt'))}`);
		expect(out.isError).toBe(true);
		expect(existsSync(join(outside, 'b.txt'))).toBe(false);
		expect(out.content.startsWith('Command failed while running in sandboxed mode.')).toBe(true);
		expect(out.content).toContain('The output looks like a blocked file access');
		expect(out.content).toContain('Operation not permitted');
		expect(out.content).toContain('requestUnsandboxedExecution=true');
		expect(classifyDenial(out.content)).toBe('filesystem');

		// The home folder and /tmp are outside too; reads outside home are open.
		const home = await bash('touch "$HOME/.kingu-sandbox-test-$$" 2>&1; touch /tmp/kingu-sandbox-test-$$ 2>&1; ls / >/dev/null && echo read-ok');
		expect(home.content).toContain('read-ok');
		expect(home.content.match(/Operation not permitted/g)?.length).toBe(2);
		run.dispose();
	});

	real('$TMPDIR is the run\'s own folder and writable; it goes with the run', async () => {
		const { run, bash } = setup();
		const r = await bash('echo t > "$TMPDIR/x" && cat "$TMPDIR/x" && echo "$TMPDIR"');
		expect(r.isError).toBe(false);
		const dir = r.content.split('\n')[1]!;
		expect(dir).toContain('kingu-sandbox-');
		expect(existsSync(join(dir, 'x'))).toBe(true);
		run.dispose();
		expect(existsSync(dir)).toBe(false);
	});

	real('read-only and denied paths, and git hooks', async () => {
		const cwd0 = temp('sbx-paths');
		mkdirSync(join(cwd0, 'docs'));
		mkdirSync(join(cwd0, '.git/hooks'), { recursive: true });
		writeFileSync(join(cwd0, 'docs/a.md'), 'doc\n');
		writeFileSync(join(cwd0, '.env'), 'SECRET=1\n');
		const run = new RunSandbox({ ...ON, readonlyPaths: ['docs'], deniedPaths: ['.env'] }, cwd0);
		const bash = (command: string) => runTool('Bash', { command }, { cwd: cwd0, env: { ...process.env }, signal, sandbox: { run, unsandboxed: false } });
		expect((await bash('cat docs/a.md')).content).toBe('doc');
		expect((await bash('echo x >> docs/a.md')).isError).toBe(true);
		expect((await bash('cat .env')).isError).toBe(true);
		expect((await bash('echo x > .env')).isError).toBe(true);
		expect((await bash('echo "#!/bin/sh" > .git/hooks/pre-commit')).isError).toBe(true);
		expect((await bash('echo ok > src.txt && cat src.txt')).content).toBe('ok');
		expect([readFileSync(join(cwd0, 'docs/a.md'), 'utf8'), readFileSync(join(cwd0, '.env'), 'utf8'), existsSync(join(cwd0, '.git/hooks/pre-commit'))]).toEqual(['doc\n', 'SECRET=1\n', false]);
		run.dispose();
	});

	real('a folder whose name tries to add a rule is still confined', async () => {
		const base = temp('sbx-evil');
		const outside = temp('sbx-evil-out');
		const cwd = join(base, 'x") (allow file-write* (subpath "');
		mkdirSync(cwd, { recursive: true });
		const run = new RunSandbox(ON, cwd);
		const bash = (command: string) => runTool('Bash', { command }, { cwd, env: { ...process.env }, signal, sandbox: { run, unsandboxed: false } });
		expect((await bash('echo in > a.txt && cat a.txt')).content).toBe('in');
		expect((await bash(`echo out > ${JSON.stringify(join(outside, 'b.txt'))}`)).isError).toBe(true);
		expect(existsSync(join(outside, 'b.txt'))).toBe(false);
		run.dispose();
	});

	real('network off: no connection, also not to loopback unless allowed', async () => {
		const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('pong') });
		try {
			const url = `http://127.0.0.1:${server.port}/`;
			const curl = `/usr/bin/curl -sS --max-time 5 ${url}`;
			const open = setup();
			expect((await open.bash(curl)).content).toBe('pong');
			const off = setup({ allowNetwork: false });
			const blocked = await off.bash(curl);
			expect(blocked.isError).toBe(true);
			expect(blocked.content).not.toContain('pong');
			const local = setup({ allowNetwork: false, allowLocalNetwork: true });
			expect((await local.bash(curl)).content).toBe('pong');
			for (const s of [open, off, local]) s.run.dispose();
		} finally {
			server.stop(true);
		}
	});

	real('a masked variable does not reach the command, sandboxed or approved to run outside', async () => {
		const { outside, run, bash } = setup({ maskedEnv: ['KINGU_TEST_TOKEN'] });
		const env = { ...process.env, KINGU_TEST_TOKEN: 'tok_0123456789abcdef', KINGU_TEST_ALIAS: 'tok_0123456789abcdef', KINGU_TEST_PLAIN: 'visible' };
		const show = 'echo "[${KINGU_TEST_TOKEN-unset}] [${KINGU_TEST_ALIAS-unset}] [$KINGU_TEST_PLAIN]"; env | grep -c tok_0123456789abcdef || true';
		expect((await bash(show, false, env)).content).toBe('[unset] [unset] [visible]\n0');
		// Outside the sandbox (the user said yes): the write works, the variable is still hidden.
		const free = await bash(`${show}; echo out > ${JSON.stringify(join(outside, 'b.txt'))}`, true, env);
		expect(free.content).toBe('[unset] [unset] [visible]\n0');
		expect(readFileSync(join(outside, 'b.txt'), 'utf8')).toBe('out\n');
		run.dispose();
	});

	real('unsandboxed runs turned off: the flag does nothing', async () => {
		const { outside, run, bash } = setup({ allowUnsandboxedCommands: false });
		const r = await bash(`echo out > ${JSON.stringify(join(outside, 'b.txt'))}`, true);
		expect(r).toEqual({ content: UNSANDBOXED_DISABLED, isError: true });
		expect(existsSync(join(outside, 'b.txt'))).toBe(false);
		run.dispose();
	});
});

describe('an Arkai run with the sandbox on', () => {
	type Out = { id?: number | string | null; method?: string; params?: any; result?: unknown; error?: { code: number; message: string } };
	function setup() {
		const cwd = temp('sbx-run');
		const outside = temp('sbx-run-out');
		const llm = new FakeLlm();
		servers.push(llm);
		const out: Out[] = [];
		const waiters: { pred: (o: Out) => boolean; resolve: (o: Out) => void }[] = [];
		let n = 0;
		const logs: string[] = [];
		const host = new AgentHost({
			query: () => {
				throw new Error('the Claude SDK must not run');
			},
			write: (m) => {
				const o = JSON.parse(JSON.stringify(m)) as Out;
				out.push(o);
				for (const w of [...waiters]) if (w.pred(o)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(o));
			},
			newId: () => `req-${++n}`,
			log: (l) => logs.push(l)
		});
		hosts.push(host);
		const events = () => out.filter((o) => o.method === 'event' && o.params.runId === 1).map((o) => o.params.event as AgentEvent);
		const next = (pred: (o: Out) => boolean, ms = 15000) =>
			new Promise<Out>((resolve, reject) => {
				const hit = out.find(pred);
				if (hit) return resolve(hit);
				waiters.push({ pred, resolve });
				setTimeout(() => reject(new Error('timed out waiting for host output')), ms);
			});
		const nth = async <K extends AgentEvent['kind']>(kind: K, k = 1) => {
			const seen = () => events().filter((e) => e.kind === kind);
			await next(() => seen().length >= k);
			return seen()[k - 1] as Extract<AgentEvent, { kind: K }>;
		};
		const call = async (id: number, method: string, params: unknown) => {
			await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
			return out.findLast((o) => o.id === id)!;
		};
		const runtime = { kind: 'arkai', provider: { id: 'local', name: 'Local', api: 'openai', baseUrl: `${llm.url}/v1`, apiKey: 'sk-secret', models: [{ id: 'coder', contextWindow: 64_000 }] }, model: 'coder' };
		const toolResults = (request: number) => llm.requests[request]!.body.messages.filter((m: { role: string }) => m.role === 'tool').map((m: { content: string }) => m.content) as string[];
		return { cwd, outside, llm, logs, events, nth, call, runtime, toolResults };
	}

	test('a setting that does not fit refuses the run, for every runtime', async () => {
		const { cwd, call, runtime, events } = setup();
		const bad = await call(1, 'start', { runId: 1, cwd, prompt: 'x', runtime, sandbox: { enabled: 'on', credentials: { envVars: { 'not a name': { injectHosts: [] } } } } });
		expect(bad.error).toMatchObject({ code: -32602 });
		expect(bad.error!.message).toContain('is not an environment variable name');
		const claude = await call(2, 'start', { runId: 1, cwd, prompt: 'x', sandbox: { enabled: 'on', allowNetwork: 'no' } });
		expect(claude.error!.message).toBe('chat.agent.sandbox.network.allowNetwork must be true or false');
		expect(events()).toEqual([]);
	});

	real('blocked in the sandbox, then the retry prompt: declined, then allowed (asked each time, even in Allow all)', async () => {
		const { cwd, outside, llm, logs, events, nth, call, runtime, toolResults } = setup();
		const target = join(outside, 'b.txt');
		const command = `echo out > ${JSON.stringify(target)}`;
		const retry = JSON.stringify({ command, requestUnsandboxedExecution: true, requestUnsandboxedExecutionReason: 'The sandbox refused the write outside the project folder.' });
		llm.reply(
			{ calls: [{ id: 's1', name: 'Bash', args: JSON.stringify({ command }) }] },
			{ calls: [{ id: 's2', name: 'Bash', args: retry }] },
			{ calls: [{ id: 's3', name: 'Bash', args: retry }] },
			{ text: ['done'] }
		);
		await call(1, 'start', { runId: 1, cwd, prompt: 'write it', runtime, permissionMode: 'bypassPermissions', sandbox: { enabled: 'on' } });

		// 1: sandboxed, no prompt in Allow all, refused by the sandbox: the user is offered to allow the
		// folder and retry in the sandbox (sandbox/retry.ts), and skips; the model is told how to retry.
		const grantAsk = await nth('guard_asked');
		expect(grantAsk).toMatchObject({ tool: 'Bash', tool_use_id: 's1', check: 'sandbox_retry', paths: [outside] });
		const grantReq = await nth('permission_request');
		expect(grantReq).toMatchObject({ title: 'Allow sandbox path access and retry?', can_always: false, sandbox_grant: { kind: 'path', path: outside, access: 'readWrite' } });
		await call(2, 'answer', { runId: 1, requestId: grantReq.request_id, decision: 'deny' });
		const asked = await nth('guard_asked', 2);
		expect(events().filter((e) => e.kind === 'tool_result')[0]).toMatchObject({ tool_use_id: 's1', is_error: true });
		expect(existsSync(target)).toBe(false);
		expect(toolResults(1)[0]).toContain('Command failed while running in sandboxed mode.');
		expect(toolResults(1)[0]).toContain('requestUnsandboxedExecution=true');
		expect(toolResults(1)[0]).toContain(`- Blocked by: ${outside}`);
		expect(toolResults(1)[0]).toContain(SANDBOX_GRANT_SKIPPED);
		const offered = llm.requests[0]!.body.tools.find((t: { function: { name: string } }) => t.function.name === 'Bash').function;
		expect(Object.keys(offered.parameters.properties)).toContain('requestUnsandboxedExecution');

		// 2: the retry asks the user, with the model's reason; declined: nothing ran.
		expect(asked).toMatchObject({ tool: 'Bash', tool_use_id: 's2', check: 'unsandboxed', paths: [] });
		const req = await nth('permission_request', 2);
		expect(req).toMatchObject({ request_id: asked.request_id, tool: 'Bash', can_always: false, rules: [], detail: 'The sandbox refused the write outside the project folder.' });
		expect((req.input as { requestUnsandboxedExecution: boolean }).requestUnsandboxedExecution).toBe(true);
		await call(3, 'answer', { runId: 1, requestId: req.request_id, decision: 'deny', message: 'not there' });
		const req2 = await nth('permission_request', 3);
		expect(existsSync(target)).toBe(false);
		expect(toolResults(2)[1]).toBe(`${UNSANDBOXED_DECLINED} They said: not there`);

		// 3: asked again (an earlier answer is never kept); allowed: it runs outside the sandbox.
		expect((await nth('guard_asked', 3)).tool_use_id).toBe('s3');
		await call(4, 'answer', { runId: 1, requestId: req2.request_id, decision: 'allow_always' });
		expect(await nth('result')).toMatchObject({ is_error: false, result: 'done' });
		expect(readFileSync(target, 'utf8')).toBe('out\n');
		expect(events().filter((e) => e.kind === 'tool_result').map((e) => (e as { is_error: boolean }).is_error)).toEqual([true, true, false]);
		expect(events().filter((e) => e.kind === 'permission_request').length).toBe(3);
		// The command itself is never logged.
		expect(logs.some((l) => l.includes('sandbox on (network open, 0 masked variables)'))).toBe(true);
		expect(logs.join('\n')).not.toContain(target);
	});

	real('unsandboxed runs turned off: the retry is refused without asking; plan mode never runs it', async () => {
		const { cwd, outside, llm, events, nth, call, runtime, toolResults } = setup();
		const command = `echo out > ${JSON.stringify(join(outside, 'b.txt'))}`;
		llm.reply({ calls: [{ id: 'n1', name: 'Bash', args: JSON.stringify({ command, requestUnsandboxedExecution: true }) }] }, { text: ['ok'] });
		await call(1, 'start', { runId: 1, cwd, prompt: 'write it', runtime, permissionMode: 'bypassPermissions', sandbox: { enabled: 'on', allowUnsandboxedCommands: false } });
		await nth('result');
		expect(events().some((e) => e.kind === 'permission_request' || e.kind === 'guard_asked')).toBe(false);
		expect(toolResults(1)[0]).toBe(UNSANDBOXED_DISABLED);
		expect(existsSync(join(outside, 'b.txt'))).toBe(false);
		const offered = llm.requests[0]!.body.tools.find((t: { function: { name: string } }) => t.function.name === 'Bash').function;
		expect(Object.keys(offered.parameters.properties)).not.toContain('requestUnsandboxedExecution');
	});

	test('the sandbox off: the retry flag means nothing and Bash is offered as before', async () => {
		const { cwd, llm, events, nth, call, runtime } = setup();
		llm.reply({ calls: [{ id: 'o1', name: 'Bash', args: JSON.stringify({ command: 'echo hi', requestUnsandboxedExecution: true }) }] }, { text: ['ok'] });
		await call(1, 'start', { runId: 1, cwd, prompt: 'say hi', runtime, permissionMode: 'bypassPermissions', sandbox: { enabled: 'off' } });
		await nth('result');
		expect(events().some((e) => e.kind === 'guard_asked')).toBe(false);
		expect(events().find((e) => e.kind === 'tool_result')).toMatchObject({ content: 'hi', is_error: false });
		const offered = llm.requests[0]!.body.tools.find((t: { function: { name: string } }) => t.function.name === 'Bash').function;
		expect(Object.keys(offered.parameters.properties)).toEqual(['command', 'description', 'timeout']);
	});
	// A sandboxed command can read the launch environment of any of the user's processes that is not
	// Apple's (KERN_PROCARGS2, as `ps -E` does); no Seatbelt rule stops it. So a run's MCP servers
	// start without the masked variables, as Claude Code's do: here the value is only in the run's
	// own env (an account variable Kingu sends), and the control run shows the scan does find a server.
	real('a masked value is in no process the commands can read: the MCP servers start without it too', async () => {
		const value = `kgv-${crypto.randomUUID()}`;
		// A copy in the run's folder: the repo may be in the home folder, which the sandbox does not read.
		const scan = `${JSON.stringify(process.execPath)} scan.ts needle`;
		const mcp = { command: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-mcp-stdio.ts')] };
		const counts: number[] = [];
		// Masked first: the control run's server lives until the test ends.
		for (const masked of [['KINGU_TEST_TOKEN'], []]) {
			const { cwd, llm, nth, call, runtime, toolResults } = setup();
			writeFileSync(join(cwd, 'needle'), value);
			writeFileSync(join(cwd, 'scan.ts'), readFileSync(join(import.meta.dir, 'fixtures/procargs-scan.ts')));
			llm.reply({ calls: [{ id: 's1', name: 'Bash', args: JSON.stringify({ command: scan }) }] }, { text: ['done'] });
			const credentials = { envVars: Object.fromEntries(masked.map((n) => [n, { injectHosts: [] }])) };
			await call(1, 'start', { runId: 1, cwd, prompt: 'scan', runtime, permissionMode: 'bypassPermissions', env: { KINGU_TEST_TOKEN: value }, mcpServers: { docs: mcp }, sandbox: { enabled: 'on', credentials } });
			expect(await nth('result')).toMatchObject({ is_error: false });
			counts.push(Number(toolResults(1)[0]));
		}
		expect(counts[0]).toBe(0);
		expect(counts[1]).toBeGreaterThan(0);
	});
});

describe('a Claude run with the sandbox on', () => {
	type Out = { id?: number | string | null; method?: string; params?: any; error?: { message: string } };

	test("the SDK gets its sandbox option; a Bash call that leaves the sandbox is asked about from the hook, in Allow all too", async () => {
		const out: Out[] = [];
		let options: any;
		let n = 0;
		const host = new AgentHost({
			// A session that stays open: only its options and hook are used.
			query: ({ options: o }) => {
				options = o;
				const gen = (async function* () {
					yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm' };
					await new Promise<void>((r) => o.abortController!.signal.addEventListener('abort', () => r()));
				})();
				return Object.assign(gen, { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {} }) as never;
			},
			write: (m) => void out.push(JSON.parse(JSON.stringify(m))),
			newId: () => `req-${++n}`,
			options: { env: { PATH: '/bin', GH_TOKEN: 'ghp_0123456789abcdef', GITHUB_TOKEN: 'ghp_0123456789abcdef' } }
		});
		hosts.push(host);
		const cwd = temp('sbx-claude');
		const sandbox = { enabled: 'on', allowUnsandboxedCommands: true, credentials: { envVars: { GH_TOKEN: { injectHosts: ['api.github.com'] } } }, 'fileSystem.userConfiguredPaths': { deniedPaths: ['~/.ssh'] } };
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'start', params: { runId: 1, cwd, prompt: 'go', permissionMode: 'bypassPermissions', safetyChecks: false, sandbox } }));
		expect(out.find((o) => o.id === 1)?.error).toBeUndefined();
		expect(options.sandbox).toEqual({
			enabled: true,
			autoAllowBashIfSandboxed: false,
			allowUnsandboxedCommands: true,
			network: { allowedDomains: ['*'], allowLocalBinding: true },
			filesystem: { denyWrite: ['~/.ssh'], denyRead: ['~/.ssh'] },
			credentials: { envVars: [{ name: 'GH_TOKEN', mode: 'deny' }] }
		});
		// The masked variable (and a second name for its value) is not in the session's environment at all.
		expect([options.env.GH_TOKEN, options.env.GITHUB_TOKEN, options.env.PATH]).toEqual([undefined, undefined, '/bin']);

		const events = () => out.filter((o) => o.method === 'event').map((o) => o.params.event as AgentEvent);
		const hook = options.hooks.PreToolUse[0].hooks[0];
		const signal = new AbortController().signal;
		// Sandboxed call: nothing to ask.
		expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, 'tu1', { signal })).toEqual({});
		// Leaving the sandbox: asked, even with the safety checks off and everything allowed.
		const pending = hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls /', dangerouslyDisableSandbox: true } }, 'tu2', { signal });
		await new Promise((r) => setTimeout(r, 10));
		const asked = events().find((e) => e.kind === 'guard_asked');
		expect(asked).toMatchObject({ tool: 'Bash', tool_use_id: 'tu2', check: 'unsandboxed' });
		const req = events().find((e) => e.kind === 'permission_request') as Extract<AgentEvent, { kind: 'permission_request' }>;
		expect(req).toMatchObject({ can_always: false, tool: 'Bash' });
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'answer', params: { runId: 1, requestId: req.request_id, decision: 'deny' } }));
		const denied = await pending;
		expect(denied.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
		expect(denied.hookSpecificOutput.permissionDecisionReason).toContain('it runs outside the sandbox');
	});

	test('the sandbox off: no sandbox option', async () => {
		let options: any;
		const host = new AgentHost({
			query: ({ options: o }) => {
				options = o;
				const gen = (async function* () {
					await new Promise<void>((r) => o.abortController!.signal.addEventListener('abort', () => r()));
				})();
				return Object.assign(gen, { interrupt: async () => {} }) as never;
			},
			write: () => {},
			newId: () => 'r'
		});
		hosts.push(host);
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'start', params: { runId: 1, cwd: temp('sbx-claude-off'), prompt: 'go', sandbox: { enabled: 'off' } } }));
		expect('sandbox' in options).toBe(false);
	});
});

describe("a Claude session's environment", () => {
	test('masked variables are taken out; the account Kingu signed in with stays and is reported', () => {
		const base = { PATH: '/bin', GH_TOKEN: 'ghp_0123456789abcdef', ANTHROPIC_API_KEY: 'sk-ant-0123456789', COPY: 'x-sk-ant-0123456789' };
		expect(claudeEnv(base, ['GH_TOKEN'], {})).toEqual({ env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-0123456789', COPY: 'x-sk-ant-0123456789' }, kept: [] });
		// Not the account's: gone, with the variable that carries its value.
		expect(claudeEnv(base, ['ANTHROPIC_API_KEY'], {})).toEqual({ env: { PATH: '/bin', GH_TOKEN: 'ghp_0123456789abcdef' }, kept: [] });
		// The account's: kept for the sign-in (claudeSandbox then allows no unsandboxed command).
		expect(claudeEnv(base, ['ANTHROPIC_API_KEY', 'GH_TOKEN'], { ANTHROPIC_API_KEY: 'sk-ant-0123456789' })).toEqual({ env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-0123456789', COPY: 'x-sk-ant-0123456789' }, kept: ['ANTHROPIC_API_KEY'] });
	});
});
