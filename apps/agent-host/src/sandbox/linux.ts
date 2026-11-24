// The Linux backend of the agent sandbox: bubblewrap (`bwrap`) mounts that carry the same policy
// as the macOS Seatbelt profile (profile.ts `Policy`), and the bridge that takes a sandbox with no
// network of its own to the run's filtering proxy (proxy.ts).
//
// VS Code does this through `@vscode/sandbox-runtime` (its `linux-sandbox-utils.js`,
// `wrapCommandWithSandboxLinux` / `generateFilesystemArgs` / `initializeLinuxNetworkBridge`), which
// its Local harness runs with a settings file (src/vs/platform/sandbox/common/terminalSandboxEngine.ts)
// after checking for `bwrap` and `socat` and probing that `bwrap` works
// (src/vs/platform/sandbox/node/sandboxHelper.ts, `checkSandboxDependenciesWith`, `_probeBubblewrap`).
// The mounts here are that runtime's:
// - `--ro-bind / /`, then `--bind` for each writable folder: writes only there;
// - reads: a `--tmpfs` over the home folder, then the readable folders bound back (the runtime's
//   `denyRead` tmpfs and its `allowRead` re-binds); outside home, reads are open;
// - read-only paths inside a writable folder: `--ro-bind` over them; a missing one gets a mount
//   that blocks creating it (`/dev/null` for the path itself, an empty read-only folder for a
//   missing parent), whose host mount point is removed again after the command;
// - denied paths: an empty read-only tmpfs over a folder, `/dev/null` over a file;
// - network: `--unshare-net` (only the sandbox's own loopback) unless it is open; with a domain
//   list, the proxy's Unix socket is bound in and `socat` inside listens on the proxy's port on
//   the sandbox's loopback, so the proxy variables work unchanged (the runtime does the same with
//   ports 3128/1080). Name lookups through systemd-resolved or nscd sockets are hidden as macOS
//   hides mDNSResponder's: they would carry data out over DNS;
// - `--unshare-pid --proc /proc`, `--new-session` (no TIOCSTI into the terminal), `--die-with-parent`.
//
// What the runtime does that this does not: a seccomp filter against new Unix sockets (it ships
// prebuilt `apply-seccomp` binaries), and the ripgrep scan for nested `.git/hooks` and dotfiles.
//
// Executables are looked up only in system folders, never in PATH: a PATH folder the agent can
// write (node_modules/.bin, ~/.local/bin) could hold a fake `bwrap` that runs the command bare.
//
// Pure apart from the file system view (passed in), so `bun test` covers it on macOS.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type { Policy } from './profile.ts';

export class LinuxSandboxError extends Error {}

/** Where a distribution installs bubblewrap and socat (and NixOS's system profile). */
export const SYSTEM_BIN = ['/usr/bin', '/bin', '/usr/local/bin', '/usr/sbin', '/run/current-system/sw/bin'];

/** The first system folder that has `name`, or null. */
export function findSystemExecutable(name: string, exists: (p: string) => boolean = existsSync): string | null {
	for (const d of SYSTEM_BIN) {
		const p = join(d, name);
		if (exists(p)) return p;
	}
	return null;
}

const INSTALL_HINT = '(Debian/Ubuntu: sudo apt install bubblewrap socat; Fedora: sudo dnf install bubblewrap socat; Arch: sudo pacman -S bubblewrap socat)';

export const bwrapMissing = () => `bubblewrap (bwrap) is not installed ${INSTALL_HINT}`;
export const socatMissing = () => `socat is not installed: the sandbox needs it to reach its domain proxy (chat.agent.sandbox.network.allowedDomains / deniedDomains) ${INSTALL_HINT}`;

/** WSL's major version from `/proc/version` (VS Code's sandbox runtime `getWslVersion`), or null outside WSL. */
export function wslVersion(procVersion: string | null): string | null {
	if (!procVersion) return null;
	const m = /WSL(\d+)/i.exec(procVersion);
	if (m) return m[1]!;
	return procVersion.toLowerCase().includes('microsoft') ? '1' : null;
}

export const readProcVersion = (): string | null => {
	try {
		return readFileSync('/proc/version', 'utf8');
	} catch {
		return null;
	}
};

