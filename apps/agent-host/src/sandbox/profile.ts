// The policy of a sandboxed agent command, the macOS Seatbelt profile that carries it, and the argv
// that runs it (`/usr/bin/sandbox-exec -p <profile> -- <shell> -c <command>`). Linux carries the
// same policy as bubblewrap mounts (linux.ts); `sandboxBackend` picks one for the platform.
//
// VS Code does not build the profile in its own tree: the Local harness hands a settings file
// (`{ network, filesystem: { allowWrite, denyRead, allowRead, … } }`) to the `@vscode/sandbox-runtime`
// CLI (src/vs/platform/sandbox/common/terminalSandboxEngine.ts, `wrapCommand` / `_createSandboxConfig`)
// and the Copilot agent host hands `SandboxConfig` to the SDK runtime
// (src/vs/platform/agentHost/node/copilot/sandboxConfigForSdk.ts). Both end in Seatbelt on macOS.
// The rules here are the ones those configs state, written as SBPL the way Kingu's Snap sandbox
// does (crates/kingu-ptyd/src/sandbox.rs, `macos_profile`):
// - writes: only the working folder, the run's own temp folder (`TMPDIR`), a linked worktree's
//   git dirs and the user's read/write paths; git hooks and config stay read-only, since they
//   would run code outside the sandbox later;
// - reads: the home folder is unreadable except the folders above, the user's read-only paths and
//   what the command's tools need (reads.ts), as VS Code's Local harness denies `~` and re-opens
//   those; directories' own metadata stays visible so path lookups through `~` work (as the
//   sandbox runtime the Claude SDK ships does: `(allow file-read-metadata (vnode-type DIRECTORY))`).
//   Outside home, reads are open (toolchains read all over the system);
// - read-only paths: no writes; denied paths: no reads and no writes (denied > readonly > readwrite);
// - network: open when `allowNetwork` (VS Code's default) and no domain list applies; otherwise
//   no IP networking except, when a list applies, Kingu's filtering proxy on loopback (proxy.ts),
//   and all of loopback when `allowLocalNetwork`. Seatbelt filters by `localhost` or `*` only, so
//   domains are the proxy's job, and "local network" is loopback here.
//
// Pure apart from `realpath` (passed in), so `bun test` covers it.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import type { SandboxConfig } from './config.ts';
import { needsProxy } from './domains.ts';
import { bwrapMissing, findSystemExecutable, readProcVersion, wslVersion } from './linux.ts';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export class SandboxProfileError extends Error {}

export type Policy = {
	/** Open IP networking (no domain list applies). */
	network: boolean;
	localNetwork: boolean;
	/** The loopback port of the run's filtering proxy, the one way out when a domain list applies. */
	proxyPort: number | null;
	/** Unreadable (the home folder), except `readable`. Null: reads are not confined. */
	readRoot: string | null;
	/** Readable inside `readRoot`. */
	readable: string[];
	/** Writable folders. */
	writable: string[];
	/** No writes, even inside a writable folder. */
	readonly: string[];
	/** No reads and no writes. */
	denied: string[];
};

/**
 * A path as an SBPL string literal. Control characters are refused rather than escaped: no real
 * project path has them, and a mistake there would change what the profile allows.
 */
export function sbplString(path: string): string {
	if (/[\0-\x1f\x7f]/.test(path)) throw new SandboxProfileError(`sandbox: the path ${JSON.stringify(path)} has control characters`);
	return `"${path.replace(/["\\]/g, '\\$&')}"`;
}

/** macOS paths through its top-level symlinks, for paths that do not exist yet. */
function macosAlias(p: string): string {
	return /^\/(tmp|var|etc)(\/|$)/.test(p) ? `/private${p}` : p;
}

/** The existing part of `path` with symlinks resolved, the rest appended. */
function realpathExisting(path: string): string {
	const rest: string[] = [];
	let cur = path;
	for (let i = 0; i < 64; i++) {
		try {
			return join(realpathSync(cur), ...rest.reverse());
		} catch {
			const up = dirname(cur);
			if (up === cur) break;
			rest.push(basename(cur));
			cur = up;
		}
	}
	return macosAlias(path);
}

