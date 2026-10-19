#!/usr/bin/env bun
// Compiles the `kingu` command for Tauri's `bundle.externalBin`:
//   apps/desktop/src-tauri/binaries/kingu-cli-<target-triple>[.exe]
// Tauri copies it to `Kingu.app/Contents/MacOS/kingu-cli` (triple stripped), where
// `src-tauri/src/cli_server.rs` finds it next to the app executable and links it as `kingu`.
//
// Target: `--target <triple>`, else TAURI_ENV_TARGET_TRIPLE, else the host triple (as build-ptyd.ts).

import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..');
const outDir = join(repo, 'apps/desktop/src-tauri/binaries');

function hostTriple(): string {
	const m = /^host: (\S+)$/m.exec(Bun.spawnSync(['rustc', '-vV']).stdout.toString());
	if (!m?.[1]) throw new Error('cannot determine the target triple: pass --target or install rustc');
	return m[1];
}

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	const i = argv.indexOf('--target');
	const triple = (i >= 0 && argv[i + 1]) || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
	const exe = triple.includes('windows') ? 'kingu-cli.exe' : 'kingu-cli';
	const cmd = ['cargo', 'build', '--release', '--locked', '-p', 'kingu-cli', '--target', triple];
	console.log(`build-cli: $ ${cmd.join(' ')}`);
	const r = Bun.spawnSync(cmd, { cwd: repo, stdout: 'inherit', stderr: 'inherit' });
	if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
	const out = join(outDir, `kingu-cli-${triple}${triple.includes('windows') ? '.exe' : ''}`);
	mkdirSync(outDir, { recursive: true });
	copyFileSync(join(repo, 'target', triple, 'release', exe), out);
	console.log(`build-cli: ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
}
