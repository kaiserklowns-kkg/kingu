// The debugger for the workbench (VS Code: IDebugService). Picks a launch configuration, starts the
// adapter through Rust `dap_start`, runs a DebugSession over it and exposes its state reactively
// for the Run and Debug view, the Debug Console, the editors' breakpoint glyphs and the status bar.
// One session at a time (Rust keeps a table, so more can come later).

import { Channel, invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { installItems, type InstallInfo } from '#lib/lsp/model.ts';
import { opensOnStart } from '#lib/settings/mappings.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { isDiffKey } from '#lib/workbench/scm.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import * as B from './breakpoints.ts';
import { DapClient } from './client.ts';
import { generatedConfigs, LAUNCH_FILES, parseLaunchJson, runInTerminalArgv, substitute, type Generated, type LaunchConfig } from './launch.ts';
import { appendOutput, currentFrame, frameLocation, initialModel, stateLabel, type DebugModel } from './model.ts';
import type { StackFrame } from './protocol.ts';
import { DebugSession } from './session.ts';

type DapEvent = { type: 'message'; json: string } | { type: 'stderr'; line: string } | { type: 'exit'; code: number | null };
type Active = { session: DebugSession; id: number | null; config: LaunchConfig; build?: string[]; noDebug: boolean };
export type WatchResult = { value: string; error?: boolean };

/** Start of Rust's "adapter not installed" error (`lsp::NOT_INSTALLED`). */
const NOT_INSTALLED = 'ไม่ได้ติดตั้ง';
const LAST_CONFIG = 'kingu.debug.lastConfig';
const WATCHES = 'kingu.debug.watches';

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
	/** For the `openOnFirstSessionStart` settings: sessions started since Kingu opened. */
	#sessionsStarted = 0;
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
		if (session) void session.setBreakpoints(this.#abs(rel), B.sourceBreakpoints(map[rel]));
	}

	/** F9 / glyph margin click; defaults to the active editor's cursor line. */
	toggleBreakpoint(rel = editors.active, line = editors.cursor.line) {
		if (!isWorkspaceFile(rel)) return;
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
			placeholder: `เงื่อนไขของ breakpoint บรรทัด ${line}${current ? ` (ตอนนี้: ${current})` : ''} — Enter ว่างเพื่อลบเงื่อนไข`,
			hint: (v) => (v ? `หยุดเมื่อ ${v}` : 'breakpoint ธรรมดา')
		});
		if (cond !== undefined) this.#setBreakpoints(B.setCondition(this.breakpoints, rel, line, cond), rel);
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
		if (this.active) return status.flash('มี debug session ทำงานอยู่แล้ว');
		const root = await this.#ensureRoot();
		if (!root) return status.flash('เปิดโฟลเดอร์ก่อนเริ่ม debug');
		const picked = await this.#pickConfig();
		if (!picked) return;
		// debug.saveBeforeStart
		if (settings.get('debug.saveBeforeStart') !== 'none' && editors.hasDirty()) await commands.run('workbench.action.files.saveAll');
		let { config } = picked;
		const { generated } = picked;
		const active = editors.active;
		const file = isWorkspaceFile(active) ? this.#abs(active) : undefined;
		const ctx = { workspaceFolder: root, file, env: await this.#env(config) };
		try {
			if (generated?.askProgram) {
				const suggestion = substitute(String(config.program ?? ''), ctx);
				const program = await quick.input({ placeholder: `พาธของโปรแกรมที่จะ debug (Enter ว่าง = ${suggestion})`, hint: (v) => `debug ${v || suggestion}` });
				if (program === undefined) return;
				config = { ...config, program: program ? (program.startsWith('/') ? program : `${root}/${program}`) : suggestion };
			}
			config = substitute(config, ctx);
		} catch (e) {
			return status.flash(e instanceof Error ? e.message : String(e));
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
				placeholder: 'เลือก launch configuration',
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
			status.flash('ไม่มี .vscode/launch.json — เปิดไฟล์ Rust, C/C++, Go หรือ Python แล้วกด F5 หรือใช้ Debug: Open launch.json');
			return;
		}
		return { config: gens[0].config, generated: gens[0] };
	}

	async #launch(config: LaunchConfig, noDebug: boolean, build?: string[]) {
		let model = initialModel();
		this.model = model;
		this.configName = config.name;
		this.watchResults = {};
		// debug.openDebug / debug.internalConsoleOptions (a launch config's own internalConsoleOptions wins).
		const first = this.#sessionsStarted++ === 0;
		if (opensOnStart(settings.get('debug.openDebug'), first)) {
			layout.sideView = 'debug';
			layout.sidebarVisible = true;
		}
		const consoleOption = typeof config.internalConsoleOptions === 'string' ? config.internalConsoleOptions : settings.get<string>('debug.internalConsoleOptions');
		if (config.console !== 'integratedTerminal' && opensOnStart(consoleOption, first)) layout.showPanel('debugConsole');
		const out = (category: string, text: string) => (this.model = model = appendOutput(this.model ?? model, category, text));
		if (config.preLaunchTask) out('console', `ข้าม preLaunchTask "${config.preLaunchTask}" (Kingu ยังไม่รองรับ tasks.json) — build เองก่อนถ้าจำเป็น\n`);
		if (build) {
			out('console', `> ${build.join(' ')}\n`);
			const res = await invoke<{ success: boolean; output: string }>('debug_build', { argv: build }).catch((e) => ({ success: false, output: `${e}\n` }));
			out(res.success ? 'stdout' : 'stderr', res.output);
			if (!res.success) {
				this.model = { ...this.model!, state: 'terminated' };
				return status.flash(`${build.join(' ')} ไม่ผ่าน — ดู Debug Console`);
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
						const bps = B.sourceBreakpoints(list);
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
					this.#reveal(frame);
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
			if (message.startsWith(NOT_INSTALLED)) void this.install(config.type);
			else status.flash(message);
			return;
		}
		try {
			await session.start();
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.#sessionOutput(session, 'stderr', `${message}\n`);
			status.flash(`เริ่ม debug ไม่ได้: ${message}`);
			await this.#kill(active);
		}
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
		setTimeout(() => active.id !== null && void invoke('dap_stop', { id: active.id }).catch(() => {}), 1000);
	}

	async #kill(active: Active) {
		await active.session.disconnect(1000);
		if (active.id !== null) await invoke('dap_stop', { id: active.id }).catch(() => {});
		active.session.exited(null);
		if (this.#active === active) this.model = active.session.model;
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

	#reveal(frame: StackFrame | null) {
		const loc = frameLocation(frame, this.root);
		if (loc) editors.open(loc.rel, { reveal: { line: loc.line, column: loc.column } });
		else if (frame?.source?.path) status.flash(`${frame.source.path} อยู่นอก workspace จึงเปิดไม่ได้`);
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
			if (this.model) this.model = appendOutput(this.model, 'stderr', 'ไม่มี debug session ที่ทำงานอยู่\n');
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
			return status.flash(String(e));
		}
		quick.pick({
			placeholder: res.methods.length ? `ไม่ได้ติดตั้ง ${res.server}: ติดตั้งด้วยคำสั่ง (รันใน terminal) แล้วกด F5 อีกครั้ง` : `ไม่ได้ติดตั้ง ${res.server} — ติดตั้ง ${res.binary} เองแล้วกด F5 อีกครั้ง`,
			items: installItems(res),
			onAccept: (item) => {
				const method = res.methods[Number(item.id)];
				if (!method) return;
				terminals.open({ title: `ติดตั้ง ${res.server}`, run: method.argv });
				layout.showPanel('terminal');
			}
		});
	}

	// --- launch.json -------------------------------------------------------------------------------

	/** Debug: Open launch.json — creates `.vscode/launch.json` with a configuration for the active file's language. */
	async openLaunchJson() {
		const root = await this.#ensureRoot();
		if (!root) return status.flash('เปิดโฟลเดอร์ก่อน');
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
				return status.flash(String(e));
			}
		}
		editors.open(rel, { preview: false });
	}
}

export const debug = new Debug();

/** Commands and keys (VS Code ids and default keybindings). Returns the uninstaller. */
export function installDebug(): () => void {
	debug.reset();
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
		commands.register({ id: 'workbench.debug.viewlet.action.removeAllBreakpoints', title: 'Remove All Breakpoints', category: 'Debug', run: () => debug.removeAllBreakpoints() }),
		commands.register({ id: 'workbench.action.debug.configure', title: 'Open launch.json', category: 'Debug', run: () => debug.openLaunchJson() }),
		commands.register({ id: 'workbench.view.debug', title: 'Show Run and Debug', category: 'View', key: 'cmd+shift+d', run: () => ((layout.sideView = 'debug'), (layout.sidebarVisible = true)) }),
		commands.register({ id: 'workbench.debug.action.toggleRepl', title: 'Focus on Debug Console View', category: 'View', run: () => layout.showPanel('debugConsole') })
	];
	return () => unregister.forEach((u) => u());
}
