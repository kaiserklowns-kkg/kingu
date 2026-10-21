// tasks.json (VS Code: src/vs/workbench/contrib/tasks/common/taskConfiguration.ts, schema
// jsonSchema_v2.ts): custom `shell` / `process` tasks, compound tasks (dependsOn only), and
// customizations of detected tasks (`"type": "npm", "script": "build"`), with the top-level
// `options` / `presentation`, the `osx` / `linux` / `windows` overrides, `group`, `dependsOn` +
// `dependsOrder`, `presentation`, `problemMatcher`, `isBackground`, `runOptions` and `inputs`.
// Pure: the task system reads the file and the detectors supply the detected tasks.

import { t } from '#lib/i18n/index.ts';
import { parseJsonc } from '#lib/settings/jsonc.ts';

export type Quoting = 'escape' | 'strong' | 'weak';
export type CommandString = string | { value: string; quoting: Quoting };
export type ShellQuotingOptions = { escape?: string | { escapeChar: string; charsToEscape: string }; strong?: string; weak?: string };
export type ShellConfig = { executable?: string; args?: string[]; quoting?: ShellQuotingOptions };
export type CommandOptions = { cwd?: string; env?: Record<string, string>; shell?: ShellConfig };
export type Reveal = 'always' | 'silent' | 'never';
export type RevealProblems = 'never' | 'onProblem' | 'always';
export type PanelKind = 'shared' | 'dedicated' | 'new';
export type Presentation = {
	echo: boolean;
	reveal: Reveal;
	revealProblems: RevealProblems;
	focus: boolean;
	panel: PanelKind;
	showReuseMessage: boolean;
	clear: boolean;
	group?: string;
	close?: boolean;
};
export type TaskGroup = { kind: string; isDefault: boolean | string };
/** A `dependsOn` entry: a task label, or a task identifier (`{ "type": "npm", "script": "build" }`). */
export type TaskRef = string | Record<string, unknown>;
export type RunOptions = { runOn: 'default' | 'folderOpen'; reevaluateOnRerun: boolean; instanceLimit: number; instancePolicy: 'prompt' | 'terminateNewest' | 'terminateOldest' | 'warn' | 'silent' };
export type Platform = 'osx' | 'linux' | 'windows';

export type Task = {
	/** Unique in the folder: the label for custom tasks, `type:` + identifier for detected ones
	 * (another root folder's and the workspace file's carry a prefix, folders.ts scopeTasks). */
	id: string;
	label: string;
	/** `shell`, `process`, or the detector's type (`npm`, `cargo`, `go`). */
	type: string;
	/** Where it comes from: `Workspace` (tasks.json) or the detector (`npm`, `rust`, `go`). */
	source: string;
	/** A detected task's identity (`{ type: 'npm', script: 'build' }`). */
	definition?: Record<string, unknown>;
	runtime?: 'shell' | 'process';
	command?: CommandString;
	args: CommandString[];
	options: CommandOptions;
	presentation: Presentation;
	group?: TaskGroup;
	dependsOn: TaskRef[];
	dependsOrder: 'parallel' | 'sequence';
	/** The raw `problemMatcher` value (names and inline matchers), parsed when the task runs. */
	problemMatcher?: unknown;
	isBackground: boolean;
	promptOnClose: boolean;
	runOptions: RunOptions;
	detail?: string;
	hide: boolean;
	/** Defined or customized in tasks.json. */
	configured: boolean;
	/** The root folder (absolute) whose tasks.json or detection it comes from; none for a `.code-workspace` file's task (folders.ts). */
	folder?: string;
};

export type InputDef =
	| { id: string; type: 'promptString'; description?: string; default?: string; password?: boolean }
	| { id: string; type: 'pickString'; description?: string; options: { label?: string; value: string }[]; default?: string }
	| { id: string; type: 'command'; command: string; args?: unknown };

