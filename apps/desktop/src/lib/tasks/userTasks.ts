// User tasks (VS Code: Tasks: Open User Tasks): a tasks.json in the profile folder of the app
// config dir (Rust settings scope `tasks`), offered in every folder after the workspace's own.

import type { Task, TaskRef } from './taskConfig.ts';

/** Editor tab key of the user tasks.json (outside the workspace, like the user settings.json). */
export const USER_TASKS_KEY = 'settings://user/tasks.json';

export const USER_TASKS_TEMPLATE = `{
	// User tasks: offered in every folder. See https://go.microsoft.com/fwlink/?LinkId=733558
	"version": "2.0.0",
	"tasks": []
}
`;

/** User tasks get their own ids (a workspace task of the same label stays apart) and source. */
export function scopeUserTasks(list: Task[]): Task[] {
	return list.map((task) => ({ ...task, folder: undefined, id: `user::${task.id}`, source: 'User' }));
}

/** Run Task's keybindings.json `args` (VS Code): a task label, or a task identifier such as
 * `{ "type": "npm", "script": "build" }` (also `{ "task": "label" }`). */
export function taskArg(args: unknown): TaskRef | undefined {
	if (typeof args === 'string') return args.trim() ? args : undefined;
	if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
	const o = args as Record<string, unknown>;
	if (typeof o.task === 'string' && o.type === undefined) return o.task;
	return Object.keys(o).length ? o : undefined;
}