/**
 * Whether `bwrap` can make the namespaces the sandbox needs: null when it can, else why not.
 * VS Code's `_probeBubblewrap` (`bwrap --unshare-net --dev-bind / / echo ok`), with the pid
 * namespace and the read-only root this backend uses. When it fails and AppArmor restricts
 * unprivileged user namespaces (Ubuntu 23.10+), the message says so.
 */
export function probeBwrap(bwrap: string, readApparmor: () => string | null = readApparmorRestriction): string | null {
	const r = spawnSync(bwrap, ['--unshare-net', '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', '/bin/sh', '-c', 'echo ok'], { encoding: 'utf8', timeout: 5000 });
	if (!r.error && r.status === 0 && r.stdout.trim() === 'ok') return null;
	const detail = (r.stderr?.trim() || r.error?.message || `unexpected output: ${r.stdout?.trim() ?? ''}`).slice(0, 500);
	const apparmor = readApparmor()?.trim() === '1';
	return `bubblewrap (${bwrap}) cannot create the sandbox's namespaces: ${detail}${
		apparmor
			? ' AppArmor restricts unprivileged user namespaces on this machine (kernel.apparmor_restrict_unprivileged_userns=1): allow them for bwrap with an AppArmor profile, or set that sysctl to 0.'
			: ''
	}`;
}

function readApparmorRestriction(): string | null {
	try {
		return readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8');
	} catch {
		return null;
	}
}

/** What the mounts need to know of the host file system: a path's kind, following symlinks. */
export type FsView = { kind(path: string): 'dir' | 'file' | null };

export const hostFs: FsView = {
	kind(p) {
		try {
			return statSync(p).isDirectory() ? 'dir' : 'file';
		} catch {
			return null;
		}
	}
};

/** `p` is `root` or inside it. */
const within = (p: string, root: string) => p === root || root === '/' || p.startsWith(`${root}/`);
const depth = (p: string) => p.split('/').length;
const shallowFirst = (xs: string[]) => [...xs].sort((a, b) => depth(a) - depth(b));

/**
 * Name lookups that go through a local daemon's socket instead of the network, and so would still
 * work (and carry data out in the names asked about) in a sandbox without a network.
 */
export const RESOLVER_SOCKETS = ['/run/systemd/resolve', '/run/nscd', '/var/run/nscd'];

/** The proxy as the sandbox reaches it: the host socket bridged to it, and `socat` to listen inside. */
export type ProxyLink = { socket: string; port: number; socat: string };

export type LinuxMounts = {
	/** bwrap's options, before `--`. */
	args: string[];
	/** Mount points bwrap will create on the host for missing read-only or denied paths. */
	created: string[];
};

/**
 * The first part of `path` that does not exist, or null when it cannot be created (a file is in
 * the way: a linked worktree's `.git` file, say) or when it is a missing `.git` (blocking that
 * would break `git init`; VS Code's runtime skips it the same way).
 */
function creationPoint(path: string, fs: FsView): string | null {
	let cur = '';
	for (const part of path.split('/').filter(Boolean)) {
		cur += `/${part}`;
		const k = fs.kind(cur);
		if (k === 'file' && cur !== path) return null;
		if (k === null) return part === '.git' ? null : cur;
	}
	return null;
}

/**
 * bwrap's options for a policy. `cwd`: where the command starts. `link`: the proxy bridge, when a
 * domain list applies (a policy with `proxyPort` and no link has no network at all).
 */
