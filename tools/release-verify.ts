#!/usr/bin/env bun
// Release checks for the macOS bundle that need only Xcode command line tools (CI-friendly):
//
//   bun tools/release-verify.ts <path/to/Kingu.app> [--json] [--frontend <dir>]
//                               [--max-app-mb N] [--max-sidecar-mb N]
//
// codesign (identifier, hardened runtime, entitlements allowlist, deep/strict verify), Mach-O
// dependencies and rpaths (otool), Info.plist keys (plutil), forbidden files and strings in the
// bundle and the frontend build, and a size budget. Exit 1 if any check fails.
//
// REA goes deeper on the same artifacts (see apps/desktop/RELEASE-VERIFY.md): open_binary →
// inspect_signature / inspect_macho / inspect_plist / inspect_rust_binary / search_strings. Run it
// on top of this script for a release; this script is the gate CI can always run.
//
// Optional env: KINGU_EXPECT_TEAM_ID (Developer ID builds: every binary must carry this Team ID).

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

export const BUNDLE_ID = 'ai.anthov.kingu.studio';
export const MIN_MACOS = '13.0';
export const SIDECAR = 'kingu-agent-host';
/** Terminal host daemon (crates/kingu-ptyd): owns PTYs so agent CLIs outlive the app. */
export const PTYD = 'kingu-ptyd';
/** The `kingu` command (crates/kingu-cli), linked as `kingu` by the app. */
export const CLI = 'kingu-cli';

/** Exact entitlements per executable (docs/PLAN.md 7.2). */
export const ENTITLEMENTS: Record<string, Record<string, unknown>> = {
	main: {},
	[SIDECAR]: { 'com.apple.security.cs.allow-jit': true },
	[PTYD]: {},
	[CLI]: {}
};
/** Signing identifiers (codesign -i); ad-hoc signing would otherwise derive one from a hash. */
export const IDENTIFIERS: Record<string, string> = { main: BUNDLE_ID, [SIDECAR]: `${BUNDLE_ID}.agent-host`, [PTYD]: `${BUNDLE_ID}.ptyd`, [CLI]: `${BUNDLE_ID}.cli` };
export const FORBIDDEN_ENTITLEMENTS = [
	'com.apple.security.cs.disable-library-validation',
	'com.apple.security.cs.allow-dyld-environment-variables',
	'com.apple.security.cs.allow-unsigned-executable-memory',
	'com.apple.security.cs.disable-executable-page-protection',
	'com.apple.security.get-task-allow'
];
/** Info.plist privacy strings the app may declare (features it actually has). */
export const ALLOWED_USAGE_KEYS = ['NSDesktopFolderUsageDescription', 'NSDocumentsFolderUsageDescription', 'NSDownloadsFolderUsageDescription'];
/** Load commands may only reference the OS or paths inside the bundle. */
export const ALLOWED_DYLIB_PREFIXES = ['/System/Library/', '/usr/lib/', '@executable_path/', '@loader_path/', '@rpath/'];

export type Check = { id: string; ok: boolean; detail: string };

/** Files that must never ship (relative paths inside the bundle or frontend build). */
export function forbiddenFile(rel: string): string | null {
	const name = basename(rel);
	if (name.endsWith('.map')) return 'source map';
	if (/^\.env(\..*)?$/.test(name)) return '.env file';
	if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || rel.split('/').includes('__tests__')) return 'test file';
	if (/\.(ts|tsx|svelte|rs|go)$/.test(name) && !name.endsWith('.d.ts')) return 'source file';
	if (rel.split('/').includes('node_modules')) return 'node_modules';
	if (name === '.DS_Store' || name.endsWith('.bun-build')) return 'build junk';
	if (/\.(pem|p12|key|mobileprovision)$/.test(name)) return 'key material';
	return null;
}

