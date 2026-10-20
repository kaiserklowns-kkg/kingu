// Launch configurations (VS Code: .vscode/launch.json, ConfigurationManager): reading them,
// `${…}` variable substitution, and the configurations offered when a folder has none. Pure.

import { parseJsonc } from '#lib/settings/jsonc.ts';
import type { RunInTerminalArguments } from './protocol.ts';
import { t } from '#lib/i18n/index.ts';

export type LaunchConfig = { type: string; request: string; name: string; preLaunchTask?: string | Record<string, unknown>; postDebugTask?: string | Record<string, unknown>; [key: string]: unknown };

/** Read in this order; `.kingu/launch.json` is Kingu's own place, same format. */
export const LAUNCH_FILES = ['.vscode/launch.json', '.kingu/launch.json'];

/** A launch.json compound (VS Code): several configurations started together. */
export type LaunchCompound = { name: string; configurations: string[]; preLaunchTask?: string | Record<string, unknown>; stopAll?: boolean };

export function parseLaunchJson(text: string, source: string): { configs: LaunchConfig[]; compounds: LaunchCompound[]; error?: string } {
	let raw: unknown;
	try {
		raw = text.trim() ? parseJsonc(text) : {};
	} catch (e) {
		return { configs: [], compounds: [], error: t('tools.debug.launch.badJson', { source, error: e instanceof Error ? e.message : String(e) }) };
	}
	const compounds = parseCompounds((raw as { compounds?: unknown })?.compounds);
	const list = (raw as { configurations?: unknown })?.configurations;
	if (list === undefined) return { configs: [], compounds };
	if (!Array.isArray(list)) return { configs: [], compounds, error: t('tools.debug.launch.notArray', { source }) };
	const configs = list.filter(
		(c): c is LaunchConfig => !!c && typeof c === 'object' && typeof c.type === 'string' && typeof c.request === 'string' && typeof c.name === 'string'
	);
	return { configs, compounds };
}

function parseCompounds(raw: unknown): LaunchCompound[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((c) => {
		if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !Array.isArray(c.configurations)) return [];
		// A configuration is named directly or as { name, folder } (one folder here).
		const names = c.configurations.map((x: unknown) => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string' ? (x as { name: string }).name : null)).filter((x: string | null): x is string => !!x);
		if (!names.length) return [];
		return [{ name: c.name, configurations: names, ...(c.preLaunchTask ? { preLaunchTask: c.preLaunchTask } : {}), ...(c.stopAll === true ? { stopAll: true } : {}) }];
	});
}

/** The configurations of a compound, in its order; names that match no configuration are reported. */
export function compoundConfigs(compound: LaunchCompound, configs: readonly LaunchConfig[]): { configs: LaunchConfig[]; missing: string[] } {
	const found: LaunchConfig[] = [];
	const missing: string[] = [];
	for (const name of compound.configurations) {
		const c = configs.find((x) => x.name === name);
		if (c) found.push(c);
		else missing.push(name);
	}
	return { configs: found, missing };
}

export type VarContext = {
	workspaceFolder: string;
	/** Absolute path of the active editor's file. */
	file?: string;
	env: Record<string, string | undefined>;
	/** Values of ${command:…} variables already asked for (${command:pickProcess}). */
	commands?: Record<string, string>;
};

/** The ${command:…} variables a configuration uses (resolved by asking before substitution). */
export function commandVariables(value: unknown): string[] {
	return [...new Set([...JSON.stringify(value ?? null).matchAll(/\$\{command:([^}]+)\}/g)].map((m) => m[1]))];
}

const dirname = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/'))) || '/';
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const extname = (p: string) => {
	const b = basename(p);
	const i = b.lastIndexOf('.');
	return i > 0 ? b.slice(i) : '';
};

function variable(name: string, ctx: VarContext): string {
	if (name.startsWith('env:')) return ctx.env[name.slice(4)] ?? '';
	if (name.startsWith('command:') && ctx.commands?.[name.slice(8)] !== undefined) return ctx.commands[name.slice(8)];
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
		case 'javascript':
		case 'typescript':
		case 'javascriptreact':
		case 'typescriptreact':
			// js-debug's "Launch Program" (Node.js runs TypeScript directly from 22.18/23.6 on; sourcemaps map compiled output back).
			return [{ config: { type: 'node', request: 'launch', name: 'Launch Program', skipFiles: ['<node_internals>/**'], program: '${file}' } }];
		default:
			return [];
	}
}

// --- js-debug -------------------------------------------------------------------------------------

