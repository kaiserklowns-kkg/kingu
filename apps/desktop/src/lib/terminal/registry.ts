// Mounted terminals by PTY key, so keybindings (⌘F, ⌘K, splits) act on the one that has focus,
// like VS Code's `terminalFocus` context key.

import type { TerminalFlavor } from './terminalMenu.ts';
import type { ShellIntegration } from './shellIntegrationAddon.ts';

export type TerminalHandle = {
	key: string;
	flavor: TerminalFlavor;
	host: HTMLElement;
	focus(): void;
	find(): void;
	clear(): void;
	selectAll(): void;
	/** Types `data` into the shell (quick commands). */
	write(data: string): void;
	/** Shows `text` in the terminal without sending it to the shell (task messages). */
	print?(text: string): void;
	/** The buffer's lines, oldest first (the chat's Terminal context). */
	lines?(): string[];
	/** Shell integration: its commands, cwd, navigation (shellIntegrationAddon.ts). */
	integration?: ShellIntegration;
	/** The shell it runs (its history is kept per shell type). */
	shell?(): string;
	/** The program asked for bracketed paste (a multi-line command goes as one paste). */
	bracketedPaste?(): boolean;
	/** Scrolls a page up (-1) or down (1). */
	scrollPage?(direction: -1 | 1): void;
};

const handles = new Map<string, TerminalHandle>();
/** The ADE terminal focused last: where `Terminal: Run Quick Command…` types. */
let lastAde: string | null = null;
/** The terminal of any layout focused last (the chat's "Terminal" context reads it). */
let lastAny: string | null = null;

/** Records `key` as the last used terminal, and ADE terminal (on focus). */
export function touchTerminal(key: string) {
	lastAny = key;
	if (handles.get(key)?.flavor === 'ade') lastAde = key;
}

/** The terminal used last that is still mounted. */
export const lastTerminal = (): TerminalHandle | null => (lastAny ? (handles.get(lastAny) ?? null) : null);

/** The ADE terminal used last that is still mounted. */
export const lastAdeTerminal = (): TerminalHandle | null => (lastAde ? (handles.get(lastAde) ?? null) : null);

export function registerTerminal(h: TerminalHandle): () => void {
	handles.set(h.key, h);
	return () => {
		if (handles.get(h.key) === h) handles.delete(h.key);
	};
}

export const terminalHandle = (key: string) => handles.get(key) ?? null;

/** The terminal holding keyboard focus, optionally only of one layout. */
export function focusedTerminal(flavor?: TerminalFlavor): TerminalHandle | null {
	const el = typeof document === 'undefined' ? null : document.activeElement;
	if (!el) return null;
	for (const h of handles.values()) if (h.host.contains(el) && (!flavor || h.flavor === flavor)) return h;
	return null;
}

/** Focuses `key` once it is mounted and shown (a new split pane mounts on the next tick). */
export function focusTerminal(key: string, tries = 10) {
	const h = handles.get(key);
	if (h && h.host.offsetParent !== null) h.focus();
	else if (tries > 0) setTimeout(() => focusTerminal(key, tries - 1), 30);
}

/** What pty_spawn runs in a task terminal (src-tauri/src/tasks.rs TaskLaunch). */
export type TaskSpawn = {
	argv: string[];
	defaultShell: boolean;
	cwd?: string;
	env: Record<string, string>;
	echo: string;
	failedPrefix: string;
	failedSuffix: string;
	wait: string;
};

/** Task terminals whose task was started in this page: a remount re-attaches or opens a shell, never runs it again. */
const spawnedTasks = new Set<string>();
export const taskSpawned = (key: string) => spawnedTasks.has(key);
export function markTaskSpawned(key: string) {
	spawnedTasks.add(key);
}

/** Live output of a terminal, for whoever watches it (a task's problem matchers). */
const taps = new Map<string, Set<(chunk: string) => void>>();

export function tapOutput(key: string, fn: (chunk: string) => void): () => void {
	let set = taps.get(key);
	if (!set) taps.set(key, (set = new Set()));
	set.add(fn);
	return () => {
		set.delete(fn);
		if (!set.size && taps.get(key) === set) taps.delete(key);
	};
}

export function emitOutput(key: string, chunk: string) {
	const set = taps.get(key);
	if (set) for (const fn of [...set]) fn(chunk);
}
