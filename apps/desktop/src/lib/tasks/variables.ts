// `${…}` variables in tasks (VS Code: configurationResolver's variableResolver.ts, as the task
// system uses it): `${workspaceFolder}`, the active file's `${file}` family, `${cwd}`,
// `${lineNumber}`, `${selectedText}`, `${pathSeparator}`, `${userHome}`, `${defaultBuildTask}`,
// `${env:X}`, `${config:x}`, `${input:x}` and the few `${command:…}` Kingu can answer. Inputs are
// asked once per run (VS Code collects every variable first, then prompts). Pure.

import type { InputDef } from './taskConfig.ts';

export type VariableContext = {
	workspaceFolder: string;
	/** The active editor's file (absolute). */
	file?: string;
	lineNumber?: number;
	columnNumber?: number;
	selectedText?: string;
	userHome?: string;
	execPath?: string;
	env: Record<string, string | undefined>;
	/** `${config:editor.fontSize}`: a setting's value. */
	config: (key: string) => unknown;
	defaultBuildTask?: string;
};

const VAR = /\$\{([^}]+)\}/g;

/** Every variable name used anywhere in `value` (`input:name`, `env:HOME`, `file`, …). */
export function collectVariables(value: unknown, into = new Set<string>()): Set<string> {
	if (typeof value === 'string') for (const m of value.matchAll(VAR)) into.add(m[1]);
	else if (Array.isArray(value)) value.forEach((v) => collectVariables(v, into));
	else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectVariables(v, into));
	return into;
}

export class VariableError extends Error {}

const dirname = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/'))) || '/';
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const extname = (p: string) => {
	const b = basename(p);
	const i = b.lastIndexOf('.');
	return i > 0 ? b.slice(i) : '';
};

function stringify(v: unknown): string {
	if (v === undefined || v === null) return '';
	return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
}

/** One variable's value; `resolved` holds what inputs (and commands) answered. */
export function variableValue(name: string, ctx: VariableContext, resolved: ReadonlyMap<string, string> = new Map()): string {
	if (resolved.has(name)) return resolved.get(name)!;
	const colon = name.indexOf(':');
	if (colon > 0) {
		const kind = name.slice(0, colon);
		const arg = name.slice(colon + 1);
		if (kind === 'env') return ctx.env[arg] ?? '';
		if (kind === 'config') {
			const v = ctx.config(arg);
			if (v !== null && typeof v === 'object') throw new VariableError(`Variable \${${name}} can not be resolved because '${arg}' is a structured value.`);
			return stringify(v);
		}
		if (kind === 'input') throw new VariableError(`Undefined input variable '${arg}' encountered. Remove or define '${arg}' to continue.`);
		if (kind === 'command') throw new VariableError(`Variable \${${name}} can not be resolved: Kingu runs no extension commands.`);
		if (kind === 'workspaceFolder' || kind === 'workspaceFolderBasename') return kind === 'workspaceFolder' ? ctx.workspaceFolder : basename(ctx.workspaceFolder);
		throw new VariableError(`Variable \${${name}} can not be resolved.`);
	}
	const root = ctx.workspaceFolder;
	switch (name) {
		case 'workspaceFolder':
		case 'workspaceRoot':
		case 'cwd':
			return root;
		case 'workspaceFolderBasename':
		case 'workspaceRootFolderName':
			return basename(root);
		case 'pathSeparator':
		case '/':
			return '/';
		case 'userHome':
			if (!ctx.userHome) throw new VariableError(`Variable \${userHome} can not be resolved. UserHome path is not defined`);
			return ctx.userHome;
		case 'execPath':
			return ctx.execPath ?? '';
		case 'defaultBuildTask':
			if (!ctx.defaultBuildTask) throw new VariableError('Variable ${defaultBuildTask} can not be resolved: there is no default build task.');
			return ctx.defaultBuildTask;
		case 'lineNumber':
		case 'columnNumber': {
			const n = name === 'lineNumber' ? ctx.lineNumber : ctx.columnNumber;
			if (n === undefined) throw new VariableError(`Variable \${${name}} can not be resolved. Make sure to have a line selected in the active editor.`);
			return String(n);
		}
		case 'selectedText':
			if (ctx.selectedText === undefined) throw new VariableError('Variable ${selectedText} can not be resolved. Make sure to have some text selected in the active editor.');
			return ctx.selectedText;
	}
	const fileVars = ['file', 'fileWorkspaceFolder', 'fileWorkspaceFolderBasename', 'relativeFile', 'relativeFileDirname', 'fileBasename', 'fileBasenameNoExtension', 'fileDirname', 'fileExtname', 'fileDirnameBasename'];
	if (fileVars.includes(name)) {
		const file = ctx.file;
		if (!file) throw new VariableError(`Variable \${${name}} can not be resolved. Please open an editor.`);
		const inside = file.startsWith(`${root}/`);
		const rel = inside ? file.slice(root.length + 1) : file;
		switch (name) {
			case 'file':
				return file;
			case 'fileWorkspaceFolder':
				if (!inside) throw new VariableError(`Variable \${${name}} can not be resolved. The file is not in the workspace folder.`);
				return root;
			case 'fileWorkspaceFolderBasename':
				if (!inside) throw new VariableError(`Variable \${${name}} can not be resolved. The file is not in the workspace folder.`);
				return basename(root);
			case 'relativeFile':
				return rel;
			case 'relativeFileDirname':
				return rel.includes('/') ? dirname(rel) : '.';
			case 'fileBasename':
				return basename(file);
			case 'fileBasenameNoExtension':
				return basename(file).slice(0, basename(file).length - extname(file).length);
			case 'fileDirname':
				return dirname(file);
			case 'fileExtname':
				return extname(file);
			case 'fileDirnameBasename':
				return basename(dirname(file));
		}
	}
	throw new VariableError(`Variable \${${name}} can not be resolved.`);
}

