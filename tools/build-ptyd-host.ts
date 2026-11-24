#!/usr/bin/env bun
// Compiles the terminal daemon for the SSH hosts Kingu can hold terminals on:
//   apps/desktop/src-tauri/host-bin/kingu-ptyd-<triple>   (+ manifest.json)
// The release bundle carries that folder as a resource (tauri.release.conf.json), and
// `src-tauri/src/ssh_holder.rs` uploads the one matching a host's `uname -sm` to
// `~/.kingu/host/` there. A development build reads the same folder.
//
// Triples (ssh_holder.rs `TRIPLES`): Linux x86_64 and aarch64 as static musl binaries (one serves
// glibc and musl hosts), macOS arm64 and x86_64.
//
// What it needs, per triple:
//   - the Rust target: `rustup target add <triple>`
//   - Linux from another OS: `cargo-zigbuild` and `zig` (`cargo install cargo-zigbuild`, `brew install zig`)
//   - macOS triples: a macOS build machine
// A triple that can't be built here is reported and skipped: the app then says, for a host of
// that platform, that this build has no terminal host for it and falls back to restarting the
// agent with its resume command. `--strict` makes a skipped triple an error (release CI).
// `--only <triple>` builds one.

import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..');
const outDir = join(repo, 'apps/desktop/src-tauri/host-bin');
export const TRIPLES = ['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl', 'aarch64-apple-darwin', 'x86_64-apple-darwin'] as const;

/** How to build `triple` on this machine, or why it can't be. */
export function plan(triple: string, env: { platform: string; hostTriple: string; installed: readonly string[]; zigbuild: boolean }): { cmd: string[] } | { skip: string } {
	if (!env.installed.includes(triple)) return { skip: `the Rust target is not installed (rustup target add ${triple})` };
	const args = ['--release', '--locked', '-p', 'kingu-ptyd', '--target', triple];
	if (triple.includes('apple')) return env.platform === 'darwin' ? { cmd: ['cargo', 'build', ...args] } : { skip: 'macOS binaries need a macOS build machine' };
	if (triple === env.hostTriple) return { cmd: ['cargo', 'build', ...args] };
	return env.zigbuild ? { cmd: ['cargo', 'zigbuild', ...args] } : { skip: 'cross-compiling to Linux needs cargo-zigbuild and zig (cargo install cargo-zigbuild; brew install zig)' };
}

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	const strict = argv.includes('--strict');
	const only = argv.indexOf('--only') >= 0 ? argv[argv.indexOf('--only') + 1] : undefined;
	const text = (cmd: string[]) => {
		try {
			return Bun.spawnSync(cmd).stdout.toString();
		} catch {
			return '';
		}
	};
	const env = {
		platform: process.platform,
		hostTriple: /^host: (\S+)$/m.exec(text(['rustc', '-vV']))?.[1] ?? '',
		installed: text(['rustup', 'target', 'list', '--installed']).split('\n').map((l) => l.trim()).filter(Boolean),
		zigbuild: !!Bun.which('cargo-zigbuild') && !!Bun.which('zig')
	};
	mkdirSync(outDir, { recursive: true });
	const built: Record<string, { sha256: string; size: number }> = {};
	const skipped: Record<string, string> = {};
	for (const triple of TRIPLES) {
		if (only && only !== triple) continue;
		const p = plan(triple, env);
		if ('skip' in p) {
			skipped[triple] = p.skip;
			continue;
		}
		console.log(`build-ptyd-host: $ ${p.cmd.join(' ')}`);
		const r = Bun.spawnSync(p.cmd, { cwd: repo, stdout: 'inherit', stderr: 'inherit' });
		if (r.exitCode !== 0) {
			skipped[triple] = `the build failed (exit ${r.exitCode})`;
			continue;
		}
		const out = join(outDir, `kingu-ptyd-${triple}`);
		copyFileSync(join(repo, 'target', triple, 'release', 'kingu-ptyd'), out);
		const bytes = await Bun.file(out).arrayBuffer();
		built[triple] = { sha256: createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), size: statSync(out).size };
		console.log(`build-ptyd-host: ${out} (${(built[triple].size / 1024 / 1024).toFixed(1)} MB)`);
	}
	// Always written, so the resource folder is never empty and a build says what it carries.
	if (!only) writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({ built, skipped }, null, 2)}\n`);
	for (const [triple, why] of Object.entries(skipped)) console.warn(`build-ptyd-host: NOT BUILT ${triple}: ${why}`);
	const missing = Object.keys(skipped).length;
	if (missing) console.warn(`build-ptyd-host: ${missing} host platform(s) have no terminal host in this build; on those hosts terminals end with the connection.`);
	if (missing && strict) process.exit(1);
}
