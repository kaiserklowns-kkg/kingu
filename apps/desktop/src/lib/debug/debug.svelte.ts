// The debugger for the workbench (VS Code: IDebugService). Picks a launch configuration, starts the
// adapter through Rust `dap_start`, runs a DebugSession over it and exposes its state reactively
// for the Run and Debug view, the Debug Console, the editors' breakpoint glyphs and the status bar.
// One session at a time (Rust keeps a table, so more can come later).

import { untrack } from 'svelte';
import { Channel, invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { isRustError } from '#lib/i18n/rustErrors.ts';
import { installItems, type InstallInfo } from '#lib/lsp/model.ts';
import { opensOnStart } from '#lib/settings/mappings.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { isDiffKey } from '#lib/workbench/scm.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import * as B from './breakpoints.ts';
import { DapClient } from './client.ts';
import { generatedConfigs, LAUNCH_FILES, parseLaunchJson, runInTerminalArgv, substitute, type Generated, type LaunchConfig } from './launch.ts';
import { appendOutput, currentFrame, frameLocation, initialModel, outputLimit, stateLabel, type DebugModel } from './model.ts';
import { canSetBreakpoint, editorsToSave, opensOnBreak } from './debugSettings.ts';
import { isUntitled } from '#lib/workbench/untitled.ts';
import type { StackFrame } from './protocol.ts';
import { DebugSession } from './session.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { parseProblemMatchers } from '#lib/tasks/problemMatcher.ts';
import { tasks } from '#lib/tasks/tasks.svelte.ts';
import type { TaskRef } from '#lib/tasks/taskConfig.ts';
import { choose } from '#lib/workbench/messageBox.ts';

type DapEvent = { type: 'message'; json: string } | { type: 'stderr'; line: string } | { type: 'exit'; code: number | null };
type Active = { session: DebugSession; id: number | null; config: LaunchConfig; build?: string[]; noDebug: boolean; postDone?: boolean };
export type WatchResult = { value: string; error?: boolean };

const LAST_CONFIG = 'kingu.debug.lastConfig';
const WATCHES = 'kingu.debug.watches';

/** A preLaunchTask / postDebugTask reference as text (a label, or a task identifier). */
const taskName = (ref: unknown) => (typeof ref === 'string' ? ref : JSON.stringify(ref));

const isWorkspaceFile = (p: string | null): p is string => !!p && !p.includes('://') && !isDiffKey(p);

function load(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
function save(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage unavailable: breakpoints and watches last for this window only.
	}
}

class Debug {
	/** The current (or last) session's state; null before the first session in this folder. */
	model = $state.raw<DebugModel | null>(null);
	configName = $state('');
	/** For the `openOnFirstSessionStart` / `onFirstSessionStart` settings: sessions started since Kingu opened. */
	sessionsStarted = $state(0);
	breakpoints = $state.raw<B.BreakpointMap>({});
	watches = $state<string[]>([]);
	watchResults = $state.raw<Record<string, WatchResult>>({});
	root = $state('');

	/** A session exists and has not terminated. */
	active = $derived(this.model !== null && this.model.state !== 'terminated');
	stopped = $derived(this.model?.state === 'stopped');
	running = $derived(this.model?.state === 'running' || this.model?.state === 'initializing');
	stoppedLocation = $derived(this.model ? frameLocation(currentFrame(this.model), this.root) : null);
	label = $derived(stateLabel(this.model));

	#active: Active | null = null;
	/** Breakpoints hit in this session (`rel:line`): their triggered breakpoints are now sent. */
	triggered = $state.raw<ReadonlySet<string>>(new Set());
	#rootLoaded: Promise<string> | undefined;

	// --- Folder ------------------------------------------------------------------------------------

	async #ensureRoot(): Promise<string> {
		this.#rootLoaded ??= invoke<{ workspace: string }>('app_info').then((i) => {
			this.root = i.workspace;
			this.breakpoints = B.parseStored(this.root ? load(B.storageKey(this.root)) : null);
			try {
				const w = JSON.parse(load(`${WATCHES}:${this.root}`) ?? '[]');
				this.watches = Array.isArray(w) ? w.filter((x) => typeof x === 'string') : [];
			} catch {
				this.watches = [];
			}
			return this.root;
		});
		return this.#rootLoaded;
	}

	/** Open Folder: Rust has already killed the old folder's adapters. */
	reset() {
		this.#active = null;
		this.model = null;
		this.configName = '';
		this.watchResults = {};
		this.#rootLoaded = undefined;
		void this.#ensureRoot();
	}

	#abs(rel: string) {
		return `${this.root}/${rel}`;
	}

	// --- Breakpoints -------------------------------------------------------------------------------

	#setBreakpoints(map: B.BreakpointMap, rel: string) {
		this.breakpoints = map;
		if (this.root) save(B.storageKey(this.root), JSON.stringify(map));
		const session = this.#active?.session;
		if (session) void session.setBreakpoints(this.#abs(rel), B.sourceBreakpoints(map[rel], this.triggered));
	}

	/** F9 / glyph margin click; defaults to the active editor's cursor line. Outside a debuggable
	 * language only with `debug.allowBreakpointsEverywhere` (an existing one can still be removed). */
	toggleBreakpoint(rel = editors.active, line = editors.cursor.line, language = editors.language) {
		if (!isWorkspaceFile(rel)) return;
		const has = this.breakpoints[rel]?.some((b) => b.line === line);
		if (!has && !canSetBreakpoint(language, settings.get<boolean>('debug.allowBreakpointsEverywhere'))) {
			status.flash(t('tools.debug.cantSetBreakpoint', { language }));
			return;
		}
		void this.#ensureRoot().then(() => this.#setBreakpoints(B.toggle(this.breakpoints, rel, line), rel));
	}

	removeBreakpoint(rel: string, line: number) {
		this.#setBreakpoints(B.remove(this.breakpoints, rel, line), rel);
	}

	setBreakpointEnabled(rel: string, line: number, enabled: boolean) {
		this.#setBreakpoints(B.setEnabled(this.breakpoints, rel, line, enabled), rel);
	}

	removeAllBreakpoints() {
		const files = Object.keys(this.breakpoints);
		this.breakpoints = {};
		if (this.root) save(B.storageKey(this.root), '{}');
		for (const rel of files) void this.#active?.session.setBreakpoints(this.#abs(rel), []);
	}

	/** Conditional breakpoint on the cursor line (VS Code: Add Conditional Breakpoint…). */
	async editCondition(rel = editors.active, line = editors.cursor.line) {
		if (!isWorkspaceFile(rel)) return;
		await this.#ensureRoot();
		const current = this.breakpoints[rel]?.find((b) => b.line === line)?.condition ?? '';
		const cond = await quick.input({
			placeholder: t('tools.debug.conditionPlaceholder', { line, current: current ? t('tools.debug.current', { value: current }) : '' }),
			hint: (v) => (v ? t('tools.debug.conditionHint', { condition: v }) : t('tools.debug.plainBreakpoint'))
		});
		if (cond !== undefined) this.#setBreakpoints(B.setCondition(this.breakpoints, rel, line, cond), rel);
	}

	/** Logpoint on the cursor line (VS Code: Add Logpoint…): `{expr}` in the message is evaluated. */
	async editLogMessage(rel = editors.active, line = editors.cursor.line) {
		if (!isWorkspaceFile(rel)) return;
		await this.#ensureRoot();
		const current = this.breakpoints[rel]?.find((b) => b.line === line)?.logMessage ?? '';
		const message = await quick.input({
			placeholder: t('tools.debug.logPlaceholder', { line, current: current ? t('tools.debug.current', { value: current }) : '', example: `{${t('tools.debug.expression')}}` }),
			hint: (v) => (v ? `log ${v}` : t('tools.debug.plainBreakpoint'))
		});
		if (message !== undefined) this.#setBreakpoints(B.setLogMessage(this.breakpoints, rel, line, message), rel);
	}

	/** Triggered breakpoint on the cursor line (VS Code: Add Triggered Breakpoint…): pick the breakpoint that enables it. */
	async editTrigger(rel = editors.active, line = editors.cursor.line) {
		if (!isWorkspaceFile(rel)) return;
		await this.#ensureRoot();
		const others = Object.entries(this.breakpoints).flatMap(([r, list]) => list.filter((b) => !(r === rel && b.line === line)).map((b) => B.breakpointKey(r, b.line)));
		if (!others.length) return status.flash(t('tools.debug.noOtherBreakpoints'));
		const item = await quick.choose({ placeholder: t('tools.debug.triggerPlaceholder', { line }), items: others.map((k) => ({ id: k, label: k })) });
		if (item) this.#setBreakpoints(B.setTriggeredBy(this.breakpoints, rel, line, item.id), rel);
	}

	/** A hit breakpoint enables the breakpoints it triggers (sent to the debugger from now on). */
	#hit(loc: { rel: string; line: number } | null) {
		if (!loc) return;
		const key = B.breakpointKey(loc.rel, loc.line);
		if (this.triggered.has(key) || !this.breakpoints[loc.rel]?.some((b) => b.line === loc.line && b.enabled)) return;
		this.triggered = new Set([...this.triggered, key]);
		for (const [rel, list] of Object.entries(this.breakpoints)) if (list.some((b) => b.triggeredBy === key)) this.#setBreakpoints(this.breakpoints, rel);
	}

	/** Editors tracked breakpoint lines through an edit. */
	moveBreakpoints(rel: string, lines: number[]) {
		const next = B.moveTo(this.breakpoints, rel, lines);
		if (next !== this.breakpoints) this.#setBreakpoints(next, rel);
	}

	/** The adapter's verification for a file, undefined outside a session (plain glyphs). */
	verifiedFor(rel: string) {
		return this.active ? (this.model?.verified[this.#abs(rel)] ?? []) : undefined;
	}

	// --- Starting ----------------------------------------------------------------------------------

	/** F5: continue when stopped, else start a session (VS Code: Start Debugging / Continue). */
	async start({ noDebug = false } = {}) {
		if (this.stopped) return this.continue();
		if (this.active) return status.flash(t('tools.debug.alreadyRunning'));
		const root = await this.#ensureRoot();
		if (!root) return status.flash(t('tools.debug.openFolderFirst'));
		const picked = await this.#pickConfig();
		if (!picked) return;
		// debug.saveBeforeStart: the dirty editors of the active group (untitled ones ask where to save).
		const toSave = editorsToSave(settings.get<string>('debug.saveBeforeStart'), editors.tabs.map((t) => t.path), (p) => editors.isDirty(p), isUntitled);
		if (toSave.length) {
			const { saveFile } = await import('#lib/workbench/editorModels.ts');
			for (const path of toSave) await saveFile(path, 'explicit');
		}
		let { config } = picked;
		const { generated } = picked;
		const active = editors.active;
		const file = isWorkspaceFile(active) ? this.#abs(active) : undefined;
		const ctx = { workspaceFolder: root, file, env: await this.#env(config) };
		try {
			if (generated?.askProgram) {
				const suggestion = substitute(String(config.program ?? ''), ctx);
				const program = await quick.input({ placeholder: t('tools.debug.programPlaceholder', { suggestion }), hint: (v) => t('tools.debug.programHint', { program: v || suggestion }) });
				if (program === undefined) return;
				config = { ...config, program: program ? (program.startsWith('/') ? program : `${root}/${program}`) : suggestion };
			}
			config = substitute(config, ctx);
		} catch (e) {
			return notifications.error(e instanceof Error ? e.message : String(e));
		}
		await this.#launch(config, noDebug, generated?.build);
	}

	/** `${env:X}` values from the app's environment (login-shell PATH), only the names the config uses. */
	async #env(config: LaunchConfig): Promise<Record<string, string>> {
		const names = [...new Set([...JSON.stringify(config).matchAll(/\$\{env:([^}]+)\}/g)].map((m) => m[1]))];
		if (!names.length) return {};
		return invoke<Record<string, string>>('debug_env', { names }).catch(() => ({}));
	}

	async #readLaunchFiles(): Promise<LaunchConfig[]> {
		const configs: LaunchConfig[] = [];
		for (const rel of LAUNCH_FILES) {
			const text = await invoke<string>('read_workspace_file', { rel }).catch(() => null);
			if (text === null) continue;
			const parsed = parseLaunchJson(text, rel);
			if (parsed.error) status.flash(parsed.error);
			configs.push(...parsed.configs);
		}
		return configs;
	}

	async #pickConfig(): Promise<{ config: LaunchConfig; generated?: Generated } | undefined> {
		const configs = await this.#readLaunchFiles();
		const lastKey = `${LAST_CONFIG}:${this.root}`;
		if (configs.length === 1) return { config: configs[0] };
		if (configs.length > 1) {
			const last = load(lastKey);
			const item = await quick.choose({
				placeholder: t('tools.debug.pickConfig'),
				items: configs.map((c, i) => ({ id: String(i), label: c.name, description: c.type })),
				activeId: String(Math.max(0, configs.findIndex((c) => c.name === last)))
			});
			if (!item) return;
			const config = configs[Number(item.id)];
			save(lastKey, config.name);
			return { config };
		}
		const language = editors.language;
		const cargoToml = language === 'rust' ? await invoke<string>('read_workspace_file', { rel: 'Cargo.toml' }).catch(() => null) : null;
		const gens = generatedConfigs(isWorkspaceFile(editors.active) ? language : '', { cargoToml });
		if (!gens.length) {
			status.flash(t('tools.debug.noLaunchJson'));
			return;
		}
		return { config: gens[0].config, generated: gens[0] };
	}

	async #launch(config: LaunchConfig, noDebug: boolean, build?: string[]) {
		let model = initialModel();
		this.model = model;
		this.triggered = new Set();
		this.configName = config.name;
		this.watchResults = {};
		// debug.openDebug / debug.internalConsoleOptions (a launch config's own internalConsoleOptions wins).
		const first = this.sessionsStarted++ === 0;
		if (opensOnStart(settings.get('debug.openDebug'), first)) {
			layout.sideView = 'debug';
			layout.sidebarVisible = true;
		}
		const consoleOption = typeof config.internalConsoleOptions === 'string' ? config.internalConsoleOptions : settings.get<string>('debug.internalConsoleOptions');
		if (config.console !== 'integratedTerminal' && opensOnStart(consoleOption, first)) layout.showPanel('debugConsole');
		const out = (category: string, text: string) => (this.model = model = appendOutput(this.model ?? model, category, text));
		// VS Code's DebugTaskRunner: the preLaunchTask runs (a background one until its watcher is idle) before the adapter starts.
		if (config.preLaunchTask) {
			out('console', t('ideTasks.debug.running', { task: taskName(config.preLaunchTask) }));
			if (!(await this.#runPreLaunchTask(config.preLaunchTask as TaskRef))) {
				this.model = { ...this.model!, state: 'terminated' };
				return;
			}
		}
		if (build) {
			out('console', `> ${build.join(' ')}\n`);
			const res = await invoke<{ success: boolean; output: string }>('debug_build', { argv: build }).catch((e) => ({ success: false, output: `${e}\n` }));
			out(res.success ? 'stdout' : 'stderr', res.output);
			if (!res.success) {
				this.model = { ...this.model!, state: 'terminated' };
				return status.flash(t('tools.debug.buildFailed', { command: build.join(' ') }));
			}
		}

		let id: number | null = null;
		let chain: Promise<unknown> = Promise.resolve();
		// Sends are chained so the adapter sees them in order (separate IPC calls may not be).
		const write = (json: string) => {
			chain = chain.then(() => (id === null ? undefined : invoke('dap_send', { id, message: json }))).catch((e) => this.#sessionOutput(session, 'stderr', `send: ${e}\n`));
		};
		const client = new DapClient(write);
		const session: DebugSession = new DebugSession(
			client,
			config,
			{
				breakpoints: () => {
					const all: Record<string, ReturnType<typeof B.sourceBreakpoints>> = {};
					for (const [rel, list] of Object.entries(this.breakpoints)) {
						const bps = B.sourceBreakpoints(list, this.triggered);
						if (bps.length) all[this.#abs(rel)] = bps;
					}
					return all;
				},
				runInTerminal: async (args) => {
					terminals.open({ title: args.title ?? `Debug: ${config.name}`, run: runInTerminalArgv(args) });
					layout.showPanel('terminal');
					return {};
				},
				changed: (m) => {
					if (this.#active?.session === session) this.model = m;
				},
				stopped: (frame) => {
					this.#hit(frameLocation(frame, this.root));
					this.#reveal(frame);
					this.#onBreak();
					void this.#evaluateWatches();
				},
				terminated: () => void this.#finish(session)
			},
			{ noDebug }
		);
		// Output already shown (preLaunchTask notice, build) stays at the top of the console.
		session.model = { ...session.model, output: model.output };
		const active: Active = { session, id: null, config, build, noDebug };
		this.#active = active;

		const channel = new Channel<DapEvent>();
		channel.onmessage = (ev) => {
			if (ev.type === 'message') client.handle(ev.json);
			else if (ev.type === 'stderr') session.model.state !== 'terminated' && this.#sessionOutput(session, 'stderr', `${ev.line}\n`);
			else {
				session.exited(ev.code);
				clientLog('info', `debug adapter exited (code ${ev.code})`);
			}
		};
		try {
			id = await invoke<number>('dap_start', { debugType: config.type, python: typeof config.python === 'string' ? config.python : null, onEvent: channel });
			active.id = id;
			clientLog('info', `debug session started: ${config.name} (${config.type})`);
		} catch (e) {
			const message = String(e);
			out('stderr', `${message}\n`);
			this.model = { ...this.model!, state: 'terminated' };
			this.#active = null;
			if (isRustError(message, 'notInstalled')) void this.install(config.type);
			else status.flash(message);
			return;
		}
		try {
			await session.start();
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.#sessionOutput(session, 'stderr', `${message}\n`);
			notifications.error(t('tools.debug.startFailed', { error: message }));
			await this.#kill(active);
		}
	}

	/** VS Code's runTaskAndCheckErrors: true when debugging may start. */
	async #runPreLaunchTask(ref: TaskRef): Promise<boolean> {
		const name = taskName(ref);
		const debugAnyway = t('ideTasks.debug.debugAnyway');
		const configure = t('ideTasks.debug.configureTask');
		const failed = async (message: string, task?: Parameters<typeof tasks.configure>[0]) => {
			const answer = await choose(message, { kind: 'error', buttons: [debugAnyway, configure, t('common.cancel')], cancelId: 2 });
			if (answer === configure) await tasks.configure(task ?? 'template');
			return answer === debugAnyway;
		};
		const { task } = await tasks.find(ref);
		if (!task) return failed(t('ideTasks.debug.notFound', { task: name }));
		const run = tasks.run(task, { untilInactive: true });
		let summary;
		// A background task without a background pattern never goes idle: VS Code gives up after 5 s.
		if (task.isBackground && !parseProblemMatchers(task.problemMatcher, []).some((m) => m.watching)) {
			const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5000));
			const first = await Promise.race([run, timeout]);
			if (first === 'timeout') return failed(t('ideTasks.debug.notTracked', { task: name }), task);
			summary = first;
		} else summary = await run;
		if (summary.exitCode === undefined) return false;
		const errors = lsp.errorCount();
		const onErrors = settings.get<string>('debug.onTaskErrors');
		if (summary.exitCode === 0 || onErrors === 'debugAnyway') return true;
		if (onErrors === 'showErrors') {
			layout.showPanel('problems');
			return false;
		}
		if (onErrors === 'abort') return false;
		const message =
			errors > 1 ? t('ideTasks.debug.errors', { task: name }) : errors === 1 ? t('ideTasks.debug.error', { task: name }) : t('ideTasks.debug.exitCode', { task: name, code: summary.exitCode });
		const showErrors = t('ideTasks.debug.showErrors');
		const answer = await choose(message, { kind: 'warning', buttons: [debugAnyway, showErrors, t('ideTasks.debug.abort')], cancelId: 2 });
		if (answer === debugAnyway) return true;
		if (answer === showErrors) layout.showPanel('problems');
		return false;
	}

	/** postDebugTask: runs once the session ended (not awaited, like VS Code). */
	#runPostDebugTask(active: Active) {
		const ref = active.config.postDebugTask;
		if (!ref || active.postDone) return;
		active.postDone = true;
		this.#sessionOutput(active.session, 'console', t('ideTasks.debug.postRunning', { task: taskName(ref) }));
		void tasks.find(ref as TaskRef).then(({ task }) => {
			if (task) void tasks.run(task);
			else notifications.error(t('ideTasks.debug.notFound', { task: taskName(ref) }));
		});
	}

	#sessionOutput(session: DebugSession, category: string, text: string) {
		session.model = appendOutput(session.model, category, text);
		if (this.#active?.session === session) this.model = session.model;
	}

	/** The adapter said `terminated`: disconnect (VS Code does), then make sure the process is gone. */
	async #finish(session: DebugSession) {
		const active = this.#active;
		if (!active || active.session !== session) return;
		await session.disconnect();
		this.#runPostDebugTask(active);
		setTimeout(() => active.id !== null && void invoke('dap_stop', { id: active.id }).catch(() => {}), 1000);
	}

	async #kill(active: Active) {
		await active.session.disconnect(1000);
		if (active.id !== null) await invoke('dap_stop', { id: active.id }).catch(() => {});
		active.session.exited(null);
		if (this.#active === active) this.model = active.session.model;
		this.#runPostDebugTask(active);
	}

	// --- Running -----------------------------------------------------------------------------------

	async stop() {
		const active = this.#active;
		if (!active || !this.active) return;
		await this.#kill(active);
	}

	async restart() {
		const active = this.#active;
		if (!active) return;
		if (this.active && (await active.session.restart().catch(() => false))) return;
		if (this.active) await this.#kill(active);
		await this.#launch(active.config, active.noDebug, active.build);
	}

	continue() {
		return this.#active?.session.continue();
	}
	stepOver() {
		return this.#active?.session.next();
	}
	stepInto() {
		return this.#active?.session.stepIn();
	}
	stepOut() {
		return this.#active?.session.stepOut();
	}
	pause() {
		return this.#active?.session.pause();
	}

	async selectFrame(frameId: number) {
		await this.#active?.session.selectFrame(frameId);
		void this.#evaluateWatches();
	}

	/** Children of a scope or variable for the Variables tree. */
	expand(ref: number) {
		return this.#active?.session.expand(ref).catch(() => []) ?? Promise.resolve([]);
	}

	/** debug.openDebug: openOnDebugBreak, debug.focusWindowOnBreak. */
	#onBreak() {
		if (opensOnBreak(settings.get<string>('debug.openDebug'))) {
			layout.sideView = 'debug';
			layout.sidebarVisible = true;
		}
		if (settings.get<boolean>('debug.focusWindowOnBreak') && !document.hasFocus())
			void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setFocus()).catch(() => {});
	}

	/** debug.focusEditorOnBreak: the editor at the stopped line takes focus (else it only scrolls there). */
	#reveal(frame: StackFrame | null) {
		const loc = frameLocation(frame, this.root);
		if (loc) editors.open(loc.rel, { reveal: { line: loc.line, column: loc.column, focus: settings.get<boolean>('debug.focusEditorOnBreak') } });
		else if (frame?.source?.path) notifications.warn(t('tools.debug.outsideWorkspace', { path: frame.source.path }));
	}

	// --- Watch and REPL ----------------------------------------------------------------------------

	addWatch(expr: string) {
		const e = expr.trim();
		if (!e || this.watches.includes(e)) return;
		this.watches = [...this.watches, e];
		save(`${WATCHES}:${this.root}`, JSON.stringify(this.watches));
		void this.#evaluateWatches();
	}

	removeWatch(expr: string) {
		this.watches = this.watches.filter((w) => w !== expr);
		save(`${WATCHES}:${this.root}`, JSON.stringify(this.watches));
	}

	async #evaluateWatches() {
		const session = this.#active?.session;
		if (!session || !this.stopped) return;
		const results: Record<string, WatchResult> = {};
		await Promise.all(
			this.watches.map(async (w) => {
				try {
					results[w] = { value: (await session.evaluate(w, 'watch')).result };
				} catch (e) {
					results[w] = { value: e instanceof Error ? e.message : String(e), error: true };
				}
			})
		);
		this.watchResults = results;
	}

	/** Debug Console input. */
	async repl(expr: string) {
		const session = this.#active?.session;
		if (!session || !this.active) {
			if (this.model) this.model = appendOutput(this.model, 'stderr', t('tools.debug.noSession'));
			return;
		}
		this.#sessionOutput(session, 'input', `> ${expr}\n`);
		try {
			const r = await session.evaluate(expr, 'repl');
			this.#sessionOutput(session, 'result', `${r.result}\n`);
		} catch (e) {
			this.#sessionOutput(session, 'stderr', `${e instanceof Error ? e.message : e}\n`);
		}
		void this.#evaluateWatches();
	}

	clearConsole() {
		if (this.model) this.model = { ...this.model, output: [] };
		if (this.#active) this.#active.session.model = { ...this.#active.session.model, output: [] };
	}

	// --- Missing adapters --------------------------------------------------------------------------

	/** Offers the install commands this machine can run, like a missing language server. */
	async install(debugType: string) {
		let res: InstallInfo;
		try {
			res = await invoke<InstallInfo>('dap_install_methods', { debugType });
		} catch (e) {
			return notifications.error(e);
		}
		quick.pick({
			placeholder: res.methods.length ? t('tools.debug.installWith', { server: res.server }) : t('tools.debug.installManual', { server: res.server, binary: res.binary }),
			items: installItems(res),
			onAccept: (item) => {
				const method = res.methods[Number(item.id)];
				if (!method) return;
				terminals.open({ title: t('tools.debug.installTerminal', { server: res.server }), run: method.argv });
				layout.showPanel('terminal');
			}
		});
	}

	// --- launch.json -------------------------------------------------------------------------------

	/** Debug: Open launch.json — creates `.vscode/launch.json` with a configuration for the active file's language. */
	async openLaunchJson() {
		const root = await this.#ensureRoot();
		if (!root) return status.flash(t('tools.debug.openFolder'));
		const rel = LAUNCH_FILES[0];
		const exists = await invoke<string>('read_workspace_file', { rel }).then(
			() => true,
			() => false
		);
		if (!exists) {
			const cargoToml = editors.language === 'rust' ? await invoke<string>('read_workspace_file', { rel: 'Cargo.toml' }).catch(() => null) : null;
			const configs = generatedConfigs(editors.language, { cargoToml }).map((g) => g.config);
			const text = `{\n\t// ดู https://code.visualstudio.com/docs/editor/debugging#_launch-configurations\n\t"version": "0.2.0",\n\t"configurations": ${JSON.stringify(configs, null, '\t').replaceAll('\n', '\n\t')}\n}\n`;
			try {
				await invoke('fs_create_file', { rel });
				await invoke('fs_write_file', { rel, content: text });
			} catch (e) {
				return notifications.error(e);
			}
		}
		editors.open(rel, { preview: false });
	}
}

