// Writing tasks.json (VS Code: abstractTaskService.ts customize / Configure Task / Configure Default
// Build Task, taskTemplates.ts): a task's entry gets the new properties, a detected task gets an
// entry of its own (its identifier plus the properties), and a folder without the file gets the
// "Others" template. Comments outside the `tasks` array are kept. Pure.

import { parseJsonc, setProperty } from '#lib/settings/jsonc.ts';
import { matchesDefinition, type Task } from './taskConfig.ts';

export const TASKS_PATH = '.vscode/tasks.json';

/** VS Code's "Others" template (taskTemplates.ts). */
export const TEMPLATE = `{
	// See https://go.microsoft.com/fwlink/?LinkId=733558
	// for the documentation about the tasks.json format
	"version": "2.0.0",
	"tasks": [
		{
			"label": "echo",
			"type": "shell",
			"command": "echo Hello"
		}
	]
}
`;

const EMPTY = `{
	// See https://go.microsoft.com/fwlink/?LinkId=733558
	// for the documentation about the tasks.json format
	"version": "2.0.0",
	"tasks": []
}
`;

const PLACEHOLDER = '__kingu_tasks_value__';

/** `setProperty` with the value pretty-printed (tabs) at the property's indentation. */
function setPretty(text: string, key: string, value: unknown): string {
	const marked = setProperty(text, key, PLACEHOLDER);
	const at = marked.indexOf(JSON.stringify(PLACEHOLDER));
	const lineStart = marked.lastIndexOf('\n', at) + 1;
	const indent = /^[ \t]*/.exec(marked.slice(lineStart))?.[0] ?? '';
	const pretty = JSON.stringify(value, null, '\t').replace(/\n/g, `\n${indent}`);
	return marked.slice(0, at) + pretty + marked.slice(at + JSON.stringify(PLACEHOLDER).length);
}

type Entry = Record<string, unknown>;

function read(text: string | null): { text: string; tasks: Entry[] } {
	const base = text?.trim() ? text : EMPTY;
	let raw: unknown;
	try {
		raw = parseJsonc(base);
	} catch {
		raw = null;
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { text: EMPTY, tasks: [] };
	const tasks = (raw as { tasks?: unknown }).tasks;
	let out = base;
	if ((raw as { version?: unknown }).version === undefined) out = setProperty(out, 'version', '2.0.0');
	return { text: out, tasks: Array.isArray(tasks) ? tasks.filter((t): t is Entry => !!t && typeof t === 'object' && !Array.isArray(t)) : [] };
}

/** The tasks.json entry that defines or customizes `task`. */
export function entryIndex(entries: Entry[], task: Task): number {
	if (task.definition) {
		const i = entries.findIndex((e) => typeof e.type === 'string' && e.type === task.definition!.type && matchesDefinition(task, identity(e)));
		if (i >= 0) return i;
	}
	return entries.findIndex((e) => (e.label ?? e.taskName) === task.label && (e.type === 'shell' || e.type === 'process' || e.type === undefined));
}

const NOT_IDENTITY = new Set(['label', 'group', 'problemMatcher', 'presentation', 'options', 'dependsOn', 'dependsOrder', 'isBackground', 'runOptions', 'detail', 'hide', 'icon', 'command', 'args', 'osx', 'linux', 'windows', 'promptOnClose']);

function identity(e: Entry): Record<string, unknown> {
	return Object.fromEntries(Object.entries(e).filter(([k]) => !NOT_IDENTITY.has(k)));
}

/** The entry a detected task gets when it is customized (VS Code writes its identifier, label and detail). */
export function customizationEntry(task: Task, props: Entry): Entry {
	const entry: Entry = { ...(task.definition ?? { type: task.type }) };
	Object.assign(entry, props);
	entry.label ??= task.label;
	if (task.detail && entry.detail === undefined) entry.detail = task.detail;
	return entry;
}

/** tasks.json text with `props` set on `task`'s entry (one is added for a detected task). */
export function customizeText(text: string | null, task: Task, props: Entry): string {
	const { text: base, tasks } = read(text);
	const i = entryIndex(tasks, task);
	const next = [...tasks];
	if (i >= 0) next[i] = { ...tasks[i], ...props };
	else next.push(customizationEntry(task, props));
	return setPretty(base, 'tasks', next);
}

/**
 * Configure Default Build / Test Task: `task` becomes the group's default; other defaults of the
 * group become plain members (VS Code's group: "build").
 */
export function setDefaultGroupText(text: string | null, task: Task, kind: string): string {
	const { text: base, tasks } = read(text);
	let next = tasks.map((e) => {
		const g = e.group;
		const isDefault = typeof g === 'object' && g !== null && (g as Entry).kind === kind && (g as Entry).isDefault;
		return isDefault ? { ...e, group: kind } : e;
	});
	const i = entryIndex(next, task);
	const group = { kind, isDefault: true };
	if (i >= 0) next[i] = { ...next[i], group };
	else next = [...next, customizationEntry(task, { group, problemMatcher: task.problemMatcher ?? [] })];
	return setPretty(base, 'tasks', next);
}

/** Configure Task: the file with `task`'s entry present (added for a detected task, as VS Code does). */
export function configureText(text: string | null, task: Task): string {
	const { text: base, tasks } = read(text);
	if (entryIndex(tasks, task) >= 0) return base;
	const props: Entry = { problemMatcher: task.problemMatcher ?? [] };
	if (task.group) props.group = task.group.isDefault ? { kind: task.group.kind, isDefault: true } : task.group.kind;
	return setPretty(base, 'tasks', [...tasks, customizationEntry(task, props)]);
}