/** A tasks.json entry of a detected type: properties to lay over the detected task it names. */
export type Customization = { definition: Record<string, unknown>; props: Partial<Task>; label?: string };

export type TasksFile = { tasks: Task[]; customizations: Customization[]; inputs: InputDef[]; errors: string[] };

export const DEFAULT_PRESENTATION: Presentation = { echo: true, reveal: 'always', revealProblems: 'never', focus: false, panel: 'shared', showReuseMessage: true, clear: false };
export const DEFAULT_RUN_OPTIONS: RunOptions = { runOn: 'default', reevaluateOnRerun: true, instanceLimit: 1, instancePolicy: 'prompt' };

/** Task properties that are not part of a detected task's identity. */
const TASK_PROPS = new Set([
	'label', 'taskName', 'type', 'command', 'args', 'options', 'group', 'dependsOn', 'dependsOrder', 'presentation', 'problemMatcher', 'isBackground', 'promptOnClose',
	'runOptions', 'detail', 'hide', 'icon', 'osx', 'linux', 'windows', 'isBuildCommand', 'isTestCommand', 'showOutput', 'echoCommand', 'suppressTaskName', 'isShellCommand', 'terminal'
]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const QUOTINGS: readonly string[] = ['escape', 'strong', 'weak'];

/** VS Code's ShellString.from: a string, a string array (joined with spaces) or `{ value, quoting }`. */
export function commandString(value: unknown): CommandString | undefined {
	if (isString(value)) return value;
	if (Array.isArray(value) && value.every(isString)) return value.join(' ');
	if (isObject(value)) {
		const v = isString(value.value) ? value.value : Array.isArray(value.value) && value.value.every(isString) ? value.value.join(' ') : undefined;
		if (!v) return undefined;
		const quoting = isString(value.quoting) && QUOTINGS.includes(value.quoting) ? (value.quoting as Quoting) : 'strong';
		return { value: v, quoting };
	}
	return undefined;
}

export const commandValue = (c: CommandString): string => (isString(c) ? c : c.value);

function stringMap(v: unknown): Record<string, string> | undefined {
	if (!isObject(v)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, x] of Object.entries(v)) if (isString(x)) out[k] = x;
	return out;
}

function shellConfig(v: unknown): ShellConfig | undefined {
	if (!isObject(v)) return undefined;
	const out: ShellConfig = {};
	if (isString(v.executable)) out.executable = v.executable;
	if (Array.isArray(v.args)) out.args = v.args.filter(isString);
	if (isObject(v.quoting)) {
		const q = v.quoting;
		const quoting: ShellQuotingOptions = {};
		if (isString(q.strong)) quoting.strong = q.strong;
		if (isString(q.weak)) quoting.weak = q.weak;
		if (isString(q.escape)) quoting.escape = q.escape;
		else if (isObject(q.escape) && isString(q.escape.escapeChar) && isString(q.escape.charsToEscape)) quoting.escape = { escapeChar: q.escape.escapeChar, charsToEscape: q.escape.charsToEscape };
		out.quoting = quoting;
	}
	return out;
}

function commandOptions(v: unknown, errors: string[]): CommandOptions | undefined {
	if (!isObject(v)) return undefined;
	const out: CommandOptions = {};
	if (v.cwd !== undefined) {
		if (isString(v.cwd)) out.cwd = v.cwd;
		else errors.push(t('ideTasks.config.cwdType', { value: JSON.stringify(v.cwd) }));
	}
	const env = stringMap(v.env);
	if (env) out.env = env;
	const shell = shellConfig(v.shell);
	if (shell) out.shell = shell;
	return out;
}

/** VS Code's CommandOptions.assignProperties: `source` wins, env merged key by key. */
export function assignOptions(target: CommandOptions | undefined, source: CommandOptions | undefined): CommandOptions {
	if (!source) return { ...target };
	if (!target) return { ...source };
	const out: CommandOptions = { ...target };
	if (source.cwd !== undefined) out.cwd = source.cwd;
	if (source.env) out.env = { ...target.env, ...source.env };
	if (source.shell) out.shell = { ...target.shell, ...source.shell };
	return out;
}