/**
 * A configured path as the kernel will see it: `~` is the home folder, a relative path is in
 * `cwd`, symlinks are resolved. Not a glob: VS Code's lists take literal paths only.
 */
export function sandboxPath(path: string, cwd: string, home: string, realpath: (p: string) => string = realpathExisting): string {
	const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
	const abs = normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
	const real = realpath(abs);
	return real.length > 1 ? real.replace(/\/+$/, '') : real;
}

/**
 * The git dirs of a linked worktree (`.git` is a file `gitdir: <dir>`): its own dir and the
 * common dir it shares with the main checkout, so commits work there. Empty for a normal
 * checkout, whose `.git` is inside the folder already.
 */
export function gitDirs(cwd: string): string[] {
	try {
		const dotGit = join(cwd, '.git');
		if (!statSync(dotGit).isFile()) return [];
		const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
		if (!m) return [];
		const own = resolve(cwd, m[1]!.trim());
		const out = [own];
		const commonFile = join(own, 'commondir');
		if (existsSync(commonFile)) out.push(resolve(own, readFileSync(commonFile, 'utf8').trim()));
		return out;
	} catch {
		return [];
	}
}

const dedup = (xs: string[]) => [...new Set(xs)];

/**
 * The policy of a run's commands. `tmp`: the run's own temp folder. `git`: the worktree's git
 * dirs (`gitDirs`). The working folder is always writable (VS Code's `addCurrentWorkingDirectory`
 * default), unless the user denied it or made it read-only.
 */
export function policy(c: SandboxConfig, at: { cwd: string; home: string; tmp: string; git?: string[]; proxyPort?: number | null }, realpath?: (p: string) => string): Policy {
	const fix = (p: string) => sandboxPath(p, at.cwd, at.home, realpath);
	const cwd = fix(at.cwd);
	const git = (at.git ?? []).map(fix);
	const gitRoots = git.length ? git : [join(cwd, '.git')];
	const writable = dedup([cwd, fix(at.tmp), ...git, ...c.readwritePaths.map(fix)]);
	const home = fix(at.home);
	const proxied = needsProxy({ open: c.allowNetwork, allowed: c.allowedDomains, denied: c.deniedDomains });
	return {
		network: c.allowNetwork && !proxied,
		localNetwork: c.allowLocalNetwork,
		proxyPort: proxied ? (at.proxyPort ?? null) : null,
		// Home itself as a working folder is the user's choice: then nothing in it is confined.
		readRoot: home === '/' ? null : home,
		readable: dedup([...writable, ...c.readonlyPaths.map(fix)]),
		writable,
		// Hooks and config run code later, outside the sandbox.
		readonly: dedup([...gitRoots.flatMap((g) => [join(g, 'hooks'), join(g, 'config')]), ...c.readonlyPaths.map(fix)]),
		denied: dedup(c.deniedPaths.map(fix))
	};
}

/** Devices every tool writes to: the null/zero devices, the terminal, inherited descriptors. */
const DEVICES = '(literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/ptmx") (regex #"^/dev/tty") (regex #"^/dev/fd/")';

const subpaths = (paths: string[]) => paths.map((p) => ` (subpath ${sbplString(p)})`).join('');

/** What one command adds to the run's policy: the reads (and writes) its tools need in home. */
export type CommandGrants = { read: string[]; write: string[] };

/** The policy for one command: `grants` are `~/…` or absolute paths, resolved like the user's. */
export function withGrants(p: Policy, grants: CommandGrants, home: string, realpath?: (p: string) => string): Policy {
	if (!grants.read.length && !grants.write.length) return p;
	// Both the path as written and where it leads: a dotfile is often a symlink into another folder.
	const fix = (x: string) => {
		const expanded = x === '~' ? home : x.startsWith('~/') ? join(home, x.slice(2)) : x;
		return dedup([normalize(expanded).replace(/\/+$/, ''), sandboxPath(x, '/', home, realpath)]);
	};
	return { ...p, readable: dedup([...p.readable, ...grants.read.flatMap(fix)]), writable: dedup([...p.writable, ...grants.write.flatMap(fix)]) };
}

