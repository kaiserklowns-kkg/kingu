/// <reference types="bun" />
// Multi-root tasks (VS Code docs: multi-root-workspaces.md, "Tasks" and "Debugging"; variables
// reference, "Variables scoped per workspace folder").
import { describe, expect, test } from 'bun:test';
import { npmTask } from './detect.ts';
import { customTask } from './taskConfig.ts';
import { filesInFolder, findTaskFrom, folderKey, folderPickItems, scopeTasks, taskCwd, taskFolder, taskFolderLabel, WORKSPACE_PICK, workspaceFileSection } from './folders.ts';
import { substitute, type VariableContext } from './variables.ts';

const app = { path: '/w/app', name: 'app' };
const lib = { path: '/w/lib', name: 'Library' };
const folders = [app, lib];

describe('tasks of several root folders', () => {
	test('the first folder keeps its ids; another folder and the workspace file get their own', () => {
		const [a] = scopeTasks([customTask('build', 'shell', { command: 'make' })], app, true);
		const [b] = scopeTasks([customTask('build', 'shell', { command: 'make' })], lib, false);
		const [w] = scopeTasks([customTask('build', 'shell', { command: 'make' })], null, false);
		expect(a).toMatchObject({ id: 'build', folder: '/w/app' });
		expect(b).toMatchObject({ id: '/w/lib::build', folder: '/w/lib', label: 'build' });
		expect(w.id).toBe('workspace::build');
		expect(w.folder).toBeUndefined();
		expect(new Set([a.id, b.id, w.id]).size).toBe(3);
	});

	test('dependsOn names a task of the same folder first, then any folder', () => {
		const list = [
			...scopeTasks([customTask('build', 'shell', { command: 'a' }), customTask('lint', 'shell', { command: 'l' })], app, true),
			...scopeTasks([customTask('build', 'shell', { command: 'b' })], lib, false),
			...scopeTasks([customTask('all', 'shell', { dependsOn: ['build'] })], null, false)
		];
		const libTask = list.find((x) => x.folder === '/w/lib')!;
		expect(findTaskFrom(list, 'build', libTask)?.command).toBe('b');
		expect(findTaskFrom(list, 'build', list[1])?.command).toBe('a');
		expect(findTaskFrom(list, 'lint', libTask)?.folder).toBe('/w/app');
		// A workspace file's task: its own scope has no `build`, so the first one found.
		expect(findTaskFrom(list, 'build', list[3])?.command).toBe('a');
		expect(findTaskFrom(list, 'nope', libTask)).toBeUndefined();
	});

	test("each folder's files, relative to it, out of the workbench file list", () => {
		const all = ['package.json', 'src/a.ts', '/w/lib/package.json', '/w/lib/src/b.ts', '/w/app2/x.ts'];
		expect([...filesInFolder(all, app, folders)]).toEqual(['package.json', 'src/a.ts']);
		expect([...filesInFolder(all, lib, folders)]).toEqual(['package.json', 'src/b.ts']);
		expect(folderKey('package.json', app, folders)).toBe('package.json');
		expect(folderKey('.vscode/tasks.json', lib, folders)).toBe('/w/lib/.vscode/tasks.json');
	});

	test('a task starts in its folder (options.cwd relative to it); a workspace file task in the first', () => {
		expect(taskCwd(undefined, '/w/lib', folders)).toBe('/w/lib');
		expect(taskCwd('sub', '/w/lib', folders)).toBe('/w/lib/sub');
		expect(taskCwd('/tmp', '/w/lib', folders)).toBe('/tmp');
		expect(taskCwd(undefined, undefined, folders)).toBe('/w/app');
		expect(taskFolder({ folder: '/w/lib' }, folders)).toEqual(lib);
		expect(taskFolder({}, folders)).toBeUndefined();
	});

	test('pickers show the folder only with several folders', () => {
		expect(taskFolderLabel({ folder: '/w/lib' }, folders, 'Workspace')).toBe('Library');
		expect(taskFolderLabel({}, folders, 'Workspace')).toBe('Workspace');
		expect(taskFolderLabel({ folder: '/w/app' }, [app], 'Workspace')).toBeUndefined();
	});

	test("a .code-workspace file's tasks and launch sections", () => {
		const text = '{ "folders": [{ "path": "app" }], // c\n "tasks": { "version": "2.0.0", "tasks": [{ "label": "x", "type": "shell", "command": "y" }] }, "launch": { "configurations": [] } }';
		expect(JSON.parse(workspaceFileSection(text, 'tasks')!).tasks[0].label).toBe('x');
		expect(JSON.parse(workspaceFileSection(text, 'launch')!)).toEqual({ configurations: [] });
		expect(workspaceFileSection('{ "folders": [] }', 'tasks')).toBeNull();
		expect(workspaceFileSection('{ nope', 'tasks')).toBeNull();
	});
});

