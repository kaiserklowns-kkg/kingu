// Tasks and launch configurations of a multi-root workspace (VS Code: each folder's
// .vscode/tasks.json and launch.json, plus the `.code-workspace` file's own `tasks` and `launch`).
// A task belongs to its folder: its variables, default cwd and dependsOn resolve there. Ids stay as
// they were for the first folder (a single-folder window sees no change); another folder's ids
// carry the folder's path, a workspace file's ids the workspace prefix. Pure.

import { parseJsonc } from '#lib/settings/jsonc.ts';
import { folderOf, type WorkspaceFolder } from '#lib/workbench/workspaceFolders.ts';
import { findTask, type Task, type TaskRef } from './taskConfig.ts';

/** The id prefix of a `.code-workspace` file's tasks. */
export const WORKSPACE_SCOPE = 'workspace';

const trim = (p: string) => p.replace(/\/+$/, '') || '/';

/** `list` as tasks of `folder` (null: the workspace file); `first` keeps the ids unchanged. */
export function scopeTasks(list: Task[], folder: WorkspaceFolder | null, first: boolean): Task[] {
	return list.map((task) => ({
		...task,
		folder: folder?.path,
		id: first && folder ? task.id : `${folder ? folder.path : WORKSPACE_SCOPE}::${task.id}`
	}));
}

/** The paths of `folder`'s files, relative to it, out of the workbench's file list (relative: the first folder; absolute: another). */
export function filesInFolder(files: Iterable<string>, folder: WorkspaceFolder, folders: readonly WorkspaceFolder[]): Set<string> {
	const out = new Set<string>();
	const first = folders[0]?.path === folder.path;
	const prefix = `${trim(folder.path)}/`;
	for (const f of files) {
		if (!f.startsWith('/')) {
			if (first) out.add(f);
		} else if (f.startsWith(prefix) && folderOf(f, folders)?.path === folder.path) out.add(f.slice(prefix.length));
	}
	return out;
}

/** The workbench path of `rel` inside `folder` (relative in the first folder, absolute in another). */
export function folderKey(rel: string, folder: WorkspaceFolder, folders: readonly WorkspaceFolder[]): string {
	return folders[0]?.path === folder.path ? rel : `${trim(folder.path)}/${rel}`;
}

/** A `dependsOn` / `preLaunchTask` reference from `from` (a task, or a launch configuration's folder): a task of the same folder first (VS Code), then any. */
export function findTaskFrom(tasks: Task[], ref: TaskRef, from?: { folder?: string }): Task | undefined {
	if (from) {
		const own = findTask(
			tasks.filter((t) => t.folder === from.folder),
			ref
		);
		if (own) return own;
	}
	return findTask(tasks, ref);
}

/** What a picker shows next to a task in a multi-root workspace: its folder's name, or `workspace` for the workspace file's. Nothing with one folder. */
export function taskFolderLabel(task: Pick<Task, 'folder'>, folders: readonly WorkspaceFolder[], workspace: string): string | undefined {
	if (folders.length < 2) return undefined;
	if (task.folder === undefined) return workspace;
	return folders.find((f) => f.path === task.folder)?.name;
}

/** The id of the `.code-workspace` file's row in a folder picker. */
export const WORKSPACE_PICK = '\0workspace';

/**
 * The rows of a "which folder" picker (VS Code's pickFolder for tasks.json / launch.json): each
 * root folder, then the `.code-workspace` file (`workspaceFile`; its own `tasks` / `launch`).
 */
export function folderPickItems(folders: readonly WorkspaceFolder[], workspaceFile: string | null, workspaceLabel: string): { id: string; label: string; description: string }[] {
	const rows = folders.map((f) => ({ id: f.path, label: f.name, description: f.path }));
	return workspaceFile ? [...rows, { id: WORKSPACE_PICK, label: workspaceLabel, description: workspaceFile }] : rows;
}

/** The folder a task's variables and cwd use: its own; a workspace file's task has none. */
export function taskFolder(task: Pick<Task, 'folder'>, folders: readonly WorkspaceFolder[]): WorkspaceFolder | undefined {
	return task.folder === undefined ? undefined : (folders.find((f) => f.path === task.folder) ?? { path: task.folder, name: task.folder.slice(task.folder.lastIndexOf('/') + 1) });
}

/**
 * Where a task starts: `options.cwd` (already substituted; relative to the task's folder), else the
 * task's folder, else (a workspace file's task) the first folder.
 */
export function taskCwd(cwd: string | undefined, folder: string | undefined, folders: readonly WorkspaceFolder[]): string {
	const base = folder ?? folders[0]?.path ?? '';
	if (!cwd) return base;
	return cwd.startsWith('/') ? cwd : `${trim(base)}/${cwd}`;
}

/**
 * The `tasks` or `launch` object of a `.code-workspace` file, as the text of a tasks.json /
 * launch.json (VS Code reads them as workspace-scoped configuration); null when it has none.
 */
export function workspaceFileSection(text: string, key: 'tasks' | 'launch'): string | null {
	let raw: unknown;
	try {
		raw = parseJsonc(text);
	} catch {
		return null;
	}
	const section = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)[key] : undefined;
	return section && typeof section === 'object' && !Array.isArray(section) ? JSON.stringify(section) : null;
}
