// What the Run and Debug view shows for one session, as a pure reducer over DAP events and
// responses (VS Code: debugModel.ts). Every function returns a new model, so the runes wrapper
// can hold it in `$state.raw`.

import type { Breakpoint, Event, OutputEvent, Scope, StackFrame, StoppedEvent, Thread, Variable } from './protocol.ts';
import { t } from '#lib/i18n/index.ts';

export type SessionState = 'initializing' | 'running' | 'stopped' | 'terminated';
export type OutputLine = { category: string; text: string };

export type DebugModel = {
	state: SessionState;
	threads: Thread[];
	stopped: { threadId: number | null; reason: string; description?: string } | null;
	/** Call stack of the stopped thread. */
	frames: StackFrame[];
	/** The selected frame (Variables, Watch and REPL evaluate in it). */
	frameId: number | null;
	scopes: Scope[];
	/** Children per variablesReference, fetched lazily as the tree is expanded. */
	variables: Record<number, Variable[]>;
	output: OutputLine[];
	/** The adapter's answer to setBreakpoints, per absolute source path, in request order. */
	verified: Record<string, Breakpoint[]>;
	exitCode: number | null;
};

/** VS Code's `debug.console.maximumLines` default. */
export const OUTPUT_LIMIT = 10000;
/** The Debug Console's line limit (`debug.console.maximumLines`, set by debug.svelte.ts). */
export const outputLimit = { max: OUTPUT_LIMIT };

export function initialModel(): DebugModel {
	return { state: 'initializing', threads: [], stopped: null, frames: [], frameId: null, scopes: [], variables: {}, output: [], verified: {}, exitCode: null };
}

/** Everything tied to one stop (frames, scopes, variables) goes when execution resumes. */
function resumed(m: DebugModel): DebugModel {
	return { ...m, state: 'running', stopped: null, frames: [], frameId: null, scopes: [], variables: {} };
}

export function appendOutput(m: DebugModel, category: string, text: string): DebugModel {
	if (!text) return m;
	// Output of another kind (lldb's warning, then the program's stdout) starts on its own line even
	// when the previous chunk did not end with one.
	const prev = m.output.at(-1);
	const lead = prev && prev.category !== category && !prev.text.endsWith('\n') ? '\n' : '';
	const output = [...m.output, { category, text: lead + text }];
	const max = Math.max(1, outputLimit.max);
	return { ...m, output: output.length > max ? output.slice(-max) : output };
}

export function applyEvent(m: DebugModel, ev: Event): DebugModel {
	const body = ev.body ?? {};
	switch (ev.event) {
		case 'initialized':
			return m;
		case 'stopped': {
			const b = body as StoppedEvent;
			return { ...resumed(m), state: 'stopped', stopped: { threadId: b.threadId ?? null, reason: b.reason, description: b.description ?? b.text } };
		}
		case 'continued':
			return m.state === 'terminated' ? m : resumed(m);
		case 'output': {
			const b = body as OutputEvent;
			// Telemetry is the adapter talking to its vendor, not the user.
			if (b.category === 'telemetry') return m;
			return appendOutput(m, b.category ?? 'console', b.output ?? '');
		}
		case 'exited':
			return appendOutput({ ...m, exitCode: body.exitCode ?? null }, 'console', t('tools.debug.exited', { code: body.exitCode ?? '?' }));
		case 'terminated':
			return { ...resumed(m), state: 'terminated' };
		case 'breakpoint': {
			const bp = body.breakpoint as Breakpoint | undefined;
			if (!bp || bp.id === undefined) return m;
			const verified: Record<string, Breakpoint[]> = {};
			for (const [path, list] of Object.entries(m.verified)) verified[path] = list.map((b) => (b.id === bp.id ? { ...b, ...bp } : b));
			return { ...m, verified };
		}
		case 'thread':
			if (body.reason === 'exited') return { ...m, threads: m.threads.filter((t) => t.id !== body.threadId) };
			return m;
		default:
			return m;
	}
}

export function withThreads(m: DebugModel, threads: Thread[]): DebugModel {
	return { ...m, threads };
}

/** A new call stack selects its top frame that has source, like VS Code (else the top one). */
export function withFrames(m: DebugModel, frames: StackFrame[]): DebugModel {
	const top = frames.find((f) => f.source?.path && f.presentationHint !== 'subtle') ?? frames[0];
	return { ...m, frames, frameId: top?.id ?? null, scopes: [], variables: {} };
}

export function selectFrame(m: DebugModel, frameId: number): DebugModel {
	return m.frameId === frameId ? m : { ...m, frameId, scopes: [], variables: {} };
}

export function withScopes(m: DebugModel, frameId: number, scopes: Scope[]): DebugModel {
	return m.frameId === frameId ? { ...m, scopes } : m;
}

export function withVariables(m: DebugModel, ref: number, vars: Variable[]): DebugModel {
	return { ...m, variables: { ...m.variables, [ref]: vars } };
}

export function withBreakpoints(m: DebugModel, path: string, bps: Breakpoint[]): DebugModel {
	return { ...m, verified: { ...m.verified, [path]: bps } };
}

export function currentFrame(m: DebugModel): StackFrame | null {
	return m.frames.find((f) => f.id === m.frameId) ?? null;
}

/** Workspace-relative location of a frame, or null when its source is outside the folder. */
export function frameLocation(frame: StackFrame | null, root: string): { rel: string; line: number; column: number } | null {
	const path = frame?.source?.path;
	if (!frame || !path || !root) return null;
	const prefix = root.endsWith('/') ? root : `${root}/`;
	if (!path.startsWith(prefix)) return null;
	return { rel: path.slice(prefix.length), line: frame.line, column: Math.max(1, frame.column || 1) };
}

/** Status bar / view label for the session state. */
export function stateLabel(m: DebugModel | null): string {
	if (!m) return '';
	switch (m.state) {
		case 'initializing':
			return t('tools.debug.state.initializing');
		case 'running':
			return t('tools.debug.state.running');
		case 'stopped':
			return m.stopped?.reason ? t('tools.debug.state.stoppedReason', { reason: m.stopped.reason }) : t('tools.debug.state.stopped');
		case 'terminated':
			return t('tools.debug.state.terminated');
	}
}