/** launch.json types js-debug serves (the `pwa-` names are what its DAP server expects). */
const JS_TYPES: Record<string, string> = { node: 'pwa-node', 'pwa-node': 'pwa-node', 'node-terminal': 'node-terminal', chrome: 'pwa-chrome', 'pwa-chrome': 'pwa-chrome', msedge: 'pwa-msedge', 'pwa-msedge': 'pwa-msedge' };

export const isJsDebugType = (type: string) => type in JS_TYPES;

/** The type sent to the adapter: VS Code's js-debug extension maps `node` to `pwa-node` etc. */
export const adapterType = (type: string) => JS_TYPES[type] ?? type;

/**
 * What VS Code's js-debug configuration resolver fills in before launching (nodeDebugConfigurationResolver):
 * the working directory, internals skipped, sourcemaps on with the default outFiles and
 * resolveSourceMapLocations, and the Debug Console for output. The user's values win.
 */
export function resolveJsDebug(config: LaunchConfig, workspaceFolder: string): LaunchConfig {
	if (!isJsDebugType(config.type)) return config;
	const node = adapterType(config.type) === 'pwa-node' || config.type === 'node-terminal';
	const defaults: Record<string, unknown> = {
		sourceMaps: true,
		outFiles: [`${workspaceFolder}/**/*.(m|c|)js`, '!**/node_modules/**'],
		resolveSourceMapLocations: [`${workspaceFolder}/**`, '!**/node_modules/**'],
		...(node ? { cwd: workspaceFolder, skipFiles: ['<node_internals>/**'], console: 'internalConsole' } : { webRoot: workspaceFolder })
	};
	return { ...defaults, ...config };
}

// --- Add Configuration… (VS Code: debuggers' configurationSnippets) -------------------------------

export type ConfigSnippet = { label: string; description: string; body: LaunchConfig };

/** The snippets Add Configuration… offers and launch.json completion suggests, per debugger,
 * following the snippets of CodeLLDB/lldb-dap, the Go extension, the Python Debugger and js-debug. */
export const CONFIG_SNIPPETS: ConfigSnippet[] = [
	{ label: 'LLDB: Launch', description: 'lldb-dap', body: { type: 'lldb', request: 'launch', name: 'Launch', program: '${workspaceFolder}/<program>', args: [], cwd: '${workspaceFolder}' } },
	{ label: 'LLDB: Attach to Process', description: 'lldb-dap', body: { type: 'lldb', request: 'attach', name: 'Attach', pid: '${command:pickProcess}' } },
	{ label: 'Go: Launch Package', description: 'Delve', body: { type: 'go', request: 'launch', name: 'Launch Package', mode: 'auto', program: '${fileDirname}' } },
	{ label: 'Go: Launch Test Function', description: 'Delve', body: { type: 'go', request: 'launch', name: 'Launch Test Function', mode: 'test', program: '${workspaceFolder}', args: ['-test.run', 'MyTestFunction'] } },
	{ label: 'Go: Attach to Local Process', description: 'Delve', body: { type: 'go', request: 'attach', name: 'Attach to Process', mode: 'local', processId: '${command:pickProcess}' } },
	{ label: 'Python Debugger: Current File', description: 'debugpy', body: { type: 'debugpy', request: 'launch', name: 'Python Debugger: Current File', program: '${file}', console: 'integratedTerminal' } },
	{ label: 'Python Debugger: Module', description: 'debugpy', body: { type: 'debugpy', request: 'launch', name: 'Python Debugger: Module', module: '<module>' } },
	{ label: 'Python Debugger: Attach using Process Id', description: 'debugpy', body: { type: 'debugpy', request: 'attach', name: 'Python Debugger: Attach using Process Id', processId: '${command:pickProcess}' } },
	{ label: 'Python Debugger: Remote Attach', description: 'debugpy', body: { type: 'debugpy', request: 'attach', name: 'Python Debugger: Remote Attach', connect: { host: 'localhost', port: 5678 } } },
	{ label: 'Node.js: Launch Program', description: 'js-debug', body: { type: 'node', request: 'launch', name: 'Launch Program', skipFiles: ['<node_internals>/**'], program: '${workspaceFolder}/index.js' } },
	{ label: 'Node.js: Launch via npm', description: 'js-debug', body: { type: 'node', request: 'launch', name: 'Launch via npm', runtimeExecutable: 'npm', runtimeArgs: ['run-script', 'debug'], skipFiles: ['<node_internals>/**'] } },
	{ label: 'Node.js: Launch via Bun', description: 'js-debug', body: { type: 'node', request: 'launch', name: 'Launch via Bun', runtimeExecutable: 'bun', runtimeArgs: ['run', 'dev'], skipFiles: ['<node_internals>/**'] } },
	{ label: 'Node.js: Attach', description: 'js-debug', body: { type: 'node', request: 'attach', name: 'Attach', port: 9229, skipFiles: ['<node_internals>/**'] } },
	{ label: 'Node.js: Attach to Process', description: 'js-debug', body: { type: 'node', request: 'attach', name: 'Attach by Process ID', processId: '${command:PickProcess}', skipFiles: ['<node_internals>/**'] } },
	{ label: 'Chrome: Launch', description: 'js-debug', body: { type: 'chrome', request: 'launch', name: 'Launch Chrome', url: 'http://localhost:8080', webRoot: '${workspaceFolder}' } }
];

