#!/usr/bin/env bun
// Release build of the desktop app: `bun run build:desktop [-- <extra tauri build args>]`.
//
//   1. `tauri build` with src-tauri/tauri.release.conf.json merged in, which compiles the agent host
//      sidecar and the terminal daemon first (beforeBuildCommand → build:sidecar, build:ptyd) and
//      bundles both (`bundle.externalBin`).
//      The base tauri.conf.json has no externalBin so `cargo build/test/clippy` and `tauri dev`
//      work without a compiled sidecar.
//   2. macOS: re-signs the sidecar with its own entitlements (entitlements/agent-host.plist:
//      cs.allow-jit, which Bun's JavaScriptCore needs under the hardened runtime), the terminal
//      daemon `kingu-ptyd` with none under its own identifier, and then the app
//      (entitlements/app.plist: none). Tauri signs every binary in Contents/MacOS with the app's
//      entitlements, which would either kill the sidecar or hand JIT to the main executable.
//
// Options (ours; everything else goes to `tauri build`):
//   --target <triple>   default: the host triple (aarch64-apple-darwin on Apple silicon)
//   --auditable         build the Rust binary with `cargo auditable` (embeds the dependency list
//                       for REA `inspect_rust_binary` / `cargo audit bin`); needs
//                       `cargo install cargo-auditable`
// Default bundles: `--bundles app` (a DMG made by Tauri would hold the app before step 2; make the
// DMG from the re-signed Kingu.app, then notarize; neither is automated yet).
//
// Signing: APPLE_SIGNING_IDENTITY (e.g. "Developer ID Application: … (TEAMID)") or ad-hoc "-".
// No secrets live in the repo.
//
// Paths: RUSTFLAGS remaps the repo, ~/.cargo and ~/.rustup to neutral prefixes so panic locations
// in the binary do not carry the build machine's home folder.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..');
const desktop = join(repo, 'apps/desktop');
const tauriDir = join(desktop, 'src-tauri');

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
	console.log(`$ ${cmd.join(' ')}`);
	const r = Bun.spawnSync(cmd, { cwd: opts.cwd ?? repo, env: opts.env ?? process.env, stdout: 'inherit', stderr: 'inherit' });
	if (r.exitCode !== 0) {
		console.error(`build-desktop: failed (${r.exitCode}): ${cmd[0]}`);
		process.exit(r.exitCode ?? 1);
	}
}

function hostTriple(): string {
	const m = /^host: (\S+)$/m.exec(Bun.spawnSync(['rustc', '-vV']).stdout.toString());
	if (!m?.[1]) throw new Error('rustc not found');
	return m[1];
}

const args = Bun.argv.slice(2);
let auditable = false;
let target = '';
const passthrough: string[] = [];
for (let i = 0; i < args.length; i++) {
	const a = args[i]!;
	if (a === '--auditable') auditable = true;
	else if (a === '--target' || a === '-t') target = args[++i] ?? '';
	else passthrough.push(a);
}
target ||= hostTriple();
if (!passthrough.includes('--bundles') && !passthrough.includes('-b')) passthrough.push('--bundles', 'app');

if (auditable && !Bun.which('cargo-auditable')) {
	console.error('build-desktop: --auditable needs cargo-auditable (cargo install cargo-auditable --locked)');
	process.exit(1);
}

const home = homedir();
const cargoHome = process.env.CARGO_HOME ?? join(home, '.cargo');
const rustupHome = process.env.RUSTUP_HOME ?? join(home, '.rustup');
// rustc applies the last matching prefix: home first, the more specific ones after it.
const remap = [
	`--remap-path-prefix=${home}=/home`,
	`--remap-path-prefix=${cargoHome}=/cargo`,
	`--remap-path-prefix=${rustupHome}=/rustup`,
	`--remap-path-prefix=${repo}=/kingu`
];
const env = {
	...process.env,
	RUSTFLAGS: [process.env.RUSTFLAGS, ...remap].filter(Boolean).join(' '),
	APPLE_SIGNING_IDENTITY: process.env.APPLE_SIGNING_IDENTITY || undefined
};

run(
	[
		'bunx',
		'tauri',
		'build',
		'--config',
		join(tauriDir, 'tauri.release.conf.json'),
		'--target',
		target,
		...(auditable ? ['--runner', join(repo, 'tools/auditable-runner.sh')] : []),
		...passthrough
	],
	{ cwd: desktop, env }
);

if (target.endsWith('apple-darwin')) {
	const app = join(repo, 'target', target, 'release/bundle/macos/Kingu.app');
	if (!existsSync(app)) {
		console.log(`build-desktop: no ${app} (not an app bundle build); skipping re-sign`);
		process.exit(0);
	}
	const identity = process.env.APPLE_SIGNING_IDENTITY || '-';
	const ts = identity === '-' ? [] : ['--timestamp'];
	const sign = (path: string, entitlements: string, extra: string[] = []) =>
		run(['codesign', '--force', '--sign', identity, '--options', 'runtime', ...ts, ...extra, '--entitlements', join(tauriDir, 'entitlements', entitlements), path]);
	sign(join(app, 'Contents/MacOS/kingu-agent-host'), 'agent-host.plist', ['--identifier', 'ai.anthov.kingu.studio.agent-host']);
	// The terminal daemon needs no entitlements (app.plist is empty); it gets its own identifier.
	sign(join(app, 'Contents/MacOS/kingu-ptyd'), 'app.plist', ['--identifier', 'ai.anthov.kingu.studio.ptyd']);
	// The `kingu` command (tools/build-cli.ts), likewise.
	sign(join(app, 'Contents/MacOS/kingu-cli'), 'app.plist', ['--identifier', 'ai.anthov.kingu.studio.cli']);
	sign(app, 'app.plist');
	run(['codesign', '--verify', '--deep', '--strict', '--verbose=2', app]);
	console.log(`build-desktop: ${app}\n  verify: bun tools/release-verify.ts ${app}`);
}