/** VS Code's fillProperties for the global options: the task's own values win. */
function fillOptions(task: CommandOptions, global: CommandOptions | undefined): CommandOptions {
	if (!global) return task;
	return { cwd: task.cwd ?? global.cwd, env: global.env || task.env ? { ...global.env, ...task.env } : undefined, shell: task.shell ?? global.shell };
}

function presentationProps(v: unknown): Partial<Presentation> | undefined {
	if (!isObject(v)) return undefined;
	const out: Partial<Presentation> = {};
	if (typeof v.echo === 'boolean') out.echo = v.echo;
	if (isString(v.reveal) && ['always', 'silent', 'never'].includes(v.reveal.toLowerCase())) out.reveal = v.reveal.toLowerCase() as Reveal;
	if (isString(v.revealProblems)) {
		const r = v.revealProblems.toLowerCase();
		out.revealProblems = r === 'onproblem' ? 'onProblem' : r === 'always' ? 'always' : 'never';
	}
	if (typeof v.focus === 'boolean') out.focus = v.focus;
	if (isString(v.panel) && ['shared', 'dedicated', 'new'].includes(v.panel.toLowerCase())) out.panel = v.panel.toLowerCase() as PanelKind;
	if (typeof v.showReuseMessage === 'boolean') out.showReuseMessage = v.showReuseMessage;
	if (typeof v.clear === 'boolean') out.clear = v.clear;
	if (isString(v.group)) out.group = v.group;
	if (typeof v.close === 'boolean') out.close = v.close;
	return out;
}

function groupOf(v: unknown): TaskGroup | undefined {
	if (isString(v)) return v === 'none' ? undefined : { kind: v, isDefault: false };
	if (isObject(v) && isString(v.kind)) return { kind: v.kind, isDefault: typeof v.isDefault === 'boolean' || isString(v.isDefault) ? v.isDefault : false };
	return undefined;
}

function dependsOnOf(v: unknown): TaskRef[] {
	if (isString(v)) return [v];
	if (isObject(v)) return [v];
	if (Array.isArray(v)) return v.filter((x): x is TaskRef => isString(x) || isObject(x));
	return [];
}

function runOptionsOf(v: unknown): RunOptions {
	const out = { ...DEFAULT_RUN_OPTIONS };
	if (!isObject(v)) return out;
	if (v.runOn === 'folderOpen') out.runOn = 'folderOpen';
	if (typeof v.reevaluateOnRerun === 'boolean') out.reevaluateOnRerun = v.reevaluateOnRerun;
	if (typeof v.instanceLimit === 'number' && v.instanceLimit >= 1) out.instanceLimit = Math.floor(v.instanceLimit);
	if (isString(v.instancePolicy) && ['prompt', 'terminateNewest', 'terminateOldest', 'warn', 'silent'].includes(v.instancePolicy)) out.instancePolicy = v.instancePolicy as RunOptions['instancePolicy'];
	return out;
}

type CommandProps = { runtime?: 'shell' | 'process'; command?: CommandString; args?: CommandString[]; options?: CommandOptions; presentation?: Partial<Presentation> };

/** VS Code's CommandConfiguration.fromBase: the command part of a task or of its OS override. */
function commandProps(v: Record<string, unknown>, errors: string[]): CommandProps {
	const out: CommandProps = {};
	if (v.type === 'shell' || v.type === 'process') out.runtime = v.type;
	const command = commandString(v.command);
	if (command !== undefined) out.command = command;
	if (v.args !== undefined) {
		out.args = [];
		for (const arg of Array.isArray(v.args) ? v.args : [v.args]) {
			const c = commandString(arg);
			if (c !== undefined) out.args.push(c);
			else errors.push(t('ideTasks.config.badArg', { value: JSON.stringify(arg, undefined, 4) }));
		}
	}
	const options = commandOptions(v.options, errors);
	if (options) out.options = options;
	const presentation = presentationProps(v.presentation ?? v.terminal);
	if (presentation) out.presentation = presentation;
	return out;
}

