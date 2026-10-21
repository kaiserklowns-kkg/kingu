// VS Code's Tasks commands (task.contribution.ts / abstractTaskService.ts): Run Task, Run Build
// Task (⇧⌘B), Run Test Task, Rerun Last Task, Terminate Task, Restart Running Task, Show Running
// Tasks, Configure Task, Configure Default Build / Test Task, Open Workspace Tasks, Show Task Log,
// and the automatic tasks of a folder when it opens.

import { untrack } from 'svelte';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { focusedTerminal } from '#lib/terminal/registry.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { quick, type PickItem } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { taskFolderLabel } from './folders.ts';
import { groupTasks, type Task } from './taskConfig.ts';
import { tasks } from './tasks.svelte.ts';

const CONFIGURE = '\0configure';
const TEMPLATE = '\0template';
const ALL = '\0all';

/** A picker row's description: the task's folder in a multi-root workspace (VS Code), then its detail. */
function describe(x: Task, showDetail: boolean): string | undefined {
	const parts = [taskFolderLabel(x, workspace.folders, t('ideTasks.pick.workspace')), showDetail ? x.detail : undefined].filter((p): p is string => !!p);
	return parts.length ? parts.join(' · ') : undefined;
}

/** The Run Task list (VS Code's quick pick with task.quickOpen.showAll): recently used, configured, then each provider's tasks. */
export function taskPickItems(list: Task[], recent: string[], showDetail: boolean): PickItem[] {
	const visible = list.filter((x) => !x.hide);
	const item = (x: Task, separator?: string): PickItem => ({ id: x.id, label: x.label, description: describe(x, showDetail), separator });
	const out: PickItem[] = [];
	// Recent entries are ids (an older one is a label).
	const recentTasks = recent.flatMap((l) => (visible.find((x) => x.id === l) ? visible.filter((x) => x.id === l) : visible.filter((x) => x.label === l).slice(0, 1)));
	recentTasks.forEach((x, i) => out.push(item(x, i === 0 ? t('ideTasks.pick.recent') : undefined)));
	const shown = new Set(recentTasks);
	const configured = visible.filter((x) => x.configured && !shown.has(x));
	configured.forEach((x, i) => out.push(item(x, i === 0 ? t('ideTasks.pick.configured') : undefined)));
	const bySource = new Map<string, Task[]>();
	for (const x of visible) if (!x.configured && !shown.has(x)) bySource.set(x.source, [...(bySource.get(x.source) ?? []), x]);
	for (const [source, group] of bySource) group.forEach((x, i) => out.push(item(x, i === 0 ? source : undefined)));
	return out;
}

async function pickTask(placeholder: string, list: Task[], opts: { recent?: boolean; configure?: string } = {}): Promise<Task | 'configure' | undefined> {
	const items: PickItem[] = opts.recent ? taskPickItems(list, tasks.recent, settings.get<boolean>('task.quickOpen.detail')) : list.filter((x) => !x.hide).map((x) => ({ id: x.id, label: x.label, description: describe(x, true) }));
	if (!items.length) {
		if (!opts.configure) return undefined;
		items.push({ id: CONFIGURE, label: opts.configure });
	} else if (settings.get<boolean>('task.quickOpen.skip') && items.length === 1) return list.find((x) => x.id === items[0].id);
	const picked = await quick.choose({ placeholder, items });
	if (!picked) return undefined;
	if (picked.id === CONFIGURE) return 'configure';
	return list.find((x) => x.id === picked.id);
}

/** Run Task. */
async function runTaskCommand() {
	const { tasks: list } = await tasks.getTasks();
	const picked = await pickTask(t('ideTasks.pick.task'), list, { recent: true, configure: t('ideTasks.pick.noTasks') });
	if (picked === 'configure') return configureTask();
	if (picked) await tasks.run(picked, { attachProblemMatcher: true });
}

/** Run Build Task / Run Test Task: the default one, else a pick among the group. */
async function runGroup(kind: 'build' | 'test') {
	const { tasks: list } = await tasks.getTasks();
	const { all, defaults } = groupTasks(list, kind, editors.active ?? undefined);
	if (defaults.length === 1) return void tasks.run(defaults[0], { attachProblemMatcher: true });
	const choices = defaults.length ? defaults : all;
	const picked = await pickTask(t(kind === 'build' ? 'ideTasks.pick.build' : 'ideTasks.pick.test'), choices, { configure: t(kind === 'build' ? 'ideTasks.pick.noBuild' : 'ideTasks.pick.noTest') });
	if (picked === 'configure') return configureDefault(kind);
	if (picked) await tasks.run(picked, { attachProblemMatcher: true });
}

/** A running task, picked when there are several (`all`: offer All Running Tasks). */
async function pickRunning(placeholder: string, all = false): Promise<Task | 'all' | undefined> {
	const running = [...tasks.active.values()].map((a) => a.task);
	if (!running.length) {
		status.flash(t('ideTasks.noRunning'));
		return undefined;
	}
	if (running.length === 1) return running[0];
	const items: PickItem[] = running.map((x) => ({ id: x.id, label: x.label, description: describe(x, true) }));
	if (all) items.push({ id: ALL, label: t('ideTasks.pick.allRunning') });
	const picked = await quick.choose({ placeholder, items });
	if (!picked) return undefined;
	return picked.id === ALL ? 'all' : running.find((x) => x.id === picked.id);
}

