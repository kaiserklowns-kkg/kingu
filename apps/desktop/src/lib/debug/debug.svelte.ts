// The debugger for the workbench (VS Code: IDebugService). Picks a launch configuration or compound,
// starts the adapter through Rust `dap_start`, runs a DebugSession over it and exposes the sessions'
// state reactively for the Run and Debug view, the Debug Console, the editors' breakpoint glyphs,
// hovers and the status bar. Several sessions run at once (compounds, a second F5, js-debug's child
// sessions over the same server); commands act on the focused one, like VS Code.

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
import { quick } from '#lib/workbench/quick.svelte.ts';
import { isDiffKey } from '#lib/workbench/scm.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import * as B from './breakpoints.ts';
import { DapClient } from './client.ts';
import {
	addConfigurationText,
	compoundConfigs,
	generatedConfigs,
	isJsDebugType,
	LAUNCH_FILES,
	parseLaunchJson,
	resolveJsDebug,
	runInTerminalArgv,
	snippetsFor,
	type Generated,
	type LaunchCompound,
	type LaunchConfig
} from './launch.ts';
import { appendOutput, currentFrame, frameLocation, initialModel, outputLimit, stateLabel, type DebugModel } from './model.ts';
import { canSetBreakpoint, editorsToSave, opensOnBreak } from './debugSettings.ts';
import { isUntitled } from '#lib/workbench/untitled.ts';
import type { BreakpointLocation, Capabilities, CompletionItem, DisassembledInstruction, Source, StackFrame, StartDebuggingArguments, SteppingGranularity } from './protocol.ts';
import { DebugSession, type EvaluateResult, type MemoryRead } from './session.ts';
import { instructionBreakpoints, setInstructionBreakpointEnabled, toggleInstructionBreakpoint, type InstructionBreakpointSpec } from './disassembly.ts';
import { DISASSEMBLY_KEY, memoryKey } from './memory.ts';
import { browserConfig, parseServerReadyAction, ServerReadyDetector, type ServerReadyAction, type ServerReadyMatch } from './serverReady.ts';
import { AUTO_ATTACH_FILTERS, autoAttachConfig, autoAttachEnv, debugTerminalConfig, type AutoAttachFilter } from './autoAttach.ts';
import { contributeTerminalEnv } from '#lib/terminal/contributedEnv.ts';
import { tapOutput } from '#lib/terminal/registry.ts';
import { openUrl } from '#lib/terminal/pty.ts';
import { shellFrom, shellPlatform } from '#lib/settings/mappings.ts';
import { editorKeyFor } from '#lib/workbench/externalFiles.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { lsp } from '#lib/lsp/lsp.svelte.ts';
import { parseProblemMatchers } from '#lib/tasks/problemMatcher.ts';
import { tasks } from '#lib/tasks/tasks.svelte.ts';
import { folderKey } from '#lib/tasks/folders.ts';
import type { InputDef, TaskRef } from '#lib/tasks/taskConfig.ts';
import { inputPrompter } from '#lib/tasks/inputPrompter.svelte.ts';
import { collectVariables, resolveInputs, substitute as substituteVariables } from '#lib/tasks/variables.ts';
import { choose } from '#lib/workbench/messageBox.ts';
import { workspaceTrust } from '#lib/workbench/workspaceTrust.svelte.ts';

type DapEvent = { type: 'message'; json: string } | { type: 'stderr'; line: string } | { type: 'exit'; code: number | null };
type Active = {
	key: number;
	session: DebugSession;
	/** Rust's session id once the adapter (or the child connection) is up. */
	id: number | null;
	config: LaunchConfig;
	build?: string[];
	noDebug: boolean;
	postDone?: boolean;
	/** js-debug's child sessions run over their parent's server. */
	parent: Active | null;
	/** A compound with `stopAll`: stopping one stops these. */
	group?: number;
	/** Auto attach's listener: not shown, never focused; its terminal is never opened. */
	hidden?: boolean;
	/** serverReadyAction with killOnServerStop: this session stops with that one. */
	stopWith?: Active;
	/** serverReadyAction's watcher (a child session shares its parent's, like VS Code's trigger). */
	detector?: ServerReadyDetector;
	/** Stops watching the session's integrated terminal. */
	untap?: () => void;
};
export type WatchResult = { value: string; error?: boolean };
/** One session in the Call Stack view. */
export type SessionView = { key: number; name: string; parentKey: number | null; model: DebugModel };
type DataBreakpointSpec = B.DataBreakpointSpec;
type JsDebugStatus = { version: string; url: string; bytes: number; sha256: string; server: string | null; node: string | null };

const LAST_CONFIG = 'kingu.debug.lastConfig';
const WATCHES = 'kingu.debug.watches';
const FUNCTION_BPS = 'kingu.debug.functionBreakpoints';
const EXCEPTIONS = 'kingu.debug.exceptionBreakpoints';
const ACTIVATED = 'kingu.debug.breakpointsActivated';

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

type Picked = { kind: 'config'; config: LaunchConfig; generated?: Generated } | { kind: 'compound'; compound: LaunchCompound; configs: LaunchConfig[] };

class Debug {
	/** The focused (or last) session's state; null before the first session in this folder. */
	model = $state.raw<DebugModel | null>(null);
	configName = $state('');
	/** For the `openOnFirstSessionStart` / `onFirstSessionStart` settings: sessions started since Kingu opened. */
	sessionsStarted = $state(0);
	breakpoints = $state.raw<B.BreakpointMap>({});
	functionBreakpoints = $state.raw<B.FunctionBreakpointSpec[]>([]);
	exceptions = $state.raw<B.ExceptionSettings>({ filters: [], state: {} });
	dataBreakpoints = $state.raw<DataBreakpointSpec[]>([]);
	/** VS Code's Toggle Activate Breakpoints: off sends none (they show disabled). */
	breakpointsActivated = $state(true);
	watches = $state<string[]>([]);
	watchResults = $state.raw<Record<string, WatchResult>>({});
	root = $state('');
	/** Live sessions, for the Call Stack view. */
	sessions = $state.raw<SessionView[]>([]);
	focusedKey = $state<number | null>(null);
	/** The focused session's capabilities (toolbar and context menus show what it can do). */
	capabilities = $state.raw<Capabilities>({});
	/** The Disassembly view's breakpoints, by address (for the sessions of this window). */
	instructionBreakpoints = $state.raw<InstructionBreakpointSpec[]>([]);
	/** The Disassembly view has focus: stepping goes by instruction (VS Code). */
	disassemblyFocused = $state(false);
	/** Auto attach's environment for new terminals while it is on (`debug.javascript.autoAttachFilter`). */
	autoAttach = $state.raw<{ filter: AutoAttachFilter; env: Record<string, string> | null }>({ filter: 'disabled', env: null });

	/** A session exists and has not terminated. */
	active = $derived(this.sessions.some((s) => s.model.state !== 'terminated'));
	stopped = $derived(this.model?.state === 'stopped');
	running = $derived(this.model?.state === 'running' || this.model?.state === 'initializing');
	stoppedLocation = $derived(this.model ? frameLocation(currentFrame(this.model), this.root) : null);
	/** The selected frame's instruction pointer (the Disassembly view centers on it). */
	instructionPointer = $derived(this.model?.state === 'stopped' ? (currentFrame(this.model)?.instructionPointerReference ?? null) : null);
	label = $derived(stateLabel(this.model));

	#all: Active[] = [];
	#nextKey = 1;
	#nextGroup = 1;
	/** Breakpoints hit in this session (`rel:line`): their triggered breakpoints are now sent. */
	triggered = $state.raw<ReadonlySet<string>>(new Set());
	#rootLoaded: Promise<string> | undefined;

	// --- Folder ------------------------------------------------------------------------------------

	async #ensureRoot(): Promise<string> {
		this.#rootLoaded ??= invoke<{ workspace: string }>('app_info').then((i) => {
			this.root = i.workspace;
			const r = this.root;
			this.breakpoints = B.parseStored(r ? load(B.storageKey(r)) : null);
			this.functionBreakpoints = B.parseFunctionBreakpoints(r ? load(`${FUNCTION_BPS}:${r}`) : null);
			this.exceptions = B.parseExceptionSettings(r ? load(`${EXCEPTIONS}:${r}`) : null);
			this.breakpointsActivated = (r ? load(`${ACTIVATED}:${r}`) : null) !== 'false';
			try {
				const w = JSON.parse(load(`${WATCHES}:${r}`) ?? '[]');
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
		this.#all = [];
		this.sessions = [];
		this.focusedKey = null;
		this.model = null;
		this.configName = '';
		this.watchResults = {};
		this.dataBreakpoints = [];
		this.#rootLoaded = undefined;
		void this.#ensureRoot();
	}