/** The task's command with the platform's override laid over it (args replaced, options merged). */
function withPlatform(v: Record<string, unknown>, platform: Platform, errors: string[]): CommandProps {
	const base = commandProps(v, errors);
	const os = v[platform];
	if (!isObject(os)) return base;
	const over = commandProps(os, errors);
	return {
		runtime: over.runtime ?? base.runtime,
		command: over.command ?? base.command,
		args: over.args ?? base.args,
		options: over.options ? assignOptions(base.options, over.options) : base.options,
		presentation: over.presentation ? { ...base.presentation, ...over.presentation } : base.presentation
	};
}

/** The configured properties every task kind shares (custom or customization). */
function sharedProps(v: Record<string, unknown>, platform: Platform, errors: string[]): Partial<Task> {
	const cmd = withPlatform(v, platform, errors);
	const props: Partial<Task> = {};
	if (cmd.command !== undefined) props.command = cmd.command;
	if (cmd.args !== undefined) props.args = cmd.args;
	if (cmd.options) props.options = cmd.options;
	if (cmd.presentation) props.presentation = { ...DEFAULT_PRESENTATION, ...cmd.presentation };
	if (cmd.runtime) props.runtime = cmd.runtime;
	const group = groupOf(v.group);
	if (group) props.group = group;
	else if (v.isBuildCommand === true) props.group = { kind: 'build', isDefault: true };
	else if (v.isTestCommand === true) props.group = { kind: 'test', isDefault: true };
	if (v.dependsOn !== undefined) props.dependsOn = dependsOnOf(v.dependsOn);
	if (v.dependsOrder === 'sequence' || v.dependsOrder === 'parallel') props.dependsOrder = v.dependsOrder;
	if (v.problemMatcher !== undefined) props.problemMatcher = v.problemMatcher;
	if (typeof v.isBackground === 'boolean') props.isBackground = v.isBackground;
	if (typeof v.promptOnClose === 'boolean') props.promptOnClose = v.promptOnClose;
	if (v.runOptions !== undefined) props.runOptions = runOptionsOf(v.runOptions);
	if (isString(v.detail)) props.detail = v.detail;
	if (typeof v.hide === 'boolean') props.hide = v.hide;
	return props;
}

export function platformOf(os: string): Platform {
	return os === 'windows' || os === 'win32' ? 'windows' : os === 'linux' ? 'linux' : 'osx';
}

/** The `inputs` of tasks.json or launch.json (VS Code: inputs schema of the configuration resolver). */
export function parseInputs(v: unknown, errors: string[]): InputDef[] {
	if (!Array.isArray(v)) return [];
	const out: InputDef[] = [];
	for (const raw of v) {
		if (!isObject(raw) || !isString(raw.id)) continue;
		const description = isString(raw.description) ? raw.description : undefined;
		if (raw.type === 'promptString') out.push({ id: raw.id, type: 'promptString', description, default: isString(raw.default) ? raw.default : undefined, password: raw.password === true });
		else if (raw.type === 'pickString') {
			const options = (Array.isArray(raw.options) ? raw.options : []).flatMap((o) => (isString(o) ? [{ value: o }] : isObject(o) && isString(o.value) ? [{ label: isString(o.label) ? o.label : undefined, value: o.value }] : []));
			if (!options.length) errors.push(t('ideTasks.config.pickOptions', { id: raw.id }));
			out.push({ id: raw.id, type: 'pickString', description, options, default: isString(raw.default) ? raw.default : undefined });
		} else if (raw.type === 'command' && isString(raw.command)) out.push({ id: raw.id, type: 'command', command: raw.command, args: raw.args });
		else errors.push(t('ideTasks.config.inputType', { id: raw.id }));
	}
	return out;
}