export function linuxMounts(p: Policy, at: { cwd: string; link?: ProxyLink | null }, fs: FsView = hostFs): LinuxMounts {
	const args = ['--new-session', '--die-with-parent', '--unshare-pid'];
	const created: string[] = [];
	if (!p.network) {
		args.push('--unshare-net');
		if (p.proxyPort !== null && at.link) args.push('--bind', at.link.socket, at.link.socket);
	}
	args.push('--ro-bind', '/', '/');
	const writable = p.writable.filter((w) => !w.startsWith('/dev/') && w !== '/dev');
	const inWritable = (x: string) => writable.some((w) => within(x, w));
	if (p.readRoot !== null && fs.kind(p.readRoot) === 'dir') {
		args.push('--tmpfs', p.readRoot);
		// Readable folders come back read-only, except those a writable folder brings back below.
		for (const r of shallowFirst(p.readable.filter((r) => within(r, p.readRoot!) && r !== p.readRoot && !inWritable(r)))) args.push('--ro-bind-try', r, r);
	}
	for (const w of shallowFirst(writable)) if (fs.kind(w) !== null) args.push('--bind', w, w);
	if (!p.network) for (const s of RESOLVER_SOCKETS) if (fs.kind(s) === 'dir') args.push('--tmpfs', s, '--remount-ro', s);
	// Blocks creating a missing path inside a writable folder.
	const block = (x: string) => {
		if (!inWritable(x)) return;
		const c = creationPoint(x, fs);
		if (!c) return;
		if (c === x) args.push('--ro-bind', '/dev/null', c);
		else args.push('--tmpfs', c, '--remount-ro', c);
		created.push(c);
	};
	for (const r of shallowFirst(p.readonly)) {
		if (!inWritable(r)) continue;
		if (fs.kind(r) === null) block(r);
		else args.push('--ro-bind', r, r);
	}
	for (const d of shallowFirst(p.denied)) {
		const k = fs.kind(d);
		if (k === 'dir') args.push('--tmpfs', d, '--remount-ro', d);
		else if (k === 'file') args.push('--ro-bind', '/dev/null', d);
		else block(d);
	}
	args.push('--dev', '/dev', '--proc', '/proc', '--chdir', at.cwd);
	return { args, created };
}

/** A word as one POSIX shell word. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** socat's address syntax has its own separators: a path that has one is refused, not escaped. */
function socatPath(p: string): string {
	if (!/^\/[A-Za-z0-9._/+-]+$/.test(p) || p.length > 100) throw new LinuxSandboxError(`sandbox: the proxy socket path ${JSON.stringify(p)} cannot be used`);
	return p;
}

/**
 * `bwrap <options> -- argv`. With a proxy link, a small shell starts `socat` on the proxy's port
 * inside first, then runs `argv` as its own arguments (`"$@"`: never re-parsed).
 */
export function linuxArgv(bwrap: string, p: Policy, argv: string[], at: { cwd: string; link?: ProxyLink | null }, fs: FsView = hostFs): { argv: string[]; created: string[] } {
	const m = linuxMounts(p, at, fs);
	const link = !p.network && p.proxyPort !== null ? at.link : null;
	if (!link) return { argv: [bwrap, ...m.args, '--', ...argv], created: m.created };
	if (!Number.isInteger(link.port) || link.port < 1 || link.port > 65535) throw new LinuxSandboxError(`sandbox: ${link.port} is not a port`);
	const listen = `${shellQuote(link.socat)} TCP-LISTEN:${link.port},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${socatPath(link.socket)} >/dev/null 2>&1 &\n"$@"`;
	return { argv: [bwrap, ...m.args, '--', '/bin/sh', '-c', listen, 'kingu-sandbox', ...argv], created: m.created };
}

/**
 * Removes the mount points bwrap left on the host for missing paths, if they are still what it
 * made (an empty file or an empty folder): something written there since is left alone.
 */
export function removeMountPoints(paths: readonly string[]) {
	for (const p of [...paths].reverse()) {
		try {
			const st = statSync(p);
			if (st.isFile() && st.size === 0) unlinkSync(p);
			else if (st.isDirectory() && readdirSync(p).length === 0) rmdirSync(p);
		} catch {
			// Already gone.
		}
	}
}

/**
 * The host end of the proxy bridge: a Unix socket the sandbox can reach (it has no network), each
 * connection piped to the proxy on 127.0.0.1. VS Code's runtime runs `socat` for this end too.
 */
export class ProxyBridge {
	private constructor(
		private readonly server: Server,
		readonly socket: string
	) {}

	static start(socket: string, port: number): Promise<ProxyBridge> {
		socatPath(socket);
		const server = createServer((client: Socket) => {
			const up = connect({ host: '127.0.0.1', port });
			const drop = () => {
				client.destroy();
				up.destroy();
			};
			client.on('error', drop);
			up.on('error', drop);
			client.pipe(up);
			up.pipe(client);
		});
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(socket, () => resolve(new ProxyBridge(server, socket)));
		});
	}

	close() {
		this.server.close();
		try {
			unlinkSync(this.socket);
		} catch {
			// Already gone.
		}
	}
}

export const socketDirOf = (socket: string) => dirname(socket);
