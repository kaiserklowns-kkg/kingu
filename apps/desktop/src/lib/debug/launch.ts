// Launch configurations (VS Code: .vscode/launch.json, ConfigurationManager): reading them,
// `${…}` variable substitution, and the configurations offered when a folder has none. Pure.

import { parseJsonc } from '#lib/settings/jsonc.ts';
import type { RunInTerminalArguments } from './protocol.ts';
import { t } from '#lib/i18n/index.ts';

export type LaunchConfig = { type: string; request: string; name: string; preLaunchTask?: string; [key: string]: unknown };

/** Read in this order; `.kingu/launch.json` is Kingu's own place, same format. */
export const LAUNCH_FILES = ['.vscode/launch.json', '.kingu/launch.json'];

export function parseLaunchJson(text: string, source: string): { configs: LaunchConfig[]; error?: string } {
	let raw: unknown;
	try {
		raw = text.trim() ? parseJsonc(text) : {};
	} catch (e) {
		return { configs: [], error: t('tools.debug.launch.badJson', { source, error: e instanceof Error ? e.message : String(e) }) };
	}
	const list = (raw as { configurations?: unknown })?.configurations;
	if (list === undefined) return { configs: [] };
	if (!Array.isArray(list)) return { configs: [], error: t('tools.debug.launch.notArray', { source }) };
	const configs = list.filter(
		(c): c is LaunchConfig => !!c && typeof c === 'object' && typeof c.type === 'string' && typeof c.request === 'string' && typeof c.name === 'string'
	);
	return { configs };
}

export type VarContext = {
	workspaceFolder: string;
	/** Absolute path of the active editor's file. */
	file?: string;
	env: Record<string, string | undefined>;
};

const dirname = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/'))) || '/';
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const extname = (p: string) => {
	const b = basename(p);
	const i = b.lastIndexOf('.');
	return i > 0 ? b.slice(i) : '';
};

function variable(name: string, ctx: VarContext): string {
	if (name.startsWith('env:')) return ctx.env[name.slice(4)] ?? '';
	const root = ctx.workspaceFolder;
	switch (name) {
		case 'workspaceFolder':
		case 'workspaceRoot':
		case 'cwd':
			return root;
		case 'workspaceFolderBasename':
			return basename(root);
		case 'pathSeparator':
		case '/':
			return '/';
	}
	const file = ctx.file;
	if (['file', 'fileDirname', 'fileBasename', 'fileBasenameNoExtension', 'fileExtname', 'relativeFile', 'relativeFileDirname'].includes(name)) {
		if (!file) throw new Error(t('tools.debug.launch.needsFile', { variable: `\${${name}}` }));
		const rel = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
		switch (name) {
			case 'file':
				return file;
			case 'fileDirname':
				return dirname(file);
			case 'fileBasename':
				return basename(file);
			case 'fileBasenameNoExtension':
				return basename(file).slice(0, basename(file).length - extname(file).length);
			case 'fileExtname':
				return extname(file);
			case 'relativeFile':
				return rel;
			case 'relativeFileDirname':
				return rel.includes('/') ? dirname(rel) : '.';
		}
	}
	throw new Error(t('tools.debug.launch.unsupportedVar', { variable: `\${${name}}` }));
}

/** Replaces `${workspaceFolder}`, `${file}`, `${fileDirname}`, `${env:X}`… in every string of
 * `value` (keys untouched). Throws on a variable Kingu does not know (`${command:…}`, `${input:…}`). */
export function substitute<T>(value: T, ctx: VarContext): T {
	if (typeof value === 'string') return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => variable(name, ctx)) as T;
	if (Array.isArray(value)) return value.map((v) => substitute(v, ctx)) as T;
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, ctx)])) as T;
	return value;
}

/** A configuration offered when there is no launch.json, with what to do before launching it. */
export type Generated = {
	config: LaunchConfig;
	/** Run (and awaited) before the launch, e.g. `cargo build`. */
	build?: string[];
	/** The program is not known: ask for it, `config.program` being the suggestion. */
	askProgram?: boolean;
};

/** `[[bin]]`'s first name, else `[package]` name, from a Cargo.toml (line-based, enough for this). */
export function cargoBinName(toml: string): string | null {
	let table = '';
	let pkg: string | null = null;
	for (const raw of toml.split('\n')) {
		const line = raw.replace(/#.*$/, '').trim();
		const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
		if (header) {
			table = line.startsWith('[[') ? `[[${header[1]}]]` : header[1];
			continue;
		}
		const name = line.match(/^name\s*=\s*"([^"]+)"/)?.[1];
		if (!name) continue;
		if (table === '[[bin]]') return name;
		if (table === 'package') pkg ??= name;
	}
	return pkg;
}

/** VS Code's "select debugger" + initial configurations, for the active file's language. */
export function generatedConfigs(languageId: string, info: { cargoToml?: string | null } = {}): Generated[] {
	switch (languageId) {
		case 'rust': {
			const bin = info.cargoToml ? cargoBinName(info.cargoToml) : null;
			const config = { type: 'lldb', request: 'launch', name: bin ? `Debug ${bin}` : 'Debug executable', program: `\${workspaceFolder}/target/debug/${bin ?? ''}`, args: [], cwd: '${workspaceFolder}' };
			return [bin ? { config, build: ['cargo', 'build', '--bin', bin] } : { config, build: ['cargo', 'build'], askProgram: true }];
		}
		case 'c':
		case 'cpp':
		case 'objective-c':
			return [{ config: { type: 'lldb', request: 'launch', name: 'Debug executable', program: '${fileDirname}/${fileBasenameNoExtension}', args: [], cwd: '${workspaceFolder}' }, askProgram: true }];
		case 'go':
			return [{ config: { type: 'go', request: 'launch', name: 'Launch Package', mode: 'debug', program: '${fileDirname}' } }];
		case 'python':
			return [{ config: { type: 'debugpy', request: 'launch', name: 'Python Debugger: Current File', program: '${file}', console: 'integratedTerminal' } }];
		default:
			return [];
	}
}

/**
 * The argv for a panel terminal answering a `runInTerminal` reverse request. The terminal types it
 * into a shell (each word quoted), so `cwd` and `env` go through `sh -c 'cd … && exec env …'`
 * instead of shell syntax; a null env value unsets the variable.
 */
export function runInTerminalArgv(args: RunInTerminalArguments): string[] {
	const env = Object.entries(args.env ?? {});
	const unset = env.filter(([, v]) => v === null).flatMap(([k]) => ['-u', k]);
	const set = env.filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`);
	return ['/bin/sh', '-c', 'cd "$1" && shift && exec env "$@"', 'kingu-debug', args.cwd || '.', ...unset, ...set, ...args.args];
}