	/** A breakpoint's file on disk; another root folder's file (multi-root) is absolute already. */
	#abs(rel: string) {
		return rel.startsWith('/') ? rel : `${this.root}/${rel}`;
	}

	#live(): Active[] {
		return this.#all.filter((a) => a.session.model.state !== 'terminated');
	}

	/** The live sessions the user sees (not auto attach's listener). */
	#shown(): Active[] {
		return this.#live().filter((a) => !a.hidden);
	}

	#focused(): Active | undefined {
		return this.#all.find((a) => a.key === this.focusedKey);
	}

	/** Focuses a session (Call Stack click, a stop): the views follow its model. */
	focusSession(key: number) {
		const a = this.#all.find((x) => x.key === key);
		if (!a) return;
		this.focusedKey = key;
		this.model = a.session.model;
		this.configName = a.config.name;
		this.capabilities = a.session.capabilities;
	}

	#publish(a: Active) {
		if (a.hidden) return;
		const view: SessionView = { key: a.key, name: a.config.name, parentKey: a.parent?.key ?? null, model: a.session.model };
		const at = this.sessions.findIndex((s) => s.key === a.key);
		this.sessions = at < 0 ? [...this.sessions, view] : this.sessions.map((s, i) => (i === at ? view : s));
		if (this.focusedKey === a.key) {
			this.model = a.session.model;
			this.capabilities = a.session.capabilities;
		}
	}

	// --- Breakpoints -------------------------------------------------------------------------------

	#sourceFor(rel: string) {
		return B.sourceBreakpoints(this.breakpoints[rel], this.triggered, this.breakpointsActivated);
	}

	#setBreakpoints(map: B.BreakpointMap, rel: string) {
		this.breakpoints = map;
		if (this.root) save(B.storageKey(this.root), JSON.stringify(map));
		for (const a of this.#live()) void a.session.setBreakpoints(this.#abs(rel), this.#sourceFor(rel));
	}

	#resendAll() {
		const files = new Set([...Object.keys(this.breakpoints), ...this.#live().flatMap((a) => Object.keys(a.session.model.verified).map((p) => (p.startsWith(`${this.root}/`) ? p.slice(this.root.length + 1) : p)))]);
		for (const rel of files) for (const a of this.#live()) void a.session.setBreakpoints(this.#abs(rel), this.#sourceFor(rel));
		this.#sendFunctionBreakpoints();
		this.#sendDataBreakpoints();
		this.#sendInstructionBreakpoints();
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

	/** Shift+F9 (VS Code: Toggle Inline Breakpoint): a breakpoint at the cursor's column. */
	toggleInlineBreakpoint(rel = editors.active, line = editors.cursor.line, column = editors.cursor.column, language = editors.language) {
		if (!isWorkspaceFile(rel)) return;
		const has = this.breakpoints[rel]?.some((b) => b.line === line && (b.column ?? 1) === Math.max(1, column));
		if (!has && !canSetBreakpoint(language, settings.get<boolean>('debug.allowBreakpointsEverywhere'))) {
			status.flash(t('tools.debug.cantSetBreakpoint', { language }));
			return;
		}
		void this.#ensureRoot().then(() => this.#setBreakpoints(B.toggleInline(this.breakpoints, rel, line, column), rel));
	}

	/** Where on a line the focused session can break (inline breakpoint candidates); [] without one. */
	breakpointLocations(rel: string, line: number): Promise<BreakpointLocation[]> {
		const session = this.#session();
		if (!session || !isWorkspaceFile(rel)) return Promise.resolve([]);
		return session.breakpointLocations(this.#abs(rel), line);
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
		this.functionBreakpoints = [];
		this.dataBreakpoints = [];
		this.instructionBreakpoints = [];
		this.#sendInstructionBreakpoints();
		if (this.root) {
			save(B.storageKey(this.root), '{}');
			save(`${FUNCTION_BPS}:${this.root}`, '[]');
		}
		for (const rel of files) for (const a of this.#live()) void a.session.setBreakpoints(this.#abs(rel), []);
		this.#sendFunctionBreakpoints();
		this.#sendDataBreakpoints();
	}

	/** Enable All Breakpoints / Disable All Breakpoints (source, function and data ones). */
	setAllBreakpointsEnabled(enabled: boolean) {
		this.breakpoints = B.setAllEnabled(this.breakpoints, enabled);
		this.functionBreakpoints = this.functionBreakpoints.map((f) => ({ ...f, enabled }));
		this.dataBreakpoints = this.dataBreakpoints.map((d) => ({ ...d, enabled }));
		this.instructionBreakpoints = this.instructionBreakpoints.map((b) => ({ ...b, enabled }));
		this.#saveAll();
		this.#resendAll();
	}

	/** Toggle Activate Breakpoints: none are sent while deactivated; they stay as they are. */
	toggleBreakpointsActivated() {
		this.breakpointsActivated = !this.breakpointsActivated;
		if (this.root) save(`${ACTIVATED}:${this.root}`, String(this.breakpointsActivated));
		this.#resendAll();
	}

	#saveAll() {
		if (!this.root) return;
		save(B.storageKey(this.root), JSON.stringify(this.breakpoints));
		save(`${FUNCTION_BPS}:${this.root}`, JSON.stringify(this.functionBreakpoints));
	}

	async #editField(rel: string | null, line: number, field: 'condition' | 'hitCondition' | 'logMessage') {
		if (!isWorkspaceFile(rel)) return;
		await this.#ensureRoot();
		const current = this.breakpoints[rel]?.find((b) => b.line === line)?.[field] ?? '';
		const now = current ? t('tools.debug.current', { value: current }) : '';
		const prompts = {
			condition: {
				placeholder: t('tools.debug.conditionPlaceholder', { line, current: now }),
				hint: (v: string) => (v ? t('tools.debug.conditionHint', { condition: v }) : t('tools.debug.plainBreakpoint'))
			},
			hitCondition: {
				placeholder: t('debugger.hitCountPlaceholder', { line, current: now }),
				hint: (v: string) => (v ? t('debugger.hitCountHint', { hits: v }) : t('tools.debug.plainBreakpoint'))
			},
			logMessage: {
				placeholder: t('tools.debug.logPlaceholder', { line, current: now, example: `{${t('tools.debug.expression')}}` }),
				hint: (v: string) => (v ? `log ${v}` : t('tools.debug.plainBreakpoint'))
			}
		};
		const value = await quick.input({ ...prompts[field], value: current });
		if (value === undefined) return;
		const set = field === 'condition' ? B.setCondition : field === 'hitCondition' ? B.setHitCondition : B.setLogMessage;
		this.#setBreakpoints(set(this.breakpoints, rel, line, value), rel);
	}

	/** Conditional breakpoint on the cursor line (VS Code: Add Conditional Breakpoint…). */
	editCondition(rel = editors.active, line = editors.cursor.line) {
		return this.#editField(rel, line, 'condition');
	}

	/** Hit count breakpoint (VS Code's breakpoint widget, Hit Count). */
	editHitCondition(rel = editors.active, line = editors.cursor.line) {
		return this.#editField(rel, line, 'hitCondition');
	}

	/** Logpoint on the cursor line (VS Code: Add Logpoint…): `{expr}` in the message is evaluated. */
	editLogMessage(rel = editors.active, line = editors.cursor.line) {
		return this.#editField(rel, line, 'logMessage');
	}

	/** Edit Breakpoint (VS Code's breakpoint widget): pick Expression, Hit Count or Log Message, then edit it. */
	async editBreakpoint(rel = editors.active, line = editors.cursor.line) {
		if (!isWorkspaceFile(rel)) return;
		const kind = await quick.choose({
			placeholder: t('debugger.editKind', { line }),
			items: [
				{ id: 'condition', label: t('debugger.kind.expression') },
				{ id: 'hitCondition', label: t('debugger.kind.hitCount') },
				{ id: 'logMessage', label: t('debugger.kind.logMessage') },
				{ id: 'triggeredBy', label: t('debugger.kind.waitFor') }
			]
		});
		if (!kind) return;
		if (kind.id === 'triggeredBy') return this.editTrigger(rel, line);
		return this.#editField(rel, line, kind.id as 'condition' | 'hitCondition' | 'logMessage');
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

	// Function breakpoints

	#sendFunctionBreakpoints() {
		const bps = B.functionBreakpoints(this.functionBreakpoints, this.breakpointsActivated);
		for (const a of this.#live()) void a.session.setFunctionBreakpoints(bps);
	}

	#setFunctionBreakpoints(list: B.FunctionBreakpointSpec[]) {
		this.functionBreakpoints = list;
		if (this.root) save(`${FUNCTION_BPS}:${this.root}`, JSON.stringify(list));
		this.#sendFunctionBreakpoints();
	}

	/** Add Function Breakpoint: the debugger stops when a function of that name is entered. */
	async addFunctionBreakpoint() {
		await this.#ensureRoot();
		const name = await quick.input({ placeholder: t('debugger.functionPlaceholder'), hint: (v) => (v ? t('debugger.functionHint', { name: v }) : t('debugger.functionPlaceholder')) });
		if (name?.trim()) this.#setFunctionBreakpoints(B.addFunctionBreakpoint(this.functionBreakpoints, name));
	}

	setFunctionBreakpointEnabled(name: string, enabled: boolean) {
		this.#setFunctionBreakpoints(this.functionBreakpoints.map((f) => (f.name === name ? { ...f, enabled } : f)));
	}

	removeFunctionBreakpoint(name: string) {
		this.#setFunctionBreakpoints(this.functionBreakpoints.filter((f) => f.name !== name));
	}

	async editFunctionCondition(name: string) {
		const f = this.functionBreakpoints.find((x) => x.name === name);
		if (!f) return;
		const cond = await quick.input({ placeholder: t('debugger.functionCondition', { name }), value: f.condition ?? '', hint: (v) => (v ? t('tools.debug.conditionHint', { condition: v }) : t('tools.debug.plainBreakpoint')) });
		if (cond !== undefined) this.#setFunctionBreakpoints(this.functionBreakpoints.map((x) => (x.name === name ? { ...x, condition: cond.trim() || undefined } : x)));
	}

	/** The adapter's answer for a function breakpoint (focused session), or undefined outside one. */
	functionVerified(name: string) {
		if (!this.active || !this.model) return undefined;
		const sent = B.functionBreakpoints(this.functionBreakpoints, this.breakpointsActivated);
		const i = sent.findIndex((f) => f.name === name);
		return i < 0 ? undefined : (this.model.functionVerified[i] ?? null);
	}

	// Exception breakpoints

	/** A session's filters (remembered for the Breakpoints view) and the arguments to send. */
	#exceptionArgs(caps: Capabilities) {
		const filters = caps.exceptionBreakpointFilters ?? [];
		if (filters.length && JSON.stringify(filters) !== JSON.stringify(this.exceptions.filters)) {
			this.exceptions = { ...this.exceptions, filters };
			if (this.root) save(`${EXCEPTIONS}:${this.root}`, JSON.stringify(this.exceptions));
		}
		return B.exceptionArgs(filters, this.exceptions.state, caps);
	}

	setExceptionFilter(filter: string, enabled: boolean, condition?: string) {
		this.exceptions = { ...this.exceptions, state: B.setException(this.exceptions.state, filter, enabled, condition) };
		if (this.root) save(`${EXCEPTIONS}:${this.root}`, JSON.stringify(this.exceptions));
		for (const a of this.#live()) {
			const filters = a.session.capabilities.exceptionBreakpointFilters;
			if (filters?.some((f) => f.filter === filter)) void a.session.setExceptionBreakpoints(B.exceptionArgs(filters, this.exceptions.state, a.session.capabilities));
		}
	}

	async editExceptionCondition(filter: string) {
		const f = this.exceptions.filters.find((x) => x.filter === filter);
		if (!f?.supportsCondition) return;
		const current = this.exceptions.state[filter]?.condition ?? '';
		const cond = await quick.input({ placeholder: f.conditionDescription ?? t('debugger.exceptionCondition', { label: f.label }), value: current, hint: (v) => (v ? t('tools.debug.conditionHint', { condition: v }) : f.label) });
		if (cond !== undefined) this.setExceptionFilter(filter, true, cond);
	}

	// Data breakpoints

	#sendDataBreakpoints() {
		const bps = B.dataBreakpoints(this.dataBreakpoints, this.breakpointsActivated);
		const a = this.#focused();
		if (a && a.session.model.state !== 'terminated') void a.session.setDataBreakpoints(bps);
	}

	/** Whether "Break on Value Change" applies to a variable (the focused session supports data breakpoints). */
	get dataBreakpointsSupported() {
		return !!this.capabilities.supportsDataBreakpoints && this.stopped;
	}

	/** Variables view: Break on Value Change / Read / Access (VS Code: dataBreakpointInfo, setDataBreakpoints). */
	async addDataBreakpoint(parentRef: number, name: string) {
		const session = this.#focused()?.session;
		if (!session) return;
		const info = await session.dataBreakpointInfo(parentRef, name);
		if (!info?.dataId) return status.flash(info?.description || t('debugger.dataUnsupported'));
		const accessTypes = info.accessTypes?.length ? info.accessTypes : ['write' as const];
		let accessType = accessTypes[0];
		if (accessTypes.length > 1) {
			const label = { write: t('debugger.data.write'), read: t('debugger.data.read'), readWrite: t('debugger.data.readWrite') };
			const pick = await quick.choose({ placeholder: info.description, items: accessTypes.map((a) => ({ id: a, label: label[a] })) });
			if (!pick) return;
			accessType = pick.id as typeof accessType;
		}
		if (this.dataBreakpoints.some((d) => d.dataId === info.dataId && d.accessType === accessType)) return;
		this.dataBreakpoints = [...this.dataBreakpoints, { dataId: info.dataId, description: info.description, accessType, enabled: true, canPersist: !!info.canPersist }];
		this.#sendDataBreakpoints();
	}

	setDataBreakpointEnabled(dataId: string, enabled: boolean) {
		this.dataBreakpoints = this.dataBreakpoints.map((d) => (d.dataId === dataId ? { ...d, enabled } : d));
		this.#sendDataBreakpoints();
	}

	removeDataBreakpoint(dataId: string) {
		this.dataBreakpoints = this.dataBreakpoints.filter((d) => d.dataId !== dataId);
		this.#sendDataBreakpoints();
	}

	// Instruction breakpoints (the Disassembly view)

	#sendInstructionBreakpoints() {
		const bps = instructionBreakpoints(this.instructionBreakpoints, this.breakpointsActivated);
		for (const a of this.#live()) void a.session.setInstructionBreakpoints(bps);
	}

	toggleInstructionBreakpoint(address: string) {
		this.instructionBreakpoints = toggleInstructionBreakpoint(this.instructionBreakpoints, address);
		this.#sendInstructionBreakpoints();
	}

	setInstructionBreakpointEnabled(address: string, enabled: boolean) {
		this.instructionBreakpoints = setInstructionBreakpointEnabled(this.instructionBreakpoints, address, enabled);
		this.#sendInstructionBreakpoints();
	}

	removeInstructionBreakpoint(address: string) {
		this.instructionBreakpoints = this.instructionBreakpoints.filter((b) => b.address !== address);
		this.#sendInstructionBreakpoints();
	}

	// --- Disassembly, memory and loaded scripts ----------------------------------------------------

	/** Instructions around a reference in the focused session ([] when it cannot disassemble). */
	disassemble(memoryReference: string, instructionOffset: number, count: number): Promise<DisassembledInstruction[]> {
		return this.#session()?.disassemble(memoryReference, instructionOffset, count).catch(() => []) ?? Promise.resolve([]);
	}

	/** Debug: Open Disassembly View (needs a stop with an instruction pointer and an adapter that disassembles). */
	openDisassembly() {
		if (!this.capabilities.supportsDisassembleRequest) return status.flash(t('debugExtras.disassembly.unsupported'));
		editors.open(DISASSEMBLY_KEY, { preview: false });
	}

	/** Variables view: View Binary Data (VS Code: workbench.debug.viewlet.action.viewMemory). */
	viewMemory(memoryReference: string) {
		if (this.focusedKey === null || !this.capabilities.supportsReadMemoryRequest) return status.flash(t('debugExtras.memory.unsupported'));
		editors.open(memoryKey(this.focusedKey, memoryReference), { preview: false });
	}

	#byKey(key: number) {
		return this.#all.find((a) => a.key === key && a.session.model.state !== 'terminated')?.session;
	}

	/** Whether a session (by key) is live, and what it can do with memory. */
	memorySupport(key: number): { live: boolean; write: boolean } {
		const s = this.#byKey(key);
		return { live: !!s, write: !!s?.capabilities.supportsWriteMemoryRequest };
	}

	readMemory(key: number, memoryReference: string, offset: number, count: number): Promise<MemoryRead | null> {
		return this.#byKey(key)?.readMemory(memoryReference, offset, count) ?? Promise.resolve(null);
	}

	async writeMemory(key: number, memoryReference: string, offset: number, bytes: Uint8Array): Promise<number> {
		const s = this.#byKey(key);
		if (!s) return 0;
		const n = await s.writeMemory(memoryReference, offset, bytes);
		void this.#evaluateWatches();
		return n;
	}

	#memoryListeners = new Set<(key: number, memoryReference: string, offset: number, count: number) => void>();
	/** The adapter's `memory` events (the Memory view reads the bytes again). Returns the unsubscriber. */
	onMemory(fn: (key: number, memoryReference: string, offset: number, count: number) => void): () => void {
		this.#memoryListeners.add(fn);
		return () => this.#memoryListeners.delete(fn);
	}

	/** Loaded Scripts of the focused session (fetched once, then kept by its events). */
	async loadedSources(): Promise<Source[]> {
		return this.#session()?.loadedSources() ?? [];
	}

	/** A loaded script clicked: the file (in the folder or outside it), else the adapter's text in an untitled editor. */
	async openSource(source: Source) {
		if (source.path?.startsWith('/')) return editors.open(editorKeyFor(source.path, this.root || null), { preview: true });
		const session = this.#session();
		const content = session ? await session.source(source) : null;
		if (!content) return status.flash(t('debugExtras.loadedScripts.noContent', { name: source.name ?? source.path ?? '?' }));
		const { openUntitledWith } = await import('./debugUntitled.ts');
		await openUntitledWith(content.content, source.name ?? 'source');
	}

	// --- Starting ----------------------------------------------------------------------------------

	/** F5: continue when stopped, else start a session (VS Code: Start Debugging / Continue). */
	async start({ noDebug = false, pick = false } = {}) {
		if (this.stopped && !pick) return this.continue();
		const root = await this.#ensureRoot();
		if (!root) return status.flash(t('tools.debug.openFolderFirst'));
		// Restricted Mode does not debug (VS Code asks to trust the workspace first).
		if (!(await workspaceTrust.request(t('trust.feature.debug')))) return;
		const picked = await this.#pickConfig(pick);
		if (!picked) return;
		// debug.saveBeforeStart: the dirty editors of the active group (untitled ones ask where to save).
		const toSave = editorsToSave(settings.get<string>('debug.saveBeforeStart'), editors.tabs.map((t) => t.path), (p) => editors.isDirty(p), isUntitled);
		if (toSave.length) {
			const { saveFile } = await import('#lib/workbench/editorModels.ts');
			for (const path of toSave) await saveFile(path, 'explicit');
		}
		if (picked.kind === 'compound') return this.#startCompound(picked.compound, picked.configs, noDebug);
		// VS Code asks before starting a configuration that is already running.
		if (this.#live().some((a) => !a.parent && a.config.name === picked.config.name)) {
			const again = t('debugger.startAnother');
			if ((await choose(t('debugger.alreadyRunning', { name: picked.config.name }), { kind: 'info', buttons: [again, t('common.cancel')], cancelId: 1 })) !== again) return;
		}
		const config = await this.#prepare(picked.config, picked.generated);
		if (config) await this.#launch(config, noDebug, picked.generated?.build);
	}

	/** Debugs a configuration made elsewhere (the Testing view's Debug Test, serverReadyAction, the JavaScript Debug Terminal). */
	startConfig(config: LaunchConfig) {
		return this.#startConfig(config);
	}

	async #startConfig(config: LaunchConfig, opts: { stopWith?: Active; hidden?: boolean } = {}) {
		if (!(await this.#ensureRoot())) return status.flash(t('tools.debug.openFolderFirst'));
		if (!(await workspaceTrust.request(t('trust.feature.debug')))) return;
		const prepared = await this.#prepare(config);
		if (prepared) await this.#launch(prepared, false, undefined, opts);
	}

	/** launch.json's `inputs`, from the last read of the launch files. */
	#launchInputs: InputDef[] = [];

	/**
	 * Variables (tasks.json's resolver: `${input:…}` from launch.json's inputs, `${command:pickProcess}`,
	 * `${config:…}`…), js-debug's defaults; undefined when cancelled or invalid. Inputs are asked once
	 * per launch, in order (VS Code: configurationResolver.resolveWithInteractionReplace).
	 */
	async #prepare(raw: LaunchConfig, generated?: Generated): Promise<LaunchConfig | undefined> {
		// Multi-root: the configuration's own folder (a workspace file's has none: ${workspaceFolder} must name one).
		const folder = this.#folderOfConfig(raw);
		const root = folder ?? this.root;
		let config = raw;
		try {
			const used = collectVariables(config);
			const ctx = await tasks.variableContext(folder, used.has('defaultBuildTask'));
			ctx.env = await this.#env(config);
			const answers = await resolveInputs(used, this.#launchInputs, ctx, inputPrompter());
			if (!answers) return undefined;
			if (generated?.askProgram) {
				const suggestion = substituteVariables(String(config.program ?? ''), ctx, answers);
				const program = await quick.input({ placeholder: t('tools.debug.programPlaceholder', { suggestion }), hint: (v) => t('tools.debug.programHint', { program: v || suggestion }) });
				if (program === undefined) return undefined;
				config = { ...config, program: program ? (program.startsWith('/') ? program : `${root}/${program}`) : suggestion };
			}
			config = substituteVariables(config, ctx, answers);
		} catch (e) {
			notifications.error(e instanceof Error ? e.message : String(e));
			return undefined;
		}
		const prepared = resolveJsDebug(config, root);
		// Its preLaunchTask / postDebugTask resolve in the same folder.
		this.#configFolder.set(prepared, folder);
		return prepared;
	}

	/** A compound: its preLaunchTask once, then each configuration (VS Code: debugService.startDebugging for a compound). */
	async #startCompound(compound: LaunchCompound, configs: LaunchConfig[], noDebug: boolean) {
		if (compound.preLaunchTask && !(await this.#runPreLaunchTask(compound.preLaunchTask as TaskRef, this.#folderOfConfig(compound)))) return;
		const group = compound.stopAll ? this.#nextGroup++ : undefined;
		for (const c of configs) {
			const config = await this.#prepare(c);
			if (config) await this.#launch(config, noDebug, undefined, { group });
		}
	}

	/** `${env:X}` values from the app's environment (login-shell PATH), only the names the config uses. */
	async #env(config: LaunchConfig): Promise<Record<string, string>> {
		const names = [...new Set([...JSON.stringify(config).matchAll(/\$\{env:([^}]+)\}/g)].map((m) => m[1]))];
		if (!names.length) return {};
		return invoke<Record<string, string>>('debug_env', { names }).catch(() => ({}));
	}

	/** The root folder (absolute) a configuration came from; a `.code-workspace` file's has none. */
	#configFolder = new WeakMap<object, string | undefined>();
	/** Every root folder's name by path (compounds name folders; the picker shows them in a multi-root window). */
	#folderNames = new Map<string, string>();

	/** The folder a configuration's variables, defaults and preLaunchTask use (its launch.json's; the first folder for one made here). */
	#folderOfConfig(config: object): string | undefined {
		return this.#configFolder.has(config) ? this.#configFolder.get(config) : this.root || undefined;
	}

	/** Every root folder's launch files, then the `.code-workspace` file's `launch` (VS Code multi-root). */
	async #readLaunchFiles(): Promise<{ configs: LaunchConfig[]; compounds: LaunchCompound[] }> {
		const configs: LaunchConfig[] = [];
		const compounds: LaunchCompound[] = [];
		const inputs: InputDef[] = [];
		const folders = await tasks.folders();
		const multi = folders.length > 1;
		this.#folderNames = new Map(folders.map((f) => [f.path, f.name]));
		const add = (text: string, source: string, folder: string | undefined) => {
			const parsed = parseLaunchJson(text, source);
			if (parsed.error) status.flash(parsed.error);
			for (const c of parsed.configs) this.#configFolder.set(c, folder);
			for (const c of parsed.compounds) this.#configFolder.set(c, folder);
			configs.push(...parsed.configs);
			compounds.push(...parsed.compounds);
			inputs.push(...parsed.inputs.filter((i) => !inputs.some((x) => x.id === i.id)));
		};
		for (const [i, folder] of folders.entries()) {
			for (const rel of LAUNCH_FILES) {
				// The first folder's files are relative; another root folder's absolute (workspaceFolders.ts).
				const key = i === 0 ? rel : `${folder.path}/${rel}`;
				const text = await invoke<string>('read_workspace_file', { rel: key }).catch(() => null);
				if (text !== null) add(text, multi ? `${folder.name}/${rel}` : rel, folder.path);
			}
		}
		const section = await tasks.workspaceSection('launch');
		if (section) add(section.text, section.name, undefined);
		this.#launchInputs = inputs;
		return { configs, compounds };
	}

	/** A picker row's description: the configuration's folder in a multi-root workspace (VS Code), then `what`. */
	#describe(config: object, what: string): string {
		if (this.#folderNames.size < 2) return what;
		const folder = this.#configFolder.get(config);
		return `${folder === undefined ? t('ideTasks.pick.workspace') : (this.#folderNames.get(folder) ?? folder)} · ${what}`;
	}

	async #pickConfig(always = false): Promise<Picked | undefined> {
		const { configs, compounds } = await this.#readLaunchFiles();
		const lastKey = `${LAST_CONFIG}:${this.root}`;
		const total = configs.length + compounds.length;
		if (total === 1 && !always) return configs.length ? { kind: 'config', config: configs[0] } : this.#compound(compounds[0], configs);
		if (total > 0) {
			const last = load(lastKey);
			const items = [
				...configs.map((c, i) => ({ id: `c${i}`, label: c.name, description: this.#describe(c, c.type) })),
				...compounds.map((c, i) => ({ id: `k${i}`, label: c.name, description: this.#describe(c, t('debugger.compound')) }))
			];
			const item = await quick.choose({ placeholder: t('tools.debug.pickConfig'), items, activeId: items.find((i) => i.label === last)?.id ?? items[0].id });
			if (!item) return;
			save(lastKey, item.label);
			const i = Number(item.id.slice(1));
			return item.id.startsWith('c') ? { kind: 'config', config: configs[i] } : this.#compound(compounds[i], configs);
		}
		const language = editors.language;
		const cargoToml = language === 'rust' ? await invoke<string>('read_workspace_file', { rel: 'Cargo.toml' }).catch(() => null) : null;
		const gens = generatedConfigs(isWorkspaceFile(editors.active) ? language : '', { cargoToml });
		if (!gens.length) {
			status.flash(t('tools.debug.noLaunchJson'));
			return;
		}
		return { kind: 'config', config: gens[0].config, generated: gens[0] };
	}

	#compound(compound: LaunchCompound, all: LaunchConfig[]): Picked | undefined {
		const origin = { folderOf: (c: object) => this.#configFolder.get(c), nameOf: (folder: string) => this.#folderNames.get(folder) ?? folder };
		const { configs, missing, ambiguous } = compoundConfigs(compound, all, origin);
		if (missing.length) {
			notifications.error(t('debugger.compoundMissing', { name: compound.name, missing: missing.join(', ') }));
			return;
		}
		if (ambiguous.length) {
			notifications.error(t('debugger.compoundAmbiguous', { name: compound.name, names: ambiguous.join(', ') }));
			return;
		}
		return { kind: 'compound', compound, configs };
	}

	/** Starts a session (with `parent`: a child connection to the parent's adapter server). */
	async #launch(config: LaunchConfig, noDebug: boolean, build?: string[], opts: { parent?: Active; group?: number; stopWith?: Active; hidden?: boolean } = {}) {
		const parent = opts.parent ?? null;
		const hidden = !!opts.hidden;
		const pendingModel = initialModel();
		if (!parent && !hidden) {
			this.triggered = this.#live().length ? this.triggered : new Set();
			this.watchResults = {};
			// The console shows the starting session's output from its first line.
			this.focusedKey = null;
			this.model = pendingModel;
			this.configName = config.name;
		}
		let model = pendingModel;
		// debug.openDebug / debug.internalConsoleOptions (a launch config's own internalConsoleOptions wins).
		if (!parent && !hidden) {
			const first = this.sessionsStarted++ === 0;
			if (opensOnStart(settings.get('debug.openDebug'), first)) {
				layout.sideView = 'debug';
				layout.sidebarVisible = true;
			}
			const consoleOption = typeof config.internalConsoleOptions === 'string' ? config.internalConsoleOptions : settings.get<string>('debug.internalConsoleOptions');
			if (config.console !== 'integratedTerminal' && opensOnStart(consoleOption, first)) layout.showPanel('debugConsole');
		}
		const out = (category: string, text: string) => {
			model = appendOutput(model, category, text);
			if (this.focusedKey === null) this.model = model;
		};
		// VS Code's DebugTaskRunner: the preLaunchTask runs (a background one until its watcher is idle) before the adapter starts.
		if (config.preLaunchTask && !parent) {
			out('console', t('ideTasks.debug.running', { task: taskName(config.preLaunchTask) }));
			if (!(await this.#runPreLaunchTask(config.preLaunchTask as TaskRef, this.#folderOfConfig(config)))) {
				if (this.focusedKey === null) this.model = { ...model, state: 'terminated' };
				return;
			}
		}
		if (build) {
			out('console', `> ${build.join(' ')}\n`);
			const res = await invoke<{ success: boolean; output: string }>('debug_build', { argv: build }).catch((e) => ({ success: false, output: `${e}\n` }));
			out(res.success ? 'stdout' : 'stderr', res.output);
			if (!res.success) {
				if (this.focusedKey === null) this.model = { ...model, state: 'terminated' };
				return status.flash(t('tools.debug.buildFailed', { command: build.join(' ') }));
			}
		}

		let id: number | null = null;
		let chain: Promise<unknown> = Promise.resolve();
		// Sends are chained so the adapter sees them in order (separate IPC calls may not be).
		const write = (json: string) => {
			chain = chain.then(() => (id === null ? undefined : invoke('dap_send', { id, message: json }))).catch((e) => this.#sessionOutput(active, 'stderr', `send: ${e}\n`));
		};
		const client = new DapClient(write);
		const session: DebugSession = new DebugSession(
			client,
			config,
			{
				breakpoints: () => {
					const all: Record<string, ReturnType<typeof B.sourceBreakpoints>> = {};
					for (const rel of Object.keys(this.breakpoints)) {
						const bps = this.#sourceFor(rel);
						if (bps.length) all[this.#abs(rel)] = bps;
					}
					return all;
				},
				functionBreakpoints: () => B.functionBreakpoints(this.functionBreakpoints, this.breakpointsActivated),
				exceptionArgs: (caps) => this.#exceptionArgs(caps),
				dataBreakpoints: () => B.dataBreakpoints(this.dataBreakpoints.filter((d) => d.canPersist), this.breakpointsActivated),
				instructionBreakpoints: () => instructionBreakpoints(this.instructionBreakpoints, this.breakpointsActivated),
				runInTerminal: async (args) => {
					// Auto attach: no terminal, its environment goes to the terminals started from now on.
					if (hidden) {
						this.#autoAttachRaw = args.env ?? {};
						this.#applyAutoAttach();
						return {};
					}
					// In the configuration's folder (multi-root), where its program runs.
					const id = terminals.open({ title: args.title ?? `Debug: ${config.name}`, run: runInTerminalArgv(args), folder: this.#folderOfConfig(config) });
					layout.showPanel('terminal');
					// serverReadyAction reads the integrated terminal too.
					const detector = active.detector;
					if (detector && !detector.fired) {
						active.untap?.();
						active.untap = tapOutput(terminals.key(id), (chunk) => detector.feed(chunk));
					}
					return {};
				},
				output: (text) => active.detector?.feed(text),
				memory: (ref, offset, count) => this.#memoryListeners.forEach((fn) => fn(active.key, ref, offset, count)),
				// Answered once the child session has started (VS Code's rawDebugSession does the same).
				startDebugging: (args) => this.#startChild(active, args),
				changed: () => this.#publish(active),
				stopped: (frame) => {
					this.focusSession(active.key);
					this.#hit(frameLocation(frame, this.root));
					this.#reveal(frame);
					this.#onBreak();
					void import('#lib/workbench/accessibilitySignals.svelte.ts').then((m) => m.playAccessibilitySignal('onDebugBreak'));
					void this.#evaluateWatches();
				},
				terminated: () => void this.#finish(active)
			},
			{ noDebug }
		);
		// Output already shown (preLaunchTask notice, build) stays at the top of the console.
		session.model = { ...session.model, output: model.output };
		const active: Active = { key: this.#nextKey++, session, id: null, config, build, noDebug, parent, group: opts.group ?? parent?.group, hidden, stopWith: opts.stopWith };
		const serverReady = parseServerReadyAction(config.serverReadyAction);
		active.detector = parent?.detector ?? (serverReady ? new ServerReadyDetector(serverReady, (m) => void this.#serverReady(active, serverReady, m)) : undefined);
		this.#all = [...this.#all, active];
		// A child takes focus from its parent (js-debug's parent session shows no program state).
		if (!hidden && (!parent || this.focusedKey === parent.key || this.focusedKey === null)) this.focusSession(active.key);
		this.#publish(active);

		const channel = new Channel<DapEvent>();
		channel.onmessage = (ev) => {
			if (ev.type === 'message') client.handle(ev.json);
			else if (ev.type === 'stderr') session.model.state !== 'terminated' && this.#sessionOutput(active, 'stderr', `${ev.line}\n`);
			else {
				session.exited(ev.code);
				this.#ended(active);
				clientLog('info', `debug adapter exited (code ${ev.code})`);
			}
		};
		try {
			id = parent
				? await invoke<number>('dap_start_child', { parent: parent.id, onEvent: channel })
				: await invoke<number>('dap_start', { debugType: config.type, python: typeof config.python === 'string' ? config.python : null, onEvent: channel });
			active.id = id;
			if (hidden) this.#autoAttachSession = active;
			clientLog('info', `debug session started: ${config.name} (${config.type})${parent ? ' (child)' : ''}`);
		} catch (e) {
			const message = String(e);
			this.#sessionOutput(active, 'stderr', `${message}\n`);
			session.model = { ...session.model, state: 'terminated' };
			this.#publish(active);
			this.#ended(active);
			if (hidden) return;
			if (isRustError(message, 'notInstalled')) void this.install(config.type);
			else status.flash(message);
			return;
		}
		try {
			await session.start();
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.#sessionOutput(active, 'stderr', `${message}\n`);
			notifications.error(t('tools.debug.startFailed', { error: message }));
			await this.#kill(active);
		}
	}

	/** serverReadyAction matched (VS Code's debug-server-ready): open the URI, debug it in a browser, or start a configuration. */
	async #serverReady(active: Active, action: ServerReadyAction, m: ServerReadyMatch) {
		if (!m.ok) return notifications.error(t(m.error === 'noCapture' ? 'debugExtras.serverReady.noCapture' : 'debugExtras.serverReady.placeholders', { format: m.format }));
		const stopWith = action.killOnServerStop ? this.#root(active) : undefined;
		switch (action.action) {
			case 'openExternally':
				return openUrl(m.uri, ['http', 'https']).catch((e) => notifications.error(String(e)));
			case 'debugWithChrome':
			case 'debugWithEdge':
				return this.#startConfig(browserConfig(action, m.uri), { stopWith });
			case 'startDebugging': {
				if (action.config) return this.#startConfig({ name: action.name ?? 'serverReadyAction', type: '', request: 'launch', ...action.config } as LaunchConfig, { stopWith });
				const name = action.name ?? 'unspecified';
				const { configs } = await this.#readLaunchFiles();
				const config = configs.find((c) => c.name === name);
				if (!config) return notifications.error(t('debugExtras.serverReady.noConfig', { name }));
				return this.#startConfig(config, { stopWith });
			}
		}
	}

	/** js-debug's `startDebugging`: a child session over a new connection to the same server. */
	async #startChild(parent: Active, args: StartDebuggingArguments) {
		if (parent.id === null) return;
		const configuration = args.configuration ?? {};
		// VS Code: the parent's debugger type, the request from the arguments, the parent's name unless given.
		const config: LaunchConfig = {
			...configuration,
			type: parent.config.type,
			request: args.request === 'attach' ? 'attach' : 'launch',
			name: typeof configuration.name === 'string' && configuration.name ? configuration.name : parent.config.name
		};
		await this.#launch(config, parent.noDebug, undefined, { parent });
	}

	/** VS Code's runTaskAndCheckErrors: true when debugging may start. */
	async #runPreLaunchTask(ref: TaskRef, folder: string | undefined): Promise<boolean> {
		const name = taskName(ref);
		const debugAnyway = t('ideTasks.debug.debugAnyway');
		const configure = t('ideTasks.debug.configureTask');
		const failed = async (message: string, task?: Parameters<typeof tasks.configure>[0]) => {
			const answer = await choose(message, { kind: 'error', buttons: [debugAnyway, configure, t('common.cancel')], cancelId: 2 });
			if (answer === configure) await tasks.configure(task ?? 'template');
			return answer === debugAnyway;
		};
		const { task } = await tasks.find(ref, { folder });
		if (!task) return failed(t('ideTasks.debug.notFound', { task: name }));
		const run = tasks.run(task, { untilInactive: true });
		// debug.hideSlowPreLaunchWarning: after a while (5 s for a background task, else 10 s) a
		// notification offers Debug Anyway / Configure Task / Abort (VS Code: debugTaskRunner).
		let slow: ReturnType<typeof notifications.notify> | undefined;
		const answered = new Promise<'debug' | 'abort'>((resolve) => {
			if (settings.get<boolean>('debug.hideSlowPreLaunchWarning')) return;
			const timer = setTimeout(() => {
				slow = notifications.info(t('ideTasks.debug.waiting', { task: name }), {
					sticky: true,
					progress: { infinite: true },
					actions: [
						{ label: t('ideTasks.debug.debugAnyway'), run: () => resolve('debug') },
						...(task.configured ? [{ label: t('ideTasks.debug.configureTask'), run: () => (void tasks.configure(task), resolve('abort')) }] : []),
						{ label: t('ideTasks.debug.abort'), run: () => resolve('abort') }
					]
				});
			}, task.isBackground ? 5000 : 10000);
			void run.finally(() => clearTimeout(timer));
		});
		const waited = Promise.race([run, answered]).finally(() => slow?.close());
		let summary;
		// A background task without a background pattern never goes idle: VS Code gives up after 5 s.
		if (task.isBackground && !parseProblemMatchers(task.problemMatcher, []).some((m) => m.watching)) {
			const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5000));
			const first = await Promise.race([waited, timeout]);
			if (first === 'timeout') return failed(t('ideTasks.debug.notTracked', { task: name }), task);
			summary = first;
		} else summary = await waited;
		if (summary === 'debug') return true;
		if (summary === 'abort') {
			tasks.terminate(task);
			return false;
		}
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
		if (!ref || active.postDone || active.parent) return;
		active.postDone = true;
		this.#sessionOutput(active, 'console', t('ideTasks.debug.postRunning', { task: taskName(ref) }));
		void tasks.find(ref as TaskRef, { folder: this.#folderOfConfig(active.config) }).then(({ task }) => {
			if (task) void tasks.run(task);
			else notifications.error(t('ideTasks.debug.notFound', { task: taskName(ref) }));
		});
	}

	#sessionOutput(active: Active, category: string, text: string) {
		active.session.model = appendOutput(active.session.model, category, text);
		this.#publish(active);
	}

	/** The adapter said `terminated`: disconnect (VS Code does), then make sure the process is gone. */
	async #finish(active: Active) {
		if (!this.#all.includes(active)) return;
		await active.session.disconnect();
		this.#runPostDebugTask(active);
		this.#ended(active);
		setTimeout(() => active.id !== null && void invoke('dap_stop', { id: active.id }).catch(() => {}), 1000);
	}

	/** A session is over: its children go too, a stopAll compound stops, and focus moves on. */
	#ended(active: Active) {
		for (const child of this.#all.filter((a) => a.parent === active && a.session.model.state !== 'terminated')) void this.#kill(child);
		// serverReadyAction's killOnServerStop: what the server started stops with it.
		for (const other of this.#live().filter((a) => a.stopWith === active && a !== active)) void this.#kill(other);
		active.untap?.();
		active.untap = undefined;
		if (active === this.#autoAttachSession) {
			this.#autoAttachSession = null;
			this.#autoAttachRaw = null;
			this.#applyAutoAttach();
		}
		if (active.group !== undefined && !active.parent) for (const other of this.#live().filter((a) => a.group === active.group && a !== active && !a.parent)) void this.#kill(other);
		// A child's output stays readable in its parent's console after focus goes back to it.
		const parent = active.parent;
		if (parent && parent.session.model.state !== 'terminated' && active.session.model.output.length) {
			const output = [...parent.session.model.output, ...active.session.model.output];
			parent.session.model = { ...parent.session.model, output: output.slice(-Math.max(1, outputLimit.max)) };
			active.session.model = { ...active.session.model, output: [] };
			this.#publish(parent);
		}
		// Persistent data breakpoints stay; the rest belonged to this session (VS Code).
		if (!this.#live().length) this.dataBreakpoints = B.persistentData(this.dataBreakpoints);
		this.sessions = this.sessions.filter((s) => s.key !== active.key);
		const remaining = this.#shown().filter((a) => a !== active);
		if (this.focusedKey === active.key) {
			const next = (active.parent && remaining.includes(active.parent) ? active.parent : null) ?? remaining.find((a) => a.session.model.state === 'stopped') ?? remaining[0];
			// Without another session the ended one stays shown (its output, Restart) until the next start.
			if (next) this.focusSession(next.key);
			else this.model = active.session.model;
		}
		this.#all = this.#all.filter((a) => a.session.model.state !== 'terminated' || a.key === this.focusedKey);
	}

	async #kill(active: Active) {
		await active.session.disconnect(1000);
		if (active.id !== null) await invoke('dap_stop', { id: active.id }).catch(() => {});
		active.session.exited(null);
		this.#publish(active);
		this.#runPostDebugTask(active);
		this.#ended(active);
	}

	/** The top of a session's tree (a js-debug child's parent session); auto attach's hidden
	 * listener is never the top: Stop and Restart of an attached process leave it running. */
	#root(a: Active): Active {
		let r = a;
		while (r.parent && !r.parent.hidden) r = r.parent;
		return r;
	}

	// --- Running -----------------------------------------------------------------------------------

	/** Stop: the focused session's whole tree (a js-debug child stops with its parent), or only the
	 * focused child with debug.showSubSessionsInToolBar. */
	async stop() {
		const a = this.#focused() ?? this.#shown()[0];
		if (!a || !this.active) return;
		// debug.showSubSessionsInToolBar: a child session the toolbar shows stops by itself.
		await this.#kill(this.#showSubSessions() ? a : this.#root(a));
	}

	#showSubSessions() {
		return settings.get<boolean>('debug.showSubSessionsInToolBar') === true;
	}

	async restart() {
		const focused = this.#focused() ?? this.#all.filter((a) => !a.hidden).at(-1);
		if (!focused) return;
		// A child session restarts by itself only when the toolbar shows sub-sessions and the adapter can.
		if (focused.parent && this.#showSubSessions() && focused.session.model.state !== 'terminated' && (await focused.session.restart().catch(() => false))) return;
		const a = this.#root(focused);
		if (a.session.model.state !== 'terminated' && (await a.session.restart().catch(() => false))) return;
		if (a.session.model.state !== 'terminated') await this.#kill(a);
		// An auto-attached process cannot be launched again (its terminal started it).
		if (a.parent?.hidden) return;
		await this.#launch(a.config, a.noDebug, a.build, { group: a.group });
	}

	#session() {
		return this.#focused()?.session;
	}

	/** Stepping by instruction while the Disassembly view has focus (VS Code). */
	#granularity(): SteppingGranularity | undefined {
		return this.disassemblyFocused ? 'instruction' : undefined;
	}

	continue() {
		return this.#session()?.continue();
	}
	stepOver() {
		return this.#session()?.next(this.#granularity());
	}
	stepInto() {
		return this.#session()?.stepIn(this.#granularity());
	}
	stepOut() {
		return this.#session()?.stepOut(this.#granularity());
	}

	/** Step Into Target (VS Code: workbench.action.debug.stepIntoTarget): pick which call of the line to step into. */
	async stepIntoTarget() {
		const session = this.#session();
		if (!session || !this.stopped) return;
		const targets = await session.stepInTargets();
		if (!targets.length) return status.flash(t('debugExtras.stepIntoTarget.none'));
		const pick = await quick.choose({ placeholder: t('debugExtras.stepIntoTarget.pick'), items: targets.map((x) => ({ id: String(x.id), label: x.label, description: x.line ? `:${x.line}${x.column ? `:${x.column}` : ''}` : undefined })) });
		if (pick) await session.stepIn(this.#granularity(), Number(pick.id));
	}
	stepBack() {
		return this.#session()?.stepBack();
	}
	reverseContinue() {
		return this.#session()?.reverseContinue();
	}
	pause() {
		return this.#session()?.pause();
	}

	/** Run to Cursor (VS Code: editor.debug.action.runToCursor). */
	async runToCursor(rel = editors.active, line = editors.cursor.line) {
		const session = this.#session();
		if (!session || !isWorkspaceFile(rel) || !this.stopped) return;
		await session.runTo(this.#abs(rel), line);
	}

	/** Jump to Cursor (VS Code: debug.jumpToCursor): the adapter must support goto targets. */
	async jumpToCursor(rel = editors.active, line = editors.cursor.line) {
		const session = this.#session();
		if (!session || !isWorkspaceFile(rel) || !this.stopped) return;
		if (!session.capabilities.supportsGotoTargetsRequest) return status.flash(t('debugger.noJump'));
		const ok = await session.jumpTo(this.#abs(rel), line).catch((e) => (notifications.error(e instanceof Error ? e.message : String(e)), true));
		if (!ok) status.flash(t('debugger.noJumpTarget', { line }));
	}

	/** Call Stack: Restart Frame. */
	restartFrame(frameId: number) {
		return this.#session()?.restartFrame(frameId);
	}

	async selectFrame(frameId: number, sessionKey = this.focusedKey) {
		if (sessionKey !== null && sessionKey !== this.focusedKey) this.focusSession(sessionKey);
		await this.#session()?.selectFrame(frameId);
		void this.#evaluateWatches();
	}

	/** Children of a scope or variable for the Variables tree. */
	expand(ref: number) {
		return this.#session()?.expand(ref).catch(() => []) ?? Promise.resolve([]);
	}

	/** Variables view: Set Value (supportsSetVariable). */
	async setVariable(parentRef: number, name: string, current: string) {
		const session = this.#session();
		if (!session?.capabilities.supportsSetVariable) return;
		const value = await quick.input({ placeholder: t('debugger.setValue', { name }), value: current, hint: (v) => `${name} = ${v}` });
		if (value === undefined) return;
		try {
			await session.setVariable(parentRef, name, value);
			void this.#evaluateWatches();
		} catch (e) {
			notifications.error(e instanceof Error ? e.message : String(e));
		}
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

	// --- Hover, Watch and REPL ---------------------------------------------------------------------

	/** The debug hover's value for an expression in the focused session (null outside a stop). */
	hover(expression: string): Promise<EvaluateResult | null> {
		return this.#session()?.hover(expression) ?? Promise.resolve(null);
	}

	/** Debug Console completions (the adapter's, when it has the completions request). */
	completions(text: string, column: number): Promise<CompletionItem[]> {
		return this.#session()?.completions(text, column) ?? Promise.resolve([]);
	}

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

	removeAllWatches() {
		this.watches = [];
		save(`${WATCHES}:${this.root}`, '[]');
	}

	async #evaluateWatches() {
		const session = this.#session();
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
		const a = this.#focused();
		if (!a || a.session.model.state === 'terminated') {
			if (this.model) this.model = appendOutput(this.model, 'stderr', t('tools.debug.noSession'));
			return;
		}
		this.#sessionOutput(a, 'input', `> ${expr}\n`);
		try {
			const r = await a.session.evaluate(expr, 'repl');
			this.#sessionOutput(a, 'result', `${r.result}\n`);
		} catch (e) {
			this.#sessionOutput(a, 'stderr', `${e instanceof Error ? e.message : e}\n`);
		}
		void this.#evaluateWatches();
	}

	/** Evaluate in Debug Console (VS Code: editor.debug.action.selectionToRepl). */
	async evaluateInConsole(text: string) {
		const expr = text.trim();
		if (!expr) return;
		layout.showPanel('debugConsole');
		await this.repl(expr);
	}

	clearConsole() {
		if (this.model) this.model = { ...this.model, output: [] };
		const a = this.#focused();
		if (a) {
			a.session.model = { ...a.session.model, output: [] };
			this.#publish(a);
		}
	}

	// --- JavaScript Debug Terminal and auto attach -----------------------------------------------------

	#autoAttachSession: Active | null = null;
	/** The listener launch's runInTerminal environment (NODE_OPTIONS, VSCODE_INSPECTOR_OPTIONS). */
	#autoAttachRaw: Record<string, string | null> | null = null;
	#autoAttachStarting = false;

	#shell(): string {
		const s = shellFrom((id) => settings.get(id), shellPlatform());
		return s.shell ?? s.paths[0] ?? '/bin/zsh';
	}

	/** debug.javascript.terminalOptions: launch.json fields added to the debug terminal and auto attach. */
	#terminalOptions(): Record<string, unknown> {
		const o = settings.get<unknown>('debug.javascript.terminalOptions');
		return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
	}

	/** Debug: JavaScript Debug Terminal (VS Code: extension.js-debug.createDebuggerTerminal): a shell whose Node.js processes are debugged. */
	async createDebuggerTerminal() {
		const root = await this.#ensureRoot();
		if (!root) return status.flash(t('tools.debug.openFolderFirst'));
		await this.#startConfig(debugTerminalConfig(this.#shell(), root, this.#terminalOptions()));
	}

	/** Debug: Toggle Auto Attach (VS Code: extension.node-debug.toggleAutoAttach): picks debug.javascript.autoAttachFilter. */
	async toggleAutoAttach() {
		const current = settings.get<string>('debug.javascript.autoAttachFilter');
		const item = await quick.choose({
			placeholder: t('debugExtras.autoAttach.pick'),
			items: AUTO_ATTACH_FILTERS.map((f) => ({ id: f, label: t(`debugExtras.autoAttach.${f}`), description: f === current ? t('debugExtras.autoAttach.current') : undefined })),
			activeId: current
		});
		if (item) await settings.set('debug.javascript.autoAttachFilter', item.id, 'user');
	}

	/** Follows debug.javascript.autoAttachFilter: a hidden js-debug launch listens while it is on (trusted folders only). */
	async syncAutoAttach(filter: AutoAttachFilter) {
		const on = filter !== 'disabled' && !!this.root && workspaceTrust.trusted;
		this.autoAttach = { filter, env: this.autoAttach.env };
		if (!on) {
			const a = this.#autoAttachSession;
			if (a) await this.#kill(a);
			this.#autoAttachRaw = null;
			return this.#applyAutoAttach();
		}
		if (this.#autoAttachSession || this.#autoAttachStarting) return this.#applyAutoAttach();
		this.#autoAttachStarting = true;
		try {
			// Never offers the download: auto attach waits until js-debug is installed.
			const st = await invoke<JsDebugStatus>('dap_js_debug_status').catch(() => null);
			if (!st?.server) return;
			const config = await this.#prepare(autoAttachConfig(this.#shell(), this.root, this.#terminalOptions()));
			if (config) await this.#launch(config, false, undefined, { hidden: true });
		} finally {
			this.#autoAttachStarting = false;
		}
	}

	#applyAutoAttach() {
		const filter = this.autoAttach.filter;
		const env = this.#autoAttachRaw ? autoAttachEnv(this.#autoAttachRaw, filter, settings.get<string[]>('debug.javascript.autoAttachSmartPattern'), this.root) : null;
		this.autoAttach = { filter, env };
		contributeTerminalEnv('js-debug.autoAttach', env);
	}

	// --- Missing adapters --------------------------------------------------------------------------

	/** Offers what installs the adapter: js-debug is downloaded (pinned, checksum verified) after
	 * the user agrees; the others are install commands run in a terminal, like a missing language server. */
	async install(debugType: string) {
		if (isJsDebugType(debugType)) {
			const st = await invoke<JsDebugStatus>('dap_js_debug_status').catch(() => null);
			if (st && !st.server) return this.installJsDebug(st);
		}
		let res: InstallInfo;
		try {
			res = await invoke<InstallInfo>('dap_install_methods', { debugType });
		} catch (e) {
			return notifications.error(e);
		}
		const server = isJsDebugType(debugType) ? 'Node.js' : res.server;
		quick.pick({
			placeholder: res.methods.length ? t('tools.debug.installWith', { server }) : t('tools.debug.installManual', { server, binary: res.binary }),
			items: installItems(res),
			onAccept: (item) => {
				const method = res.methods[Number(item.id)];
				if (!method) return;
				terminals.open({ title: t('tools.debug.installTerminal', { server }), run: method.argv });
				layout.showPanel('terminal');
			}
		});
	}

	/** Downloads js-debug only when the user says so (VS Code ships it built in; Kingu fetches the same release). */
	async installJsDebug(status?: JsDebugStatus | null) {
		const st = status ?? (await invoke<JsDebugStatus>('dap_js_debug_status').catch(() => null));
		if (!st) return;
		const download = t('debugger.js.download');
		const mb = (st.bytes / 1024 / 1024).toFixed(1);
		const message = `${t('debugger.js.ask', { version: st.version, size: mb })}\n\n${t('debugger.js.detail', { url: st.url, sha256: st.sha256 })}`;
		const answer = await choose(message, { kind: 'info', buttons: [download, t('common.cancel')], cancelId: 1 });
		if (answer !== download) return;
		try {
			await notifications.withProgress({ title: t('debugger.js.installing', { version: st.version }) }, () => invoke<string>('dap_js_debug_install'));
			notifications.info(st.node ? t('debugger.js.installed', { version: st.version }) : t('debugger.js.installedNoNode', { version: st.version }));
		} catch (e) {
			notifications.error(t('debugger.js.failed', { error: String(e) }));
		}
	}

	/** Install Additional Debuggers… (VS Code opens the extensions view; Kingu lists its adapters). */
	async installAdditional() {
		const st = await invoke<JsDebugStatus>('dap_js_debug_status').catch(() => null);
		const items = [
			{ id: 'node', label: 'js-debug', description: st?.server ? t('debugger.installed') : t('debugger.js.description', { version: st?.version ?? '' }) },
			{ id: 'lldb', label: 'lldb-dap', description: 'Rust, C, C++, Swift' },
			{ id: 'go', label: 'Delve (dlv)', description: 'Go' },
			{ id: 'debugpy', label: 'debugpy', description: 'Python' }
		];
		const item = await quick.choose({ placeholder: t('debugger.installPick'), items });
		if (!item) return;
		if (item.id === 'node') return st?.server ? status.flash(t('debugger.js.already', { version: st.version })) : this.installJsDebug(st);
		const ok = await invoke<string>('dap_check', { debugType: item.id, python: null }).then(
			() => true,
			() => false
		);
		if (ok) status.flash(t('debugger.alreadyInstalled', { name: item.label }));
		else void this.install(item.id);
	}

	// --- launch.json -------------------------------------------------------------------------------

	/**
	 * Which launch.json Open launch.json / Add Configuration work on: in a multi-root window the
	 * folder is asked for (VS Code); picking the `.code-workspace`
	 * file opens it (its `launch`) and gives null. Returns the workbench path of a file in that folder.
	 */
	async #launchFolder(): Promise<((rel: string) => string) | null> {
		const folders = await tasks.folders();
		const picked = folders.length < 2 ? folders[0] : await tasks.pickFolder(t('debugger.pickLaunchFolder'), { workspace: true });
		if (picked === 'workspace') {
			tasks.openWorkspaceFile();
			return null;
		}
		if (!picked) return null;
		return (rel) => folderKey(rel, picked, folders);
	}

	/** Debug: Open launch.json — creates `.vscode/launch.json` with a configuration for the active file's language. */
	async openLaunchJson() {
		const root = await this.#ensureRoot();
		if (!root) return status.flash(t('tools.debug.openFolder'));
		const at = await this.#launchFolder();
		if (!at) return;
		const rel = at(LAUNCH_FILES[0]);
		const exists = await invoke<string>('read_workspace_file', { rel }).then(
			() => true,
			() => false
		);
		if (!exists) {
			const cargoToml = editors.language === 'rust' ? await invoke<string>('read_workspace_file', { rel: at('Cargo.toml') }).catch(() => null) : null;
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

	/** Debug: Add Configuration… — a snippet for the active file's debugger first, appended to launch.json. */
	async addConfiguration() {
		const root = await this.#ensureRoot();
		if (!root) return status.flash(t('tools.debug.openFolder'));
		const at = await this.#launchFolder();
		if (!at) return;
		const language = editors.language;
		const snippets = snippetsFor(language);
		const item = await quick.choose({ placeholder: t('debugger.addConfigPick'), items: snippets.map((s, i) => ({ id: String(i), label: s.label, description: s.description })) });
		if (!item) return;
		const snippet = snippets[Number(item.id)];
		const rel = at(LAUNCH_FILES[0]);
		const current = await invoke<string>('read_workspace_file', { rel }).catch(() => null);
		const { text, offset } = addConfigurationText(current ?? '', snippet.body);
		try {
			if (current === null) await invoke('fs_create_file', { rel });
			const { getEntry, saveFile } = await import('#lib/workbench/editorModels.ts');
			const entry = getEntry(rel);
			// An open launch.json is edited in place (undoable), else the file is written.
			if (entry?.model) {
				entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text }], () => null);
				await saveFile(rel, 'explicit');
			} else await invoke('fs_write_file', { rel, content: text });
		} catch (e) {
			return notifications.error(e);
		}
		const line = text.slice(0, offset).split('\n').length;
		editors.openAt(rel, line, 1);
	}
}

export const debug = new Debug();

/** Commands and keys (VS Code ids and default keybindings). Returns the uninstaller. */
export function installDebug(): () => void {
	debug.reset();
	// debug.openExplorerOnEnd / debug.console.closeOnEnd when a session ends; debug.console.maximumLines.
	let lastActive = false;
	const disposeEffects = $effect.root(() => {
		$effect(() => {
			const active = debug.active;
			const ended = !active && lastActive;
			lastActive = active;
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
		// debug.javascript.autoAttachFilter (and the folder, its trust): auto attach's listener follows.
		$effect(() => {
			const filter = settings.get<string>('debug.javascript.autoAttachFilter') as AutoAttachFilter;
			void debug.root;
			void workspaceTrust.trusted;
			untrack(() => void debug.syncAutoAttach(AUTO_ATTACH_FILTERS.includes(filter) ? filter : 'disabled'));
		});
	});
	const fileOpen = () => isWorkspaceFile(editors.active);
	const unregister = [
		commands.register({ id: 'workbench.action.debug.start', title: 'Start Debugging', category: 'Debug', key: 'f5', run: () => debug.start() }),
		commands.register({ id: 'workbench.action.debug.run', title: 'Start Without Debugging', category: 'Debug', key: 'ctrl+f5', run: () => debug.start({ noDebug: true }) }),
		commands.register({ id: 'workbench.action.debug.selectandstart', title: 'Select and Start Debugging', category: 'Debug', run: () => debug.start({ pick: true }) }),
		commands.register({ id: 'workbench.action.debug.stop', title: 'Stop', category: 'Debug', key: 'shift+f5', when: () => debug.active, run: () => debug.stop() }),
		commands.register({ id: 'workbench.action.debug.restart', title: 'Restart', category: 'Debug', key: 'cmd+shift+f5', when: () => debug.model !== null, run: () => debug.restart() }),
		// F5 while stopped is Continue: Start Debugging's F5 does it, so one key never maps to two native menu items.
		commands.register({ id: 'workbench.action.debug.continue', title: 'Continue', category: 'Debug', when: () => debug.stopped, run: () => debug.continue() }),
		commands.register({ id: 'workbench.action.debug.stepOver', title: 'Step Over', category: 'Debug', key: 'f10', when: () => debug.stopped, run: () => debug.stepOver() }),
		commands.register({ id: 'workbench.action.debug.stepInto', title: 'Step Into', category: 'Debug', key: 'f11', when: () => debug.stopped, run: () => debug.stepInto() }),
		commands.register({ id: 'workbench.action.debug.stepOut', title: 'Step Out', category: 'Debug', key: 'shift+f11', when: () => debug.stopped, run: () => debug.stepOut() }),
		commands.register({ id: 'workbench.action.debug.stepBack', title: 'Step Back', category: 'Debug', when: () => debug.stopped && !!debug.capabilities.supportsStepBack, run: () => debug.stepBack() }),
		commands.register({ id: 'workbench.action.debug.reverseContinue', title: 'Reverse', category: 'Debug', when: () => debug.stopped && !!debug.capabilities.supportsStepBack, run: () => debug.reverseContinue() }),
		commands.register({ id: 'workbench.action.debug.pause', title: 'Pause', category: 'Debug', key: 'f6', when: () => debug.running, run: () => debug.pause() }),
		commands.register({ id: 'editor.debug.action.runToCursor', title: 'Run to Cursor', category: 'Debug', when: () => debug.stopped && fileOpen(), run: () => debug.runToCursor() }),
		commands.register({ id: 'editor.debug.action.jumpToCursor', title: 'Jump to Cursor', category: 'Debug', when: () => debug.stopped && fileOpen() && !!debug.capabilities.supportsGotoTargetsRequest, run: () => debug.jumpToCursor() }),
		commands.register({ id: 'editor.debug.action.toggleBreakpoint', title: 'Toggle Breakpoint', category: 'Debug', key: 'f9', when: fileOpen, run: () => debug.toggleBreakpoint() }),
		commands.register({ id: 'editor.debug.action.toggleInlineBreakpoint', title: 'Inline Breakpoint', category: 'Debug', key: 'shift+f9', when: fileOpen, run: () => debug.toggleInlineBreakpoint() }),
		commands.register({ id: 'workbench.action.debug.stepIntoTarget', title: 'Step Into Target', category: 'Debug', key: 'cmd+f11', when: () => debug.stopped && !!debug.capabilities.supportsStepInTargetsRequest, run: () => debug.stepIntoTarget() }),
		commands.register({ id: 'editor.debug.action.selectionToRepl', title: 'Evaluate in Debug Console', category: 'Debug', when: () => debug.active && fileOpen(), run: () => debug.evaluateInConsole(editors.selectionText(true)) }),
		commands.register({ id: 'editor.debug.action.selectionToWatch', title: 'Add to Watch', category: 'Debug', when: fileOpen, run: () => debug.addWatch(editors.selectionText(true)) }),
		commands.register({ id: 'debug.action.openDisassemblyView', title: 'Open Disassembly View', category: 'Debug', when: () => debug.stopped && !!debug.capabilities.supportsDisassembleRequest, run: () => debug.openDisassembly() }),
		commands.register({ id: 'extension.js-debug.createDebuggerTerminal', title: 'JavaScript Debug Terminal', category: 'Debug', run: () => debug.createDebuggerTerminal() }),
		commands.register({ id: 'extension.node-debug.toggleAutoAttach', title: 'Toggle Auto Attach', category: 'Debug', run: () => debug.toggleAutoAttach() }),
		commands.register({ id: 'editor.debug.action.conditionalBreakpoint', title: 'Add Conditional Breakpoint...', category: 'Debug', when: fileOpen, run: () => debug.editCondition() }),
		commands.register({ id: 'editor.debug.action.editBreakpoint', title: 'Edit Breakpoint...', category: 'Debug', when: fileOpen, run: () => debug.editBreakpoint() }),
		commands.register({ id: 'editor.debug.action.triggerByBreakpoint', title: 'Add Triggered Breakpoint...', category: 'Debug', when: fileOpen, run: () => debug.editTrigger() }),
		commands.register({ id: 'editor.debug.action.addLogPoint', title: 'Add Logpoint...', category: 'Debug', when: fileOpen, run: () => debug.editLogMessage() }),
		commands.register({ id: 'workbench.debug.viewlet.action.addFunctionBreakpointAction', title: 'Add Function Breakpoint', category: 'Debug', run: () => debug.addFunctionBreakpoint() }),
		commands.register({ id: 'workbench.debug.viewlet.action.enableAllBreakpoints', title: 'Enable All Breakpoints', category: 'Debug', run: () => debug.setAllBreakpointsEnabled(true) }),
		commands.register({ id: 'workbench.debug.viewlet.action.disableAllBreakpoints', title: 'Disable All Breakpoints', category: 'Debug', run: () => debug.setAllBreakpointsEnabled(false) }),
		commands.register({ id: 'workbench.debug.viewlet.action.toggleBreakpointsActivatedAction', title: 'Toggle Activate Breakpoints', category: 'Debug', run: () => debug.toggleBreakpointsActivated() }),
		commands.register({ id: 'workbench.debug.viewlet.action.removeAllBreakpoints', title: 'Remove All Breakpoints', category: 'Debug', run: () => debug.removeAllBreakpoints() }),
		commands.register({ id: 'workbench.debug.viewlet.action.removeAllExpressions', title: 'Remove All Expressions', category: 'Debug', run: () => debug.removeAllWatches() }),
		commands.register({ id: 'workbench.action.debug.configure', title: 'Open launch.json', category: 'Debug', run: () => debug.openLaunchJson() }),
		commands.register({ id: 'debug.addConfiguration', title: 'Add Configuration...', category: 'Debug', run: () => debug.addConfiguration() }),
		commands.register({ id: 'debug.installAdditionalDebuggers', title: 'Install Additional Debuggers...', category: 'Debug', run: () => debug.installAdditional() }),
		commands.register({ id: 'workbench.view.debug', title: 'Show Run and Debug', category: 'View', key: 'cmd+shift+d', scope: 'ide', run: () => ((layout.sideView = 'debug'), (layout.sidebarVisible = true)) }),
		commands.register({ id: 'workbench.debug.action.toggleRepl', title: 'Focus on Debug Console View', category: 'View', run: () => layout.showPanel('debugConsole') })
	];
	return () => {
		disposeEffects();
		unregister.forEach((u) => u());
	};
}