/** Byte patterns that must not appear in shipped files. `home` = the build user's home folder. */
export function forbiddenPatterns(repo: string, home: string): { label: string; re: RegExp; want?: RegExp }[] {
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return [
		{ label: 'repo path', re: new RegExp(esc(repo)) },
		{ label: 'home path', re: new RegExp(esc(home) + '/') },
		// A real reference to a map file (not the TypeScript emitter's `sourceMappingURL=${…}` template).
		{ label: 'sourceMappingURL', re: /sourceMappingURL=[\w./-]+\.map\b/ },
		// A real Anthropic key mixes digits in (`sk-ant-api03-…`); linker-merged literals nearby
		// ("sk-ant-" + "sk-…" + env-var names) do not, so the hit itself must carry one.
		{ label: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/, want: /\d/ },
		{ label: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36}/ },
		{ label: 'AWS key', re: /AKIA[0-9A-Z]{16}/ },
		{ label: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
	];
}

function sh(cmd: string[], stdin?: string): { code: number; out: string; err: string } {
	const r = Bun.spawnSync(cmd, { stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin) });
	return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

function plistJson(path: string): Record<string, unknown> {
	const r = sh(['plutil', '-convert', 'json', '-o', '-', path]);
	if (r.code !== 0) throw new Error(`plutil ${path}: ${r.err}`);
	return JSON.parse(r.out);
}

function walk(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = lstatSync(p);
		if (st.isDirectory()) out.push(...walk(p, base));
		else out.push(relative(base, p));
	}
	return out;
}