/** The Seatbelt profile. Later rules win, so each deny is followed by its exceptions. */
export function macosProfile(p: Policy): string {
	let s = '(version 1)\n(allow default)\n';
	if (!p.network) {
		// Unix sockets stay (tools talk to local daemons through them), except mDNSResponder's,
		// which would resolve names and so carry data out over DNS (the proxy resolves names itself).
		s += '(deny network*)\n(allow network* (local unix-socket))\n(allow network* (remote unix-socket))\n';
		s += '(deny network-outbound (literal "/private/var/run/mDNSResponder"))\n';
		if (p.localNetwork) s += '(allow network* (local ip "localhost:*"))\n(allow network* (remote ip "localhost:*"))\n';
		else if (p.proxyPort !== null) s += `(allow network-outbound (remote ip "localhost:${portNumber(p.proxyPort)}"))\n`;
	}
	s += `(deny file-write*)\n(allow file-write*${subpaths(p.writable)} ${DEVICES})\n`;
	if (p.readonly.length) s += `(deny file-write*${subpaths(p.readonly)})\n`;
	if (p.readRoot !== null) {
		const root = sbplString(p.readRoot);
		s += `(deny file-read* (subpath ${root}))\n(allow file-read-metadata (require-all (subpath ${root}) (vnode-type DIRECTORY)))\n`;
		if (p.readable.length) s += `(allow file-read*${subpaths(p.readable)})\n`;
	}
	if (p.denied.length) s += `(deny file-read* file-write*${subpaths(p.denied)})\n`;
	return s;
}

function portNumber(port: number): number {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SandboxProfileError(`sandbox: ${port} is not a port`);
	return port;
}

/** `sandbox-exec -p <profile> -- argv`: the profile is one argument, never a shell string. */
export function macosArgv(p: Policy, argv: string[]): string[] {
	return [SANDBOX_EXEC, '-p', macosProfile(p), '--', ...argv];
}

/** How this machine sandboxes a command: Seatbelt, bubblewrap at a path, or not at all (and why). */
export type Backend = { kind: 'seatbelt' } | { kind: 'bwrap'; bwrap: string } | { kind: 'none'; problem: string };

/**
 * The sandbox backend of `platform`. macOS: `sandbox-exec`. Linux: bubblewrap (linux.ts), not on
 * WSL 1, which cannot run it (VS Code's sandbox runtime `isSupportedPlatform`). Windows: none.
 * VS Code's Local harness does not sandbox there either (src/vs/platform/sandbox/common/settings.ts
 * `isTerminalSandboxSupported` is false for Windows); it then treats the setting as off, but Kingu
 * refuses the command instead, so a run that asked for the sandbox never runs bare.
 */
export function sandboxBackend(platform: string = process.platform, exists: (p: string) => boolean = existsSync, procVersion: () => string | null = readProcVersion): Backend {
	if (platform === 'darwin') return exists(SANDBOX_EXEC) ? { kind: 'seatbelt' } : { kind: 'none', problem: `${SANDBOX_EXEC} is missing` };
	if (platform === 'linux') {
		if (wslVersion(procVersion()) === '1') return { kind: 'none', problem: 'the sandbox needs WSL 2: WSL 1 cannot run bubblewrap' };
		const bwrap = findSystemExecutable('bwrap', exists);
		return bwrap ? { kind: 'bwrap', bwrap } : { kind: 'none', problem: bwrapMissing() };
	}
	if (platform === 'win32') return { kind: 'none', problem: 'the sandbox is not supported on Windows (VS Code does not sandbox agent commands there either)' };
	return { kind: 'none', problem: `the sandbox is not supported on ${platform}` };
}

/** Why commands cannot be sandboxed on this machine, or null. */
export function unsupported(platform: string = process.platform, exists: (p: string) => boolean = existsSync, procVersion: () => string | null = readProcVersion): string | null {
	const b = sandboxBackend(platform, exists, procVersion);
	return b.kind === 'none' ? b.problem : null;
}

export const defaultHome = () => homedir();
