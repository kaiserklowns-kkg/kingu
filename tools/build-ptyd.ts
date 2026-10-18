#!/usr/bin/env bun
// Compiles the terminal host daemon for Tauri's `bundle.externalBin`:
//   apps/desktop/src-tauri/binaries/kingu-ptyd-<target-triple>[.exe]
// Tauri copies it to `Kingu.app/Contents/MacOS/kingu-ptyd` (triple stripped), where
// `src-tauri/src/pty.rs` looks for it next to the app executable.
//
// Target: `--target <triple>`, else TAURI_ENV_TARGET_TRIPLE (set by `tauri build` for
// beforeBuildCommand), else the host triple from `rustc -vV`. RUSTFLAGS from the environment apply
// (build-desktop.ts sets the path remapping).

import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..');
const outDir = join(repo, 'apps/desktop/src-tauri/binaries');

function hostTriple(): string {
	const m = /^host: (\S+)$/m.exec(Bun.spawnSync(['rustc', '-vV']).stdout.toString());
	if (!m?.[1]) throw new Error('cannot determine the target triple: pass --target or install rustc');
	return m[1];
}

export function ptydPath(triple: string): string {
	return join(outDir, `kingu-ptyd-${triple}${triple.includes('windows') ? '.exe' : ''}`);
}

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	const i = argv.indexOf('--target');
	const triple = (i >= 0 && argv[i + 1]) || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
	const exe = triple.includes('windows') ? 'kingu-ptyd.exe' : 'kingu-ptyd';
	const cmd = ['cargo', 'build', '--release', '--locked', '-p', 'kingu-ptyd', '--target', triple];
	console.log(`build-ptyd: $ ${cmd.join(' ')}`);
	const r = Bun.spawnSync(cmd, { cwd: repo, stdout: 'inherit', stderr: 'inherit' });
	if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
	const out = ptydPath(triple);
	mkdirSync(outDir, { recursive: true });
	copyFileSync(join(repo, 'target', triple, 'release', exe), out);
	console.log(`build-ptyd: ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
}