function dirSize(dir: string): number {
	return walk(dir).reduce((n, rel) => n + lstatSync(join(dir, rel)).size, 0);
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function isMachO(path: string): boolean {
	const fd = Bun.file(path);
	if (fd.size < 4) return false;
	const head = new Uint8Array(readFileSync(path).subarray(0, 4));
	const magic = (head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!;
	return [0xcffaedfe, 0xcefaedfe, 0xcafebabe, 0xfeedfacf, 0xfeedface].includes(magic >>> 0);
}

function entitlementsOf(bin: string): Record<string, unknown> {
	const r = sh(['codesign', '-d', '--entitlements', '-', '--xml', bin]);
	const xml = r.out.trim();
	if (!xml) return {};
	const j = sh(['plutil', '-convert', 'json', '-o', '-', '-'], xml);
	return j.code === 0 ? JSON.parse(j.out) : { __unparsed__: xml };
}

function signatureInfo(bin: string): Record<string, string> {
	const r = sh(['codesign', '-dv', '--verbose=4', bin]);
	const info: Record<string, string> = {};
	for (const line of (r.out + r.err).split('\n')) {
		const m = /^([A-Za-z]+)=(.*)$/.exec(line);
		if (m) info[m[1]!] ??= m[2]!;
		const f = /^CodeDirectory .* flags=(0x[0-9a-f]+)\(([^)]*)\)/.exec(line);
		if (f) {
			info.flagsHex = f[1]!;
			info.flags = f[2]!;
		}
	}
	return info;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
	return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
}

export function verify(app: string, opts: { frontend?: string; maxAppMb: number; maxSidecarMb: number; repo: string; home: string }): Check[] {
	const checks: Check[] = [];
	const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
	const contents = join(app, 'Contents');

	// --- Info.plist
	const plist = plistJson(join(contents, 'Info.plist'));
	const cargo = readFileSync(join(opts.repo, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
	const version = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
	add('plist.bundle-id', plist.CFBundleIdentifier === BUNDLE_ID, `CFBundleIdentifier=${plist.CFBundleIdentifier}`);
	add('plist.name', plist.CFBundleName === 'Kingu', `CFBundleName=${plist.CFBundleName}`);
	add('plist.version', plist.CFBundleShortVersionString === version, `CFBundleShortVersionString=${plist.CFBundleShortVersionString} (Cargo.toml ${version})`);
	add('plist.min-macos', plist.LSMinimumSystemVersion === MIN_MACOS, `LSMinimumSystemVersion=${plist.LSMinimumSystemVersion}`);
	const usage = Object.keys(plist).filter((k) => /UsageDescription$/.test(k));
	const extraUsage = usage.filter((k) => !ALLOWED_USAGE_KEYS.includes(k));
	add('plist.usage-descriptions', extraUsage.length === 0, `declared: ${usage.join(', ') || '(none)'}${extraUsage.length ? `; not allowed: ${extraUsage.join(', ')}` : ''}`);
	const ats = plist.NSAppTransportSecurity as Record<string, unknown> | undefined;
	add('plist.ats', !ats?.NSAllowsArbitraryLoads, `NSAllowsArbitraryLoads=${ats?.NSAllowsArbitraryLoads ?? 'unset'}`);

	// --- executables
	const exeName = String(plist.CFBundleExecutable);
	const macos = join(contents, 'MacOS');
	const mainExe = join(macos, exeName);
	const sidecar = join(macos, SIDECAR);
	add('bundle.main-exe', existsSync(mainExe), `Contents/MacOS/${exeName}`);
	add('bundle.sidecar', existsSync(sidecar), `Contents/MacOS/${SIDECAR}`);
	const ptyd = join(macos, PTYD);
	add('bundle.ptyd', existsSync(ptyd), `Contents/MacOS/${PTYD}`);
	const cli = join(macos, CLI);
	add('bundle.cli', existsSync(cli), `Contents/MacOS/${CLI}`);

	// --- signatures
	const verifyDeep = sh(['codesign', '--verify', '--deep', '--strict', '--verbose=2', app]);
	add('sign.verify-deep-strict', verifyDeep.code === 0, (verifyDeep.err || verifyDeep.out).trim().split('\n').slice(-1)[0] ?? '');
	const expectTeam = process.env.KINGU_EXPECT_TEAM_ID;
	const teams = new Set<string>();
	for (const [role, bin] of [['main', mainExe], [SIDECAR, sidecar], [PTYD, ptyd], [CLI, cli]] as const) {
		if (!existsSync(bin)) continue;
		const info = signatureInfo(bin);
		const runtime = /\bruntime\b/.test(info.flags ?? '');
		add(`sign.${role}.identifier`, info.Identifier === IDENTIFIERS[role], `Identifier=${info.Identifier} expected ${IDENTIFIERS[role]}`);
		add(`sign.${role}.hardened-runtime`, runtime, `Identifier=${info.Identifier} flags=${info.flagsHex}(${info.flags}) TeamIdentifier=${info.TeamIdentifier}`);
		teams.add(info.TeamIdentifier ?? 'not set');
		const ent = entitlementsOf(bin);
		const forbidden = FORBIDDEN_ENTITLEMENTS.filter((k) => k in ent);
		add(`sign.${role}.entitlements`, forbidden.length === 0 && sameJson(ent, ENTITLEMENTS[role]), `${JSON.stringify(ent)}${forbidden.length ? ` forbidden: ${forbidden.join(', ')}` : ''}`);
		if (expectTeam) add(`sign.${role}.team-id`, info.TeamIdentifier === expectTeam, `TeamIdentifier=${info.TeamIdentifier} expected ${expectTeam}`);
	}
	add('sign.same-team', teams.size <= 1, `TeamIdentifier: ${[...teams].join(', ')}`);

	// --- Mach-O load commands, for every Mach-O in the bundle
	const files = walk(app);
	const machos = files.filter((rel) => statSync(join(app, rel)).isFile() && isMachO(join(app, rel)));
	for (const rel of machos) {
		const p = join(app, rel);
		const libs = sh(['otool', '-L', p]).out.split('\n').slice(1).map((l) => l.trim().split(' (')[0]!).filter(Boolean);
		const bad = libs.filter((l) => !ALLOWED_DYLIB_PREFIXES.some((pre) => l.startsWith(pre)));
		add(`macho.${basename(rel)}.dylibs`, bad.length === 0, `${libs.length} libs${bad.length ? `; outside OS/bundle: ${bad.join(', ')}` : ''}: ${libs.map((l) => basename(l)).join(', ')}`);
		const lc = sh(['otool', '-l', p]).out;
		const rpaths = [...lc.matchAll(/cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (\S+)/g)].map((m) => m[1]!);
		const badRpath = rpaths.filter((r) => !r.startsWith('@executable_path') && !r.startsWith('@loader_path'));
		add(`macho.${basename(rel)}.rpaths`, badRpath.length === 0, rpaths.length ? rpaths.join(', ') : 'none');
	}

	// --- forbidden files and strings
	const badFiles = files.map((rel) => [rel, forbiddenFile(rel)] as const).filter(([, why]) => why);
	add('files.bundle', badFiles.length === 0, badFiles.length ? badFiles.map(([r, w]) => `${r} (${w})`).join('; ') : `${files.length} files, none forbidden`);
	const patterns = forbiddenPatterns(opts.repo, opts.home);
	const hits: string[] = [];
	for (const rel of files) {
		const buf = readFileSync(join(app, rel)).toString('latin1');
		for (const { label, re, want } of patterns) {
			const m = re.exec(buf);
			if (m && (!want || want.test(m[0]))) hits.push(`${rel}: ${label} ("${buf.slice(m.index, m.index + 60).replace(/[^\x20-\x7e]/g, '.')}")`);
		}
	}
	add('strings.bundle', hits.length === 0, hits.length ? hits.join('; ') : 'no repo/home paths, source map URLs or secret patterns');
	if (opts.frontend && existsSync(opts.frontend)) {
		const fe = walk(opts.frontend);
		const feBad = fe.map((rel) => [rel, forbiddenFile(rel)] as const).filter(([, why]) => why);
		const feHits: string[] = [];
		for (const rel of fe) {
			const text = readFileSync(join(opts.frontend, rel)).toString('latin1');
			for (const { label, re, want } of patterns) {
				const m = re.exec(text);
				if (m && (!want || want.test(m[0]))) feHits.push(`${rel}: ${label}`);
			}
		}
		add('files.frontend', feBad.length === 0 && feHits.length === 0, [...feBad.map(([r, w]) => `${r} (${w})`), ...feHits].join('; ') || `${fe.length} files in ${relative(opts.repo, opts.frontend)} (embedded in the binary), none forbidden`);
	}

	// --- size budget
	const appSize = dirSize(app);
	add('size.app', appSize <= opts.maxAppMb * 1024 * 1024, `${mb(appSize)} (budget ${opts.maxAppMb} MB)`);
	if (existsSync(sidecar)) {
		const s = statSync(sidecar).size;
		add('size.sidecar', s <= opts.maxSidecarMb * 1024 * 1024, `${mb(s)} (budget ${opts.maxSidecarMb} MB)`);
	}
	if (existsSync(mainExe)) add('size.main-exe', true, mb(statSync(mainExe).size));
	return checks;
}

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv.splice(i, 2)[1] : undefined;
	};
	const json = argv.includes('--json');
	const repo = resolve(import.meta.dir, '..');
	const frontend = flag('--frontend') ?? join(repo, 'apps/desktop/build');
	const maxAppMb = Number(flag('--max-app-mb') ?? 150);
	const maxSidecarMb = Number(flag('--max-sidecar-mb') ?? 90);
	const app = argv.find((a) => !a.startsWith('--'));
	if (!app || !existsSync(join(app, 'Contents/Info.plist'))) {
		console.error('usage: bun tools/release-verify.ts <path/to/Kingu.app> [--json] [--frontend dir] [--max-app-mb N] [--max-sidecar-mb N]');
		process.exit(2);
	}
	const checks = verify(resolve(app), { frontend, maxAppMb, maxSidecarMb, repo, home: homedir() });
	if (json) console.log(JSON.stringify(checks, null, 2));
	else for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(40)} ${c.detail}`);
	const failed = checks.filter((c) => !c.ok);
	console.error(failed.length ? `\n${failed.length} of ${checks.length} checks failed` : `\nall ${checks.length} checks passed`);
	process.exit(failed.length ? 1 : 0);
}
