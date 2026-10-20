// The task system (VS Code: abstractTaskService.ts + terminalTaskSystem.ts): reads
// .vscode/tasks.json and the detected tasks, resolves a task's variables and inputs, runs it
// after its dependsOn in a panel terminal (VS Code's task terminal naming and reuse: shared,
// dedicated, new, presentation.group splits), feeds the output to its problem matchers (the
// Problems panel, by matcher owner, replaced per run) and reports when it ends or, for a
// background task, when its watcher goes idle. Automatic tasks (runOn folderOpen) run only when
// the tasks.json they come from is trusted (tasks.rs).

import { invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import { clientLog } from '#lib/client-log.ts';
import { t } from '#lib/i18n/index.ts';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import type { Diagnostic } from '#lib/lsp/protocol.ts';
import { shellFrom, shellPlatform } from '#lib/settings/mappings.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { focusTerminal, tapOutput, terminalHandle, type TaskSpawn } from '#lib/terminal/registry.ts';
import { killPty } from '#lib/terminal/pty.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { output, TASKS_CHANNEL } from '#lib/output/output.svelte.ts';
import { choose } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { isDiffKey } from '#lib/workbench/scm.ts';
import { isUntitled } from '#lib/workbench/untitled.ts';
import { taskLaunch } from './commandLine.ts';
import { runTask, type Execution, type GraphHost, type Summary } from './dependencies.ts';
import { detectTasks, packageManagerFor, taskFromDefinition } from './detect.ts';
import { namedMatcher, parseProblemMatchers, resolveMatcher, type FileHost, type Marker } from './problemMatcher.ts';
import { StartStopCollector, WatchingCollector, type MarkerStore } from './problemCollector.ts';
import { findTask, groupTasks, mergeTasks, parseTasksJson, platformOf, type InputDef, type Task, type TaskRef } from './taskConfig.ts';
import { formatMessageForTerminal, TaskOutput } from './taskOutput.ts';
import { configureText, customizeText, setDefaultGroupText, TASKS_PATH, TEMPLATE } from './tasksFile.ts';
import { collectVariables, resolveInputs, substitute, VariableError, type InputPrompter, type VariableContext } from './variables.ts';

type TasksFileInfo = { text: string | null; hash: string | null; trusted: boolean };

/** A task that runs now. */
export type ActiveTask = {
	task: Task;
	key: string;
	terminalId: number;
	startedAt: number;
	/** A background task between its watcher's begins and ends. */
	busy: boolean;
	execution: Execution;
	terminate(): void;
};

/** Where a task terminal was last used (VS Code: _terminals with lastTask and group). */
type TerminalInfo = { taskKey: string; group?: string; idle: boolean };

const RECENT_KEY = 'kingu.tasks.recent';
const LOG_LIMIT = 2000;
/** VS Code delivers a watcher's markers 3 s after its output stops. */
const DELIVERY_MS = 3000;

const taskKey = (task: Task) => task.id;
const absolute = (root: string, rel: string) => `${root}/${rel}`;

/** A marker of task output as an LSP diagnostic for the Problems panel (0-based). */
export function markerToDiagnostic(m: Marker): Diagnostic {
	const pos = (line: number, col: number) => ({ line: Math.max(0, line - 1), character: Math.max(0, Math.min(col, 2 ** 31 - 1) - 1) });
	return {
		range: { start: pos(m.startLineNumber, m.startColumn), end: pos(m.endLineNumber, m.endColumn) },
		severity: m.severity === 'error' ? 1 : m.severity === 'warning' ? 2 : 3,
		message: m.message,
		source: m.source,
		code: m.code
	};
}

/** The Problems panel as the collectors' markers service. */
const markerStore: MarkerStore = {
	resources: (owner) => lsp.ownedPaths(owner),
	change: (owner, resource, markers) => lsp.setOwnedDiagnostics(owner, resource, markers.map(markerToDiagnostic)),
	remove: (owner, resources) => resources.forEach((r) => lsp.setOwnedDiagnostics(owner, r, [])),
	isOpen: (resource) => lsp.isOpen(resource)
};

class Tasks {
	/** Running tasks by key. */
	active = new SvelteMap<string, ActiveTask>();
	/** The Tasks output channel (load problems, cycles, unknown matchers). */
	log = $state.raw<string[]>([]);
	/** Labels of recently run tasks, most recent first (task.quickOpen.history). */
	recent = $state<string[]>([]);

	#root = '';
	#lastTask: Task | null = null;
	#terminals = new Map<number, TerminalInfo>();
	/** presentation.panel dedicated: the terminal a task used last. */
	#sameTaskTerminals = new Map<string, number>();
	/** presentation.panel shared: idle terminals by the task that used them, oldest first. */
	#idleTerminals = new Map<string, number>();
	#files: Promise<Set<string>> | null = null;
	#autoRan = new Set<string>();

	// --- Folder ------------------------------------------------------------------------------------

	async root(): Promise<string> {
		if (!this.#root) this.#root = await invoke<{ workspace: string }>('app_info').then((i) => i.workspace ?? '').catch(() => '');
		if (this.#root) lsp.setRoot(this.#root);
		return this.#root;
	}

	/** Another folder opened: running tasks keep their terminals, but this folder's state starts over. */
	reset(root: string | null) {
		this.#root = root ?? '';
		this.active.clear();
		this.#lastTask = null;
		this.#terminals.clear();
		this.#sameTaskTerminals.clear();
		this.#idleTerminals.clear();
		this.#files = null;
		this.recent = this.#loadRecent();
	}

	#recentKey() {
		return `${RECENT_KEY}:${this.#root}`;
	}

	#loadRecent(): string[] {
		try {
			const v = JSON.parse(localStorage.getItem(this.#recentKey()) ?? '[]');
			return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
		} catch {
			return [];
		}
	}

	#remember(task: Task) {
		const limit = Math.max(0, settings.get<number>('task.quickOpen.history'));
		this.recent = [task.label, ...this.recent.filter((l) => l !== task.label)].slice(0, limit);
		try {
			localStorage.setItem(this.#recentKey(), JSON.stringify(this.recent));
		} catch {
			// Storage unavailable: the history lasts until reload.
		}
	}

	#append(line: string) {
		this.log = [...this.log, ...line.split('\n')].slice(-LOG_LIMIT);
		output.append(TASKS_CHANNEL, line);
	}

	showLog() {
		output.show(TASKS_CHANNEL);
	}

	/** Workspace-relative paths of the folder's files (detection, autoDetect file locations). */
	#fileSet(): Promise<Set<string>> {
		this.#files ??= invoke<string[]>('fs_list_files')
			.then((l) => new Set(l))
			.catch(() => new Set<string>());
		return this.#files;
	}

	/** The file list changed (the watcher): detection and file checks read it again. */
	filesChanged() {
		this.#files = null;
	}

	// --- Reading tasks -----------------------------------------------------------------------------

	async #tasksFile(): Promise<TasksFileInfo> {
		return invoke<TasksFileInfo>('tasks_file').catch((e) => {
			this.#append(String(e));
			return { text: null, hash: null, trusted: false };
		});
	}

	/** Every task of the folder: tasks.json's, then the detected ones (task.autoDetect). */
	async getTasks(opts: { quiet?: boolean } = {}): Promise<{ tasks: Task[]; inputs: InputDef[]; file: TasksFileInfo }> {
		const root = await this.root();
		const file = await this.#tasksFile();
		const parsed = parseTasksJson(file.text ?? '', platformOf(shellPlatform()));
		const files = root ? await this.#fileSet() : new Set<string>();
		const rootFiles = new Set([...files].filter((f) => !f.includes('/')));
		const detected =
			root && settings.get<string>('task.autoDetect') !== 'off'
				? await detectTasks({ files, read: (rel) => invoke<string>('read_workspace_file', { rel }).catch(() => null) }).catch((e) => {
						this.#append(String(e));
						return [];
					})
				: [];
		const { tasks, errors } = mergeTasks(parsed, detected, (d) => taskFromDefinition(d, packageManagerFor(rootFiles)));
		if (errors.length && !opts.quiet) {
			errors.forEach((e) => this.#append(e));
			notifications.warn(t('ideTasks.loadErrors'), { actions: [{ label: t('ideTasks.showOutput'), run: () => this.showLog() }] });
		}
		return { tasks: tasks.filter((x) => x.command !== undefined || x.dependsOn.length), inputs: parsed.inputs, file };
	}

	async find(ref: TaskRef): Promise<{ task: Task | undefined; tasks: Task[]; inputs: InputDef[] }> {
		const { tasks, inputs } = await this.getTasks({ quiet: true });
		return { task: findTask(tasks, ref), tasks, inputs };
	}

	// --- Running -----------------------------------------------------------------------------------

	isActive(task: Task): boolean {
		return this.active.has(taskKey(task));
	}

	/** task.saveBeforeRun: every dirty editor (always), after asking (prompt), or none. */
	async #saveBeforeRun(): Promise<boolean> {
		const mode = settings.get<string>('task.saveBeforeRun');
		const dirty = editors.dirtyPaths().filter((p) => !isUntitled(p) && !isDiffKey(p));
		if (mode === 'never' || !dirty.length) return true;
		if (mode === 'prompt') {
			const save = t('ideTasks.save.save');
			const answer = await choose(t('ideTasks.save.prompt'), { kind: 'warning', buttons: [save, t('ideTasks.save.dontSave'), t('common.cancel')], cancelId: 2 });
			if (answer === t('common.cancel')) return false;
			if (answer !== save) return true;
		}
		const { saveFile } = await import('#lib/workbench/editorModels.ts');
		for (const path of dirty) await saveFile(path, 'explicit');
		return true;
	}

	/**
	 * Runs `task` (VS Code: ITaskService.run). `attachProblemMatcher`: ask for a problem matcher
	 * when the task has none (Run Task, Run Build Task). `untilInactive`: resolve once a
	 * background task's watcher is idle (debug preLaunchTask). Resolves with the summary.
	 */
	async run(task: Task, opts: { attachProblemMatcher?: boolean; untilInactive?: boolean; rerun?: boolean } = {}): Promise<Summary> {
		const root = await this.root();
		if (!root) {
			notifications.warn(t('ideTasks.openFolder'));
			return {};
		}
		const running = this.active.get(taskKey(task));
		if (running && task.runOptions.instanceLimit <= 1) {
			const policy = task.runOptions.instancePolicy;
			if (policy === 'terminateNewest' || policy === 'terminateOldest') running.terminate();
			else if (policy === 'silent') return opts.untilInactive && running.execution.inactive ? running.execution.inactive : running.execution.done;
			else if (policy === 'warn') {
				notifications.warn(t('ideTasks.alreadyActive', { label: task.label }));
				return running.execution.done;
			} else {
				const restart = t('ideTasks.restartTask');
				const terminate = t('ideTasks.terminateTask');
				const picked = await notifications.prompt('warning', t('ideTasks.alreadyActive', { label: task.label }), [terminate, restart]);
				if (picked === terminate) running.terminate();
				else if (picked === restart) {
					running.terminate();
					return this.run(task, { ...opts, attachProblemMatcher: false });
				}
				return {};
			}
		}
		if (!(await this.#saveBeforeRun())) return {};
		if (opts.attachProblemMatcher) {
			const attached = await this.#attachProblemMatcher(task);
			if (!attached) return {};
			task = attached;
		}
		const { tasks, inputs } = await this.getTasks({ quiet: true });
		if (!opts.rerun) this.#lastTask = task;
		this.#remember(task);
		const resolved = new Map<string, string>();
		const host: GraphHost<Task, TaskRef> = {
			key: taskKey,
			dependsOn: (x) => x.dependsOn,
			sequence: (x) => x.dependsOrder === 'sequence',
			isBackground: (x) => x.isBackground,
			hasCommand: (x) => x.command !== undefined,
			resolve: (ref) => findTask(tasks, ref),
			running: (x) => this.active.get(taskKey(x))?.execution,
			log: (m) => {
				this.#append(m);
				this.showLog();
			},
			execute: (x) => this.#execute(x, root, tasks, inputs, resolved)
		};
		try {
			return await runTask(host, task, { untilInactive: opts.untilInactive });
		} catch (e) {
			notifications.error(e instanceof Error ? e.message : String(e));
			return {};
		}
	}

	/** VS Code's _attachProblemMatcher: the quick pick for a task that names no problem matcher. */
	async #attachProblemMatcher(task: Task): Promise<Task | null> {
		if (task.problemMatcher !== undefined || (task.group && task.group.kind !== 'build') || task.command === undefined) return task;
		const never = settings.get<boolean | Record<string, boolean>>('task.problemMatchers.neverPrompt');
		if (never === true || (typeof never === 'object' && never && never[task.type])) return task;
		const items = [
			{ id: 'continue', label: t('ideTasks.matcher.continue') },
			{ id: 'never', label: t('ideTasks.matcher.never') },
			{ id: 'neverType', label: t('ideTasks.matcher.neverType', { type: task.type }) },
			...[
				'msCompile', 'gulp-tsc', 'jshint', 'jshint-stylish', 'eslint-compact', 'eslint-stylish', 'go', 'tsc', 'tsc-watch', 'tsgo-watch', 'gcc', 'rustc', 'rustc-json', 'rust-panic', 'rustc-watch'
			]
				.map((n) => namedMatcher(n)!)
				.sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
				.map((m, i) => ({ id: `$${m.name}`, label: m.label ?? m.name!, description: `$${m.name}`, separator: i === 0 ? t('ideTasks.matcher.associate') : undefined }))
		];
		const picked = await quick.choose({ placeholder: t('ideTasks.matcher.placeholder'), items });
		if (!picked) return task;
		if (picked.id === 'continue') return task;
		if (picked.id === 'never') {
			await this.#customize(task, { problemMatcher: [] });
			return task;
		}
		if (picked.id === 'neverType') {
			const current = settings.get<boolean | Record<string, boolean>>('task.problemMatchers.neverPrompt');
			if (current !== true) await settings.set('task.problemMatchers.neverPrompt', { ...(typeof current === 'object' ? current : {}), [task.type]: true }, 'user').catch((e) => notifications.error(e));
			return task;
		}
		const matcher = namedMatcher(picked.id.slice(1));
		const props: Record<string, unknown> = { problemMatcher: [picked.id] };
		if (matcher?.watching) props.isBackground = true;
		await this.#customize(task, props);
		return { ...task, problemMatcher: [picked.id], isBackground: matcher?.watching ? true : task.isBackground };
	}

	async #variableContext(root: string, tasks: Task[]): Promise<VariableContext> {
		const active = editors.active;
		const file = active && !isDiffKey(active) && !active.includes('://') && !isUntitled(active) ? absolute(root, active) : undefined;
		const build = groupTasks(tasks, 'build', active ?? undefined).defaults[0];
		return {
			workspaceFolder: root,
			file,
			lineNumber: file ? editors.cursor.line : undefined,
			columnNumber: file ? editors.cursor.column : undefined,
			selectedText: file ? editors.selectionText() : undefined,
			userHome: await invoke<Record<string, string>>('debug_env', { names: ['HOME'] })
				.then((e) => e.HOME)
				.catch(() => undefined),
			env: {},
			config: (key) => settings.get(key),
			defaultBuildTask: build?.label
		};
	}

	/** `${env:X}` from the app's environment (the login shell's), only the names used. */
	async #env(names: string[]): Promise<Record<string, string>> {
		if (!names.length) return {};
		return invoke<Record<string, string>>('debug_env', { names }).catch(() => ({}));
	}

	#prompter(): InputPrompter {
		return {
			promptString: (input) => quick.input({ placeholder: input.description ?? input.id, value: input.default, password: input.password, hint: (v) => (v ? t('ideTasks.input.hint', { value: input.password ? '•'.repeat(v.length) : v }) : (input.description ?? input.id)) }),
			pickString: async (input) => {
				const picked = await quick.choose({
					placeholder: input.description ?? input.id,
					items: input.options.map((o) => ({ id: o.value, label: o.label ?? o.value, description: o.label ? o.value : undefined })),
					activeId: input.default
				});
				return picked?.id;
			},
			// Kingu runs no extension commands (`${command:…}`, `type: command` inputs).
			command: async () => undefined
		};
	}

	/** Starts `task`'s own command in a terminal (its dependencies are done). */
	#execute(task: Task, root: string, tasks: Task[], inputs: InputDef[], resolved: Map<string, string>): Execution {
		let resolveDone!: (s: Summary) => void;
		let resolveInactive!: (s: Summary) => void;
		const done = new Promise<Summary>((r) => (resolveDone = r));
		const inactive = task.isBackground ? new Promise<Summary>((r) => (resolveInactive = r)) : undefined;
		const execution: Execution = { done, inactive };
		void this.#start(task, root, tasks, inputs, resolved, execution, resolveDone, (s) => resolveInactive?.(s)).catch((e) => {
			notifications.error(e instanceof VariableError || e instanceof Error ? e.message : String(e));
			clientLog('error', `task ${task.label}: ${e}`);
			resolveDone({});
			resolveInactive?.({});
		});
		return execution;
	}

	async #start(task: Task, root: string, tasks: Task[], inputs: InputDef[], resolved: Map<string, string>, execution: Execution, finish: (s: Summary) => void, idle: (s: Summary) => void) {
		await this.#terminalsReady();
		// Variables: inputs are asked once per run (shared with the task's dependencies).
		const ctx = await this.#variableContext(root, tasks);
		const used = collectVariables([task.command, task.args, task.options, task.problemMatcher]);
		ctx.env = await this.#env([...used].filter((v) => v.startsWith('env:')).map((v) => v.slice(4)));
		const answers = await resolveInputs(
			[...used].filter((v) => !resolved.has(v)),
			inputs,
			ctx,
			this.#prompter()
		);
		if (!answers) return finish({});
		answers.forEach((v, k) => resolved.set(k, v));
		const command = substitute(task.command!, ctx, resolved);
		const args = substitute(task.args, ctx, resolved);
		const options = substitute(task.options, ctx, resolved);
		const cwd = options.cwd ? (options.cwd.startsWith('/') ? options.cwd : `${root}/${options.cwd}`) : root;
		const matcherErrors: string[] = [];
		const vars = (s: string) => substitute(s, { ...ctx, workspaceFolder: root }, resolved);
		const matchers = parseProblemMatchers(task.problemMatcher, matcherErrors).map((m) => resolveMatcher(m, vars));
		if (matcherErrors.length) {
			matcherErrors.forEach((e) => this.#append(e));
			this.showLog();
		}

		const shell = shellFrom((id) => settings.get(id), shellPlatform());
		const launch = taskLaunch({ runtime: task.runtime, command, args, options }, task.command, { executable: shell.shell, args: shell.args });
		const p = task.presentation;
		// VS Code's getWaitOnExitValue: the message the terminal waits on after the task, if any.
		let wait = '';
		if (p.close !== true && (p.reveal !== 'never' || !task.isBackground || p.close === false)) {
			if (p.panel === 'new') wait = formatMessageForTerminal(t('ideTasks.closeTerminal'));
			else if (p.showReuseMessage) wait = formatMessageForTerminal(t('ideTasks.reuseTerminal'));
			else wait = '\r\n';
		}
		// VS Code: `The terminal process "/bin/zsh '-l', '-c', 'make'" terminated with exit code: 2.`
		const [exe, ...exeArgs] = launch.defaultShell ? [shell.shell || '$SHELL', ...launch.argv] : launch.argv;
		const processText = exeArgs.length ? `${exe} ${exeArgs.map((a) => `'${a}'`).join(', ')}` : exe;
		const [failedPrefix, failedSuffix] = formatMessageForTerminal(t('ideTasks.terminated', { process: processText, code: '\u0001' })).split('\u0001');
		const spawn: TaskSpawn = {
			argv: launch.argv,
			defaultShell: launch.defaultShell,
			cwd,
			env: options.env ?? {},
			echo: p.echo ? formatMessageForTerminal(t('ideTasks.executing', { command: launch.commandLine }), { excludeLeadingNewLine: true }) : '',
			failedPrefix,
			failedSuffix: failedSuffix ?? '',
			wait
		};

		// The terminal: reuse (dedicated: the task's own; shared: an idle one of the task, else of
		// its presentation group), split into the group's terminal, or a new one.
		const key = taskKey(task);
		let reuse: number | undefined;
		if (p.panel === 'dedicated') reuse = this.#takeIdle(this.#sameTaskTerminals.get(key));
		else if (p.panel === 'shared') {
			reuse = this.#takeIdle(this.#idleTerminals.get(key));
			if (reuse === undefined)
				for (const [k, id] of this.#idleTerminals) {
					if (this.#terminals.get(id)?.group === p.group && this.#takeIdle(id) !== undefined) {
						this.#idleTerminals.delete(k);
						reuse = id;
						break;
					}
				}
		}
		if (reuse !== undefined) {
			this.#idleTerminals.forEach((id, k) => id === reuse && this.#idleTerminals.delete(k));
			this.#terminals.delete(reuse);
		}
		const splitWith = reuse === undefined && p.group ? [...this.#terminals].find(([id, info]) => info.group === p.group && !info.idle && terminals.get(id))?.[0] : undefined;
		const terminalId = terminals.openTask({ title: task.label, task: spawn, replace: reuse, splitWith });
		const ptyKey = terminals.key(terminalId);
		this.#terminals.set(terminalId, { taskKey: key, group: p.group, idle: false });

		// Problem matching on the output.
		const host: FileHost = {
			exists: async (path) => {
				if (!path.startsWith(`${root}/`)) return false;
				return (await this.#fileSet()).has(path.slice(root.length + 1));
			}
		};
		const watching = task.isBackground ? new WatchingCollector(matchers, markerStore, host) : null;
		const collector = watching ?? new StartStopCollector(matchers, markerStore, host);
		if (watching && matchers.length && !watching.isWatching()) {
			this.#append(t('ideTasks.nonWatching', { label: task.label }));
			this.showLog();
		}
		let busyCount = 0;
		let wentIdle = false;
		const active: ActiveTask = { task, key: ptyKey, terminalId, startedAt: Date.now(), busy: false, execution, terminate: () => end(undefined, true) };
		this.active.set(key, active);
		collector.onEvent((e) => {
			if (e.kind === 'begins') {
				busyCount++;
				this.#setBusy(key, true);
			} else {
				busyCount = Math.max(0, busyCount - 1);
				if (busyCount === 0) {
					this.#setBusy(key, false);
					const errors = collector.numberOfMatches > 0 && collector.maxMarkerSeverity === 'error';
					if (errors) this.#revealOnProblems(task, terminalId, collector.numberOfMatches);
					if (!wentIdle) {
						wentIdle = true;
						idle({ exitCode: 0 });
					}
				}
			}
		});
		watching?.aboutToStart();

		const output = new TaskOutput();
		let exitCode: number | undefined;
		let ended = false;
		let delivery: ReturnType<typeof setTimeout> | undefined;
		const untap = tapOutput(ptyKey, (chunk) => {
			const { lines, signals, processExited } = output.feed(chunk);
			for (const line of lines) collector.processLine(line);
			if (watching && lines.length) {
				clearTimeout(delivery);
				delivery = setTimeout(() => watching.forceDelivery(), DELIVERY_MS);
			}
			for (const s of signals) {
				if (s.kind === 'exit') {
					exitCode = s.code;
					end(s.code, false);
				} else closeTerminal();
			}
			if (processExited) {
				end(exitCode, false);
				closeTerminal();
			}
		});
		const closeTerminal = () => {
			untap();
			this.#forgetTerminal(terminalId);
			terminals.close(terminalId);
		};
		const end = (code: number | undefined, terminated: boolean) => {
			if (ended) return;
			ended = true;
			clearTimeout(delivery);
			for (const line of output.flush()) collector.processLine(line);
			if (this.active.get(key) === active) this.active.delete(key);
			terminals.endTask(terminalId);
			if (terminated) {
				closeTerminal();
				killPty(ptyKey);
			} else {
				const info = this.#terminals.get(terminalId);
				if (info) info.idle = true;
				if (p.panel === 'dedicated') this.#sameTaskTerminals.set(key, terminalId);
				else if (p.panel === 'shared') {
					this.#idleTerminals.delete(key);
					this.#idleTerminals.set(key, terminalId);
				}
			}
			void collector.done().then(() => {
				const matches = collector.numberOfMatches;
				const errors = matches > 0 && collector.maxMarkerSeverity === 'error';
				if (!terminated) {
					if (p.revealProblems === 'onProblem' && matches > 0) layout.showPanel('problems');
					else if (p.reveal === 'silent' && (code !== 0 || errors)) this.#showTerminal(terminalId, false);
				}
				clientLog('info', `task ${task.label}: exit ${code ?? 'terminated'} (${matches} problems)`);
				if (!wentIdle) idle({ exitCode: code });
				finish({ exitCode: terminated ? undefined : code });
			});
		};

		// Reveal (VS Code: revealProblems always, else focus / reveal always).
		if (p.revealProblems === 'always') layout.showPanel('problems');
		else if (p.focus || p.reveal === 'always') this.#showTerminal(terminalId, p.focus);
	}

	/** The panel's terminals are loaded for the folder (a task at startup waits for them). */
	async #terminalsReady() {
		for (let i = 0; i < 100 && terminals.tag === null; i++) await new Promise((r) => setTimeout(r, 50));
	}

	#setBusy(key: string, busy: boolean) {
		const a = this.active.get(key);
		if (a && a.busy !== busy) this.active.set(key, { ...a, busy });
	}

	#revealOnProblems(task: Task, terminalId: number, matches: number) {
		if (task.presentation.revealProblems === 'onProblem' && matches > 0) layout.showPanel('problems');
		else if (task.presentation.reveal === 'silent') this.#showTerminal(terminalId, false);
	}

	#showTerminal(id: number, focus: boolean) {
		if (!terminals.get(id)) return;
		terminals.active = id;
		layout.showPanel('terminal');
		if (focus) focusTerminal(terminals.key(id));
	}

	/** An idle task terminal that still exists, else undefined. */
	#takeIdle(id: number | undefined): number | undefined {
		if (id === undefined) return undefined;
		const info = this.#terminals.get(id);
		return info?.idle && terminals.get(id) ? id : undefined;
	}

	#forgetTerminal(id: number) {
		this.#terminals.delete(id);
		this.#sameTaskTerminals.forEach((v, k) => v === id && this.#sameTaskTerminals.delete(k));
		this.#idleTerminals.forEach((v, k) => v === id && this.#idleTerminals.delete(k));
	}

	/** Terminate Task: the task's process (and its terminal) ends. */
	terminate(task: Task) {
		this.active.get(taskKey(task))?.terminate();
	}

	terminateAll() {
		for (const a of [...this.active.values()]) a.terminate();
	}

	/** Restart Running Task: terminate, then run again. */
	async restart(task: Task) {
		const a = this.active.get(taskKey(task));
		if (a) {
			a.terminate();
			await a.execution.done;
		}
		await this.run(task, { rerun: true });
	}

	/** Rerun Last Task. */
	async rerun(): Promise<boolean> {
		if (!this.#lastTask) return false;
		const { task } = await this.find(this.#lastTask.label);
		await this.run(task ?? this.#lastTask, { rerun: true });
		return true;
	}

	get lastTask(): Task | null {
		return this.#lastTask;
	}

	/** Focuses the terminal of a running task (Show Running Tasks). */
	show(task: Task) {
		const a = this.active.get(taskKey(task));
		if (a) this.#showTerminal(a.terminalId, true);
	}

	/** The task that ran last in the terminal `id` (Rerun Task from a task terminal). */
	taskOfTerminal(id: number): string | undefined {
		return this.#terminals.get(id)?.taskKey;
	}

	// --- tasks.json ----------------------------------------------------------------------------------

	async #writeTasksFile(text: string, open = true) {
		await invoke('fs_create_dir', { rel: '.vscode' }).catch(() => {});
		await invoke('fs_write_file', { rel: TASKS_PATH, content: text });
		if (open) editors.open(TASKS_PATH, { preview: false });
	}

	async #customize(task: Task, props: Record<string, unknown>) {
		const { file } = await this.getTasks({ quiet: true });
		await this.#writeTasksFile(customizeText(file.text, task, props), false).catch((e) => notifications.error(e));
	}

	/** Configure Task: tasks.json with the task's entry (from the template when there is none). */
	async configure(task: Task | 'template') {
		const { file } = await this.getTasks({ quiet: true });
		const text = task === 'template' ? (file.text ?? TEMPLATE) : configureText(file.text, task);
		if (text !== file.text) await this.#writeTasksFile(text).catch((e) => notifications.error(e));
		else editors.open(TASKS_PATH, { preview: false });
	}

	/** Configure Default Build / Test Task. */
	async setDefault(task: Task, kind: 'build' | 'test') {
		const { file } = await this.getTasks({ quiet: true });
		await this.#writeTasksFile(setDefaultGroupText(file.text, task, kind)).catch((e) => notifications.error(e));
	}

	/** Open Workspace Tasks: tasks.json (VS Code creates it from a template when it is missing). */
	async openTasksFile() {
		const { file } = await this.getTasks({ quiet: true });
		if (file.text === null) await this.configure('template');
		else editors.open(TASKS_PATH, { preview: false });
	}

	// --- Automatic tasks (runOptions.runOn: folderOpen) ---------------------------------------------

	/**
	 * VS Code's RunAutomaticTasks: tasks with `runOn: folderOpen` run when the folder opens, unless
	 * task.allowAutomaticTasks is off. They come with the repository, so the exact tasks.json must
	 * be trusted first (asked once per content; Disallow is remembered for that content).
	 */
	async runAutomatic() {
		// VS Code: an explicit `off` in the user settings neither runs nor asks.
		if (settings.get<string>('task.allowAutomaticTasks') === 'off' && settings.inspect('task.allowAutomaticTasks', 'user') !== undefined) return;
		const root = await this.root();
		if (!root || this.#autoRan.has(root)) return;
		this.#autoRan.add(root);
		const { tasks, file } = await this.getTasks({ quiet: true });
		const auto = tasks.filter((x) => x.configured && x.runOptions.runOn === 'folderOpen');
		if (!auto.length || !file.hash) return;
		if (!file.trusted) {
			const declinedKey = `kingu.tasks.autoDeclined:${root}`;
			let declined: string | null = null;
			try {
				declined = localStorage.getItem(declinedKey);
			} catch {
				// No storage: ask every time.
			}
			if (declined === file.hash) return;
			const allow = t('ideTasks.auto.allow');
			const answer = await choose(t('ideTasks.auto.prompt', { tasks: auto.map((x) => x.label).join(', '), file: TASKS_PATH }), {
				kind: 'warning',
				buttons: [allow, t('ideTasks.auto.disallow')],
				cancelId: 1
			});
			if (answer !== allow) {
				try {
					localStorage.setItem(declinedKey, file.hash);
				} catch {
					// Asked again next time.
				}
				return;
			}
			try {
				await invoke('tasks_trust', { hash: file.hash });
			} catch (e) {
				return notifications.error(e);
			}
		}
		for (const task of auto) void this.run(task);
	}

	/** Disallow Automatic Tasks (VS Code's Manage Automatic Tasks): forgets the trust. */
	async disallowAutomatic() {
		await invoke('tasks_trust', { hash: null }).catch((e) => notifications.error(e));
	}
}

export const tasks = new Tasks();