/** The snippets for a language first (the active file's debugger), then the rest. */
export function snippetsFor(languageId: string): ConfigSnippet[] {
	const prefer: Record<string, string> = { rust: 'lldb', c: 'lldb', cpp: 'lldb', 'objective-c': 'lldb', go: 'go', python: 'debugpy', javascript: 'node', typescript: 'node', javascriptreact: 'node', typescriptreact: 'node' };
	const type = prefer[languageId];
	return [...CONFIG_SNIPPETS.filter((s) => s.body.type === type), ...CONFIG_SNIPPETS.filter((s) => s.body.type !== type)];
}

/** The first index from `from` where `stop(char, depth)` holds, skipping the inside of strings and
 * comments (`stop` sees a string's opening quote); -1 when none. */
function scanTo(text: string, from: number, stop: (ch: string, depth: number) => boolean): number {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		const ch = text[i];
		if (ch !== '/' && stop(ch, depth)) return i;
		if (ch === '"') {
			for (i++; i < text.length && text[i] !== '"'; i += text[i] === '\\' ? 2 : 1);
			continue;
		}
		if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 1;
			continue;
		}
		if (ch === '{' || ch === '[') depth++;
		else if (ch === '}' || ch === ']') depth--;
	}
	return -1;
}

/**
 * Add Configuration…: launch.json text with `config` appended to `configurations`, the rest of the
 * file (comments too) untouched. A file without `configurations` gets one; an empty file becomes a
 * new launch.json. Returns the text and the offset of the inserted configuration.
 */
export function addConfigurationText(text: string, config: LaunchConfig): { text: string; offset: number } {
	const json = (indent: string) => JSON.stringify(config, null, '\t').replaceAll('\n', `\n${indent}`);
	if (!text.trim()) {
		const head = '{\n\t// https://code.visualstudio.com/docs/editor/debugging#_launch-configurations\n\t"version": "0.2.0",\n\t"configurations": [\n\t\t';
		return { text: `${head}${json('\t\t')}\n\t]\n}\n`, offset: head.length };
	}
	// The top-level "configurations" key, then its array.
	const open = scanTo(text, 0, (ch) => ch === '{');
	let key = -1;
	for (let i = open + 1; open >= 0 && i < text.length; ) {
		const at = scanTo(text, i, (ch, depth) => depth === 0 && (ch === '"' || ch === '}'));
		if (at < 0 || text[at] !== '"') break;
		const end = text.indexOf('"', at + 1);
		if (text.slice(at + 1, end) === 'configurations') {
			key = end + 1;
			break;
		}
		// Skip this property's value.
		const next = scanTo(text, end + 1, (ch, depth) => depth === 0 && (ch === ',' || ch === '}'));
		if (next < 0 || text[next] === '}') break;
		i = next + 1;
	}
	if (key < 0) {
		// No configurations: insert the property after the opening brace.
		const insert = `\n\t"configurations": [\n\t\t${json('\t\t')}\n\t],`;
		const at = open + 1;
		return { text: text.slice(0, at) + insert + text.slice(at), offset: at + '\n\t"configurations": [\n\t\t'.length };
	}
	const bracket = text.indexOf('[', key);
	const close = scanTo(text, bracket + 1, (ch, depth) => depth === 0 && ch === ']');
	const inner = text.slice(bracket + 1, close);
	const empty = !inner.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim();
	// Append after the last element (and any trailing comma), before the whitespace that precedes `]`.
	let end = close;
	while (end > bracket + 1 && /\s/.test(text[end - 1])) end--;
	const lastIsComma = text[end - 1] === ',';
	const lead = empty || lastIsComma ? '\n\t\t' : ',\n\t\t';
	const body = json('\t\t');
	const tail = text.slice(end, close).includes('\n') ? '' : '\n\t';
	return { text: text.slice(0, end) + lead + body + tail + text.slice(end), offset: end + lead.length };
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