/** A custom task from its configured properties (defaults filled in). */
export function customTask(label: string, type: 'shell' | 'process', props: Partial<Task>): Task {
	return {
		id: label,
		label,
		type,
		source: 'Workspace',
		args: [],
		options: {},
		presentation: { ...DEFAULT_PRESENTATION },
		dependsOn: [],
		dependsOrder: 'parallel',
		isBackground: false,
		promptOnClose: !!props.isBackground,
		runOptions: { ...DEFAULT_RUN_OPTIONS },
		hide: false,
		configured: true,
		...props,
		runtime: props.command !== undefined ? (props.runtime ?? type) : undefined
	};
}

/** Parses tasks.json text for `platform`; `source` names the file in errors. */
export function parseTasksJson(text: string, platform: Platform, source = '.vscode/tasks.json'): TasksFile {
	const errors: string[] = [];
	let raw: unknown;
	try {
		raw = text.trim() ? parseJsonc(text) : {};
	} catch (e) {
		return { tasks: [], customizations: [], inputs: [], errors: [t('ideTasks.config.badJson', { source, error: e instanceof Error ? e.message : String(e) })] };
	}
	if (!isObject(raw)) return { tasks: [], customizations: [], inputs: [], errors: [t('ideTasks.config.notObject', { source })] };
	if (raw.version !== undefined && raw.version !== '2.0.0') errors.push(t('ideTasks.config.version', { source, version: JSON.stringify(raw.version) }));
	// Top-level options / presentation (and their OS override) fill in what a task leaves out.
	const global = withPlatform({ options: raw.options, presentation: raw.presentation, ...(isObject(raw[platform]) ? { [platform]: { options: (raw[platform] as Record<string, unknown>).options, presentation: (raw[platform] as Record<string, unknown>).presentation } } : {}) }, platform, errors);
	const tasks: Task[] = [];
	const customizations: Customization[] = [];
	const list = Array.isArray(raw.tasks) ? raw.tasks : [];
	for (const item of list) {
		if (!isObject(item)) continue;
		const props = sharedProps(item, platform, errors);
		props.options = fillOptions(props.options ?? {}, global.options);
		if (global.presentation) props.presentation = { ...DEFAULT_PRESENTATION, ...global.presentation, ...(props.presentation ? stripDefaults(item, platform) : {}) };
		const label = isString(item.label) ? item.label : isString(item.taskName) ? item.taskName : undefined;
		const type = isString(item.type) ? item.type : 'process';
		if (type === 'shell' || type === 'process') {
			if (!label) {
				errors.push(t('ideTasks.config.noLabel', { json: JSON.stringify(item, null, 4) }));
				continue;
			}
			if (props.command === undefined && !props.dependsOn?.length) {
				errors.push(t('ideTasks.config.noCommand', { label }));
				continue;
			}
			if (tasks.some((t) => t.label === label)) errors.push(t('ideTasks.config.duplicate', { label }));
			else tasks.push(customTask(label, type, props));
		} else {
			const definition: Record<string, unknown> = { type };
			for (const [k, v] of Object.entries(item)) if (!TASK_PROPS.has(k)) definition[k] = v;
			customizations.push({ definition, props, label });
		}
	}
	return { tasks, customizations, inputs: parseInputs(raw.inputs, errors), errors };
}

/** A task's own presentation properties (without defaults), so the global ones fill only the rest. */
function stripDefaults(item: Record<string, unknown>, platform: Platform): Partial<Presentation> {
	const os = isObject(item[platform]) ? presentationProps((item[platform] as Record<string, unknown>).presentation) : undefined;
	return { ...presentationProps(item.presentation ?? item.terminal), ...os };
}

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether a detected task is the one a tasks.json identifier names (every identifying property equal). */
export function matchesDefinition(task: Task, definition: Record<string, unknown>): boolean {
	if (!task.definition || task.definition.type !== definition.type) return false;
	return Object.entries(definition).every(([k, v]) => k === 'type' || deepEqual(task.definition![k] ?? defaultIdentity(k), v ?? defaultIdentity(k)));
}