/** Replaces every `${…}` in the strings of `value` (keys untouched). */
export function substitute<T>(value: T, ctx: VariableContext, resolved: ReadonlyMap<string, string> = new Map()): T {
	if (typeof value === 'string') return value.replace(VAR, (_, name: string) => variableValue(name, ctx, resolved)) as T;
	if (Array.isArray(value)) return value.map((v) => substitute(v, ctx, resolved)) as T;
	if (value && typeof value === 'object' && !(value instanceof RegExp)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, ctx, resolved)])) as T;
	return value;
}

/** How the task system asks for an input (the quick input in the app, a fake in tests). */
export type InputPrompter = {
	promptString(input: Extract<InputDef, { type: 'promptString' }>): Promise<string | undefined>;
	pickString(input: Extract<InputDef, { type: 'pickString' }>): Promise<string | undefined>;
	/** `${command:…}` and `type: command` inputs Kingu can answer; undefined when it cannot. */
	command?(command: string, args: unknown): Promise<string | undefined>;
};

/**
 * Asks for every `${input:x}` that `variables` uses, once each, in order. Undefined when one was
 * cancelled (VS Code then does not run the task). Inputs' own defaults may use variables.
 */
export async function resolveInputs(variables: Iterable<string>, inputs: InputDef[], ctx: VariableContext, prompt: InputPrompter): Promise<Map<string, string> | undefined> {
	const out = new Map<string, string>();
	for (const name of variables) {
		if (out.has(name)) continue;
		if (name.startsWith('command:')) {
			const v = await prompt.command?.(name.slice('command:'.length), undefined);
			if (v === undefined) throw new VariableError(`Variable \${${name}} can not be resolved: Kingu runs no extension commands.`);
			out.set(name, v);
			continue;
		}
		if (!name.startsWith('input:')) continue;
		const id = name.slice('input:'.length);
		const input = inputs.find((i) => i.id === id);
		if (!input) throw new VariableError(`Undefined input variable '${id}' encountered. Remove or define '${id}' to continue.`);
		let value: string | undefined;
		if (input.type === 'promptString') value = await prompt.promptString({ ...input, default: input.default === undefined ? undefined : substitute(input.default, ctx, out) });
		else if (input.type === 'pickString') value = await prompt.pickString(input);
		else {
			value = await prompt.command?.(input.command, input.args);
			if (value === undefined) throw new VariableError(`Input '${id}': Kingu can't run the command ${input.command}.`);
		}
		if (value === undefined) return undefined;
		out.set(name, value);
	}
	return out;
}
