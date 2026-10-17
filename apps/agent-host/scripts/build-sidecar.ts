#!/usr/bin/env bun
// Compiles the agent host into a standalone executable for Tauri's `bundle.externalBin`:
//   apps/desktop/src-tauri/binaries/kingu-agent-host-<target-triple>[.exe]
// Tauri copies it to `Kingu.app/Contents/MacOS/kingu-agent-host` (triple stripped), where
// `src-tauri/src/agent/host.rs` looks for it next to the app executable.
//
// Target: `--target <triple>`, else TAURI_ENV_TARGET_TRIPLE (set by `tauri build` for
// beforeBuildCommand), else the host triple from `rustc -vV`.
//
// The executable embeds the Bun runtime and the bundled SDK, so it needs nothing from the repo or
// node_modules at runtime. It does NOT embed Claude Code: it runs `KINGU_CLAUDE_BIN` or `claude`
// from the login-shell PATH (see src/main.ts).

import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const outDir = resolve(root, '../desktop/src-tauri/binaries');

/** Rust target triple → `bun build --compile --target`. */
const BUN_TARGETS: Record<string, string> = {
	'aarch64-apple-darwin': 'bun-darwin-arm64',
	'x86_64-apple-darwin': 'bun-darwin-x64',
	'x86_64-unknown-linux-gnu': 'bun-linux-x64',
	'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
	'x86_64-pc-windows-msvc': 'bun-windows-x64'
};

function hostTriple(): string {
	const out = Bun.spawnSync(['rustc', '-vV']).stdout.toString();
	const m = /^host: (\S+)$/m.exec(out);
	if (!m?.[1]) throw new Error('cannot determine the target triple: pass --target or install rustc');
	return m[1];
}

function targetTriple(argv: string[]): string {
	const i = argv.indexOf('--target');
	if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
	return process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
}

export function sidecarPath(triple: string): string {
	return join(outDir, `kingu-agent-host-${triple}${triple.includes('windows') ? '.exe' : ''}`);
}

if (import.meta.main) {
	const triple = targetTriple(Bun.argv.slice(2));
	const bunTarget = BUN_TARGETS[triple];
	if (!bunTarget) {
		// universal-apple-darwin would need both slices + lipo; not wired up yet.
		console.error(`build-sidecar: unsupported target ${triple} (supported: ${Object.keys(BUN_TARGETS).join(', ')})`);
		process.exit(1);
	}
	const outfile = sidecarPath(triple);
	mkdirSync(dirname(outfile), { recursive: true });
	const cmd = [
		process.execPath,
		'build',
		'src/main.ts',
		'--compile',
		`--target=${bunTarget}`,
		'--minify',
		'--sourcemap=none',
		// The sidecar runs in user workspaces: never pick up a project's .env / bunfig.toml.
		'--no-compile-autoload-dotenv',
		'--no-compile-autoload-bunfig',
		'--outfile',
		outfile
	];
	console.log(`build-sidecar: ${triple} (${bunTarget}) → ${outfile}`);
	const r = Bun.spawnSync(cmd, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
	if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
	console.log(`build-sidecar: ${(statSync(outfile).size / 1024 / 1024).toFixed(1)} MB`);
}