export const debug = new Debug();

/** Commands and keys (VS Code ids and default keybindings). Returns the uninstaller. */
export function installDebug(): () => void {
	debug.reset();
	// debug.openExplorerOnEnd / debug.console.closeOnEnd when a session ends; debug.console.maximumLines.
	let lastState: string | undefined;
	const disposeEffects = $effect.root(() => {
		$effect(() => {
			const state = debug.model?.state;
			const ended = state === 'terminated' && lastState !== undefined && lastState !== 'terminated';
			lastState = state;
			if (!ended) return;
			untrack(() => {
				if (settings.get<boolean>('debug.openExplorerOnEnd')) {
					layout.sideView = 'explorer';
					layout.sidebarVisible = true;
				}
				if (settings.get<boolean>('debug.console.closeOnEnd') && layout.panelTab === 'debugConsole') layout.panelVisible = false;
			});
		});
		$effect(() => {
			outputLimit.max = settings.get<number>('debug.console.maximumLines');
		});
	});
	const unregister = [
		commands.register({ id: 'workbench.action.debug.start', title: 'Start Debugging', category: 'Debug', key: 'f5', run: () => debug.start() }),
		commands.register({ id: 'workbench.action.debug.run', title: 'Start Without Debugging', category: 'Debug', key: 'ctrl+f5', when: () => !debug.active, run: () => debug.start({ noDebug: true }) }),
		commands.register({ id: 'workbench.action.debug.stop', title: 'Stop', category: 'Debug', key: 'shift+f5', when: () => debug.active, run: () => debug.stop() }),
		commands.register({ id: 'workbench.action.debug.restart', title: 'Restart', category: 'Debug', key: 'cmd+shift+f5', when: () => debug.model !== null, run: () => debug.restart() }),
		// F5 while stopped is Continue: Start Debugging's F5 does it, so one key never maps to two native menu items.
		commands.register({ id: 'workbench.action.debug.continue', title: 'Continue', category: 'Debug', when: () => debug.stopped, run: () => debug.continue() }),
		commands.register({ id: 'workbench.action.debug.stepOver', title: 'Step Over', category: 'Debug', key: 'f10', when: () => debug.stopped, run: () => debug.stepOver() }),
		commands.register({ id: 'workbench.action.debug.stepInto', title: 'Step Into', category: 'Debug', key: 'f11', when: () => debug.stopped, run: () => debug.stepInto() }),
		commands.register({ id: 'workbench.action.debug.stepOut', title: 'Step Out', category: 'Debug', key: 'shift+f11', when: () => debug.stopped, run: () => debug.stepOut() }),
		commands.register({ id: 'workbench.action.debug.pause', title: 'Pause', category: 'Debug', key: 'f6', when: () => debug.running, run: () => debug.pause() }),
		commands.register({ id: 'editor.debug.action.toggleBreakpoint', title: 'Toggle Breakpoint', category: 'Debug', key: 'f9', when: () => isWorkspaceFile(editors.active), run: () => debug.toggleBreakpoint() }),
		commands.register({ id: 'editor.debug.action.conditionalBreakpoint', title: 'Add Conditional Breakpoint...', category: 'Debug', when: () => isWorkspaceFile(editors.active), run: () => debug.editCondition() }),
		commands.register({ id: 'editor.debug.action.triggerByBreakpoint', title: 'Add Triggered Breakpoint...', category: 'Debug', when: () => isWorkspaceFile(editors.active), run: () => debug.editTrigger() }),
		commands.register({ id: 'editor.debug.action.addLogPoint', title: 'Add Logpoint...', category: 'Debug', when: () => isWorkspaceFile(editors.active), run: () => debug.editLogMessage() }),
		commands.register({ id: 'workbench.debug.viewlet.action.removeAllBreakpoints', title: 'Remove All Breakpoints', category: 'Debug', run: () => debug.removeAllBreakpoints() }),
		commands.register({ id: 'workbench.action.debug.configure', title: 'Open launch.json', category: 'Debug', run: () => debug.openLaunchJson() }),
		commands.register({ id: 'workbench.view.debug', title: 'Show Run and Debug', category: 'View', key: 'cmd+shift+d', keyWhen: () => !appMode.isAgents, run: () => ((layout.sideView = 'debug'), (layout.sidebarVisible = true)) }),
		commands.register({ id: 'workbench.debug.action.toggleRepl', title: 'Focus on Debug Console View', category: 'View', run: () => layout.showPanel('debugConsole') })
	];
	return () => {
		disposeEffects();
		unregister.forEach((u) => u());
	};
}