describe('variables in a multi-root workspace', () => {
	const ctx: VariableContext = { workspaceFolder: '/w/lib', folders, file: '/w/app/src/main.ts', env: {}, config: () => undefined };

	test("${workspaceFolder} is the task's own folder; ${workspaceFolder:name} any folder by name", () => {
		expect(substitute(['${workspaceFolder}', '${workspaceFolderBasename}', '${workspaceFolder:app}/x', '${workspaceFolderBasename:Library}', '${cwd}', '${cwd:app}'], ctx)).toEqual([
			'/w/lib',
			'lib',
			'/w/app/x',
			'lib',
			'/w/lib',
			'/w/app'
		]);
	});

	test("${fileWorkspaceFolder} is the active file's folder; ${relativeFile} is relative to the variable's folder", () => {
		expect(substitute('${fileWorkspaceFolder}', ctx)).toBe('/w/app');
		expect(substitute('${fileWorkspaceFolderBasename}', ctx)).toBe('app');
		// The file is not in the task's folder: VS Code gives the path as is.
		expect(substitute('${relativeFile}', ctx)).toBe('/w/app/src/main.ts');
		expect(substitute(['${relativeFile:app}', '${relativeFileDirname:app}'], ctx)).toEqual(['src/main.ts', 'src']);
		expect(() => substitute('${fileWorkspaceFolder}', { ...ctx, file: '/elsewhere/x.ts' })).toThrow(/not in the workspace folder/);
	});

	test("a workspace file's task must scope ${workspaceFolder} with a folder name", () => {
		const ws: VariableContext = { ...ctx, workspaceFolder: undefined };
		expect(() => substitute('${workspaceFolder}', ws)).toThrow(/multi folder workspace/);
		expect(substitute('${workspaceFolder:Library}', ws)).toBe('/w/lib');
		expect(substitute('${relativeFile}', ws)).toBe('/w/app/src/main.ts');
		expect(substitute('${cwd}', ws)).toBe('/w/app');
		expect(() => substitute('${workspaceFolder}', { ...ws, folders: [] })).toThrow(/open a folder/);
		expect(() => substitute('${file:x}', ws)).toThrow(/can not be resolved/);
	});

	test("a detected task's cwd follows its folder", () => {
		const [npm] = scopeTasks([npmTask('build', 'packages/ui', 'bun')], lib, false);
		expect(substitute(npm.options.cwd, { ...ctx, workspaceFolder: npm.folder })).toBe('/w/lib/packages/ui');
	});
});

describe('which folder a tasks.json / launch.json is for', () => {
	test('each root folder, then the workspace file when there is one', () => {
		expect(folderPickItems(folders, null, 'Workspace').map((i) => [i.id, i.label])).toEqual([
			['/w/app', 'app'],
			['/w/lib', 'Library']
		]);
		const items = folderPickItems(folders, '/w/all.code-workspace', 'Workspace');
		expect(items.at(-1)).toEqual({ id: WORKSPACE_PICK, label: 'Workspace', description: '/w/all.code-workspace' });
		expect(items).toHaveLength(3);
	});
});