/** Identity properties a detector leaves out when they are empty (npm's `path`). */
const defaultIdentity = (key: string) => (key === 'path' ? '' : undefined);

/** Lays a customization over the detected task it names (VS Code: the configured task wins). */
export function customize(task: Task, c: Customization): Task {
	const props = c.props;
	const out: Task = { ...task, ...props, configured: true, options: props.options ? assignOptions(task.options, props.options) : task.options };
	if (c.label) out.label = c.label;
	// A detected task's command stays unless the customization gives its own.
	if (props.command === undefined) {
		out.command = task.command;
		out.args = props.args ?? task.args;
		out.runtime = task.runtime;
	}
	return out;
}

/**
 * Every task of the folder: the custom ones, then the detected ones with their customizations
 * applied. A customization that names no detected task becomes a task of its own when `build`
 * can make one from the identifier (e.g. npm with autoDetect off), else an error.
 */
export function mergeTasks(file: TasksFile, detected: Task[], build: (definition: Record<string, unknown>) => Task | null): { tasks: Task[]; errors: string[] } {
	const errors = [...file.errors];
	const out: Task[] = [...file.tasks];
	const result = detected.map((t) => {
		const c = file.customizations.find((c) => matchesDefinition(t, c.definition));
		return c ? customize(t, c) : t;
	});
	for (const c of file.customizations) {
		if (detected.some((t) => matchesDefinition(t, c.definition))) continue;
		const made = build(c.definition);
		if (made) out.push(customize(made, c));
		else errors.push(t('ideTasks.config.notContributed', { type: String(c.definition.type), json: JSON.stringify(c.definition, null, 4) }));
	}
	const labels = new Set(out.map((t) => t.label));
	return { tasks: [...out, ...result.filter((t) => !labels.has(t.label))], errors };
}

// --- Looking tasks up ------------------------------------------------------------------------------

/** A `dependsOn` / `preLaunchTask` reference → the task it names (label, else identifier). */
export function findTask(tasks: Task[], ref: TaskRef): Task | undefined {
	if (isString(ref)) return tasks.find((t) => t.label === ref) ?? tasks.find((t) => t.id === ref);
	if (isString(ref.task) && ref.type === undefined) return tasks.find((t) => t.label === ref.task);
	return tasks.find((t) => matchesDefinition(t, ref)) ?? (isString(ref.label) ? tasks.find((t) => t.label === ref.label) : undefined);
}

/** The tasks of a group (`build`, `test`), and the default one VS Code runs without asking. */
export function groupTasks(tasks: Task[], kind: string, activeFile?: string): { all: Task[]; defaults: Task[] } {
	const all = tasks.filter((t) => t.group?.kind === kind);
	const defaults = all.filter((t) => t.group?.isDefault === true || (typeof t.group?.isDefault === 'string' && !!activeFile && globMatch(t.group.isDefault, activeFile)));
	return { all, defaults };
}

/** A minimal glob for `isDefault: "**\/*.ts"` (VS Code matches it against the active file's path). */
export function globMatch(glob: string, path: string): boolean {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*' && glob[i + 1] === '*') {
			re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
			i += glob[i + 2] === '/' ? 2 : 1;
		} else if (c === '*') re += '[^/]*';
		else if (c === '?') re += '[^/]';
		else if (c === '{') re += '(?:';
		else if (c === '}') re += ')';
		else if (c === ',') re += '|';
		else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${re}$`).test(path) || new RegExp(`(?:^|/)${re}$`).test(path);
}