async function configureTask() {
	const { tasks: list, files } = await tasks.getTasks();
	const items: PickItem[] = list.filter((x) => !x.hide).map((x) => ({ id: x.id, label: x.label, description: describe(x, true) }));
	// A folder without tasks.json (multi-root: any of them) can get one from the template.
	if ([...files.values()].some((f) => f.text === null)) items.unshift({ id: TEMPLATE, label: t('ideTasks.pick.template') });
	if (!items.length) return tasks.configure('template');
	const picked = await quick.choose({ placeholder: t('ideTasks.pick.configure'), items });
	if (!picked) return;
	if (picked.id === TEMPLATE) return tasks.configure('template');
	const task = list.find((x) => x.id === picked.id);
	if (task) await tasks.configure(task);
}

async function configureDefault(kind: 'build' | 'test') {
	const { tasks: list } = await tasks.getTasks();
	if (!list.length) return tasks.configure('template');
	const group = list.filter((x) => x.group?.kind === kind);
	const rest = list.filter((x) => x.group?.kind !== kind);
	const picked = await pickTask(t(kind === 'build' ? 'ideTasks.pick.defaultBuild' : 'ideTasks.pick.defaultTest'), [...group, ...rest]);
	if (picked && picked !== 'configure') await tasks.setDefault(picked, kind);
}

export function installTaskCommands(): () => void {
	const ide = () => !appMode.isAgents && workspace.root !== null;
	const anyRunning = () => tasks.active.size > 0;
	const unregister = [
		commands.register({ id: 'workbench.action.tasks.runTask', title: 'Run Task', category: 'Tasks', when: ide, run: runTaskCommand }),
		commands.register({ id: 'workbench.action.tasks.build', title: 'Run Build Task', category: 'Tasks', key: 'cmd+shift+b', when: ide, run: () => runGroup('build') }),
		commands.register({ id: 'workbench.action.tasks.test', title: 'Run Test Task', category: 'Tasks', when: ide, run: () => runGroup('test') }),
		commands.register({
			id: 'workbench.action.tasks.reRunTask',
			title: 'Rerun Last Task',
			category: 'Tasks',
			when: ide,
			run: async () => {
				if (!(await tasks.rerun())) status.flash(t('ideTasks.noLastTask'));
			}
		}),
		commands.register({
			id: 'workbench.action.tasks.terminate',
			title: 'Terminate Task',
			category: 'Tasks',
			when: () => ide() && anyRunning(),
			run: async () => {
				const picked = await pickRunning(t('ideTasks.pick.terminate'), true);
				if (picked === 'all') tasks.terminateAll();
				else if (picked) tasks.terminate(picked);
			}
		}),
		commands.register({
			id: 'workbench.action.tasks.restartTask',
			title: 'Restart Running Task',
			category: 'Tasks',
			when: () => ide() && anyRunning(),
			run: async () => {
				const picked = await pickRunning(t('ideTasks.pick.restart'));
				if (picked && picked !== 'all') await tasks.restart(picked);
			}
		}),
		commands.register({
			id: 'workbench.action.tasks.showTasks',
			title: 'Show Running Tasks',
			category: 'Tasks',
			when: () => ide() && anyRunning(),
			run: async () => {
				const picked = await pickRunning(t('ideTasks.pick.show'));
				if (picked && picked !== 'all') tasks.show(picked);
			}
		}),
		commands.register({
			id: 'workbench.action.tasks.rerunForActiveTerminal',
			title: 'Rerun Task',
			category: 'Tasks',
			mac: 'ctrl+shift+r',
			key: 'cmd+shift+r',
			when: () => ide() && tasks.taskOfTerminal(terminals.active) !== undefined,
			keyWhen: () => focusedTerminal('ide') !== null,
			run: async () => {
				const key = tasks.taskOfTerminal(terminals.active);
				const { tasks: list } = await tasks.getTasks({ quiet: true });
				const task = list.find((x) => x.id === key);
				if (task) await tasks.run(task, { rerun: true });
			}
		}),
		commands.register({ id: 'workbench.action.tasks.configureTaskRunner', title: 'Configure Task', category: 'Tasks', when: ide, run: configureTask }),
		commands.register({ id: 'workbench.action.tasks.configureDefaultBuildTask', title: 'Configure Default Build Task', category: 'Tasks', when: ide, run: () => configureDefault('build') }),
		commands.register({ id: 'workbench.action.tasks.configureDefaultTestTask', title: 'Configure Default Test Task', category: 'Tasks', when: ide, run: () => configureDefault('test') }),
		commands.register({ id: 'workbench.action.tasks.openWorkspaceFileTasks', title: 'Open Workspace Tasks', category: 'Tasks', when: ide, run: () => tasks.openTasksFile() }),
		commands.register({ id: 'workbench.action.tasks.showLog', title: 'Show Task Log', category: 'Tasks', run: () => tasks.showLog() }),
		commands.register({ id: 'workbench.action.tasks.manageAutomaticRunning', title: 'Disallow Automatic Tasks', category: 'Tasks', when: ide, run: () => tasks.disallowAutomatic().then(() => status.flash(t('ideTasks.auto.disallowed'))) })
	];
	// A folder opens: its state starts over, and its automatic tasks run (runOn folderOpen).
	const stop = $effect.root(() => {
		$effect(() => {
			if (!workspace.ready) return;
			const root = workspace.root;
			untrack(() => {
				tasks.reset(root);
				if (root) void tasks.runAutomatic();
			});
		});
		// Multi-root: every folder's tasks.json and the workspace file's tasks; a folder added later
		// runs its automatic tasks then.
		$effect(() => {
			if (!workspace.ready) return;
			const folders = workspace.folders;
			const file = workspace.workspaceFile;
			untrack(() => {
				tasks.setScope(folders, file);
				if (folders.length) void tasks.runAutomatic();
			});
		});
	});
	const unwatch = workspace.onFilesChanged(() => tasks.filesChanged());
	return () => {
		unwatch();
		stop();
		unregister.forEach((u) => u());
	};
}
