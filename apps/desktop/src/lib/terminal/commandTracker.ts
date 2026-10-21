// The commands a terminal ran, from its shell integration events (shellIntegration.ts): where
// each prompt, command line and output starts and ends in the buffer, its exit code and the
// directory it ran in (VS Code's command detection capability). Positions are markers, which move
// with the buffer as it scrolls and are disposed when their line leaves the scrollback. Pure:
// xterm's markers are passed in, so tests use plain objects.

import type { ShellEvent } from './shellIntegration.ts';

/** A buffer line that follows scrolling (xterm's IMarker). */
export interface Mark {
	readonly line: number;
	readonly isDisposed: boolean;
	dispose(): void;
}

export type TerminalCommand<M extends Mark = Mark> = {
	id: number;
	/** `mark`: an OSC 1337 SetMark, a navigation stop without a command. */
	kind: 'command' | 'mark';
	/** A: the first line of the prompt. */
	promptStart?: M;
	/** B: where the command line starts (and its column). */
	commandStart?: M;
	commandStartX?: number;
	/** C: where the output starts. */
	executed?: M;
	/** D: the line after the output (the next prompt). */
	end?: M;
	command: string;
	/** Undefined while running, or when the shell did not say. */
	exitCode?: number;
	/** The directory it ran in. */
	cwd?: string;
	startedAt?: number;
	finishedAt?: number;
};

/** The first line of a command (its prompt, else its command line). */
export function commandLine<M extends Mark>(c: TerminalCommand<M>): number {
	const m = c.promptStart && !c.promptStart.isDisposed ? c.promptStart : c.commandStart && !c.commandStart.isDisposed ? c.commandStart : c.executed;
	return m && !m.isDisposed ? m.line : -1;
}

/** Whether `c` failed (a non-zero exit code). */
export const failed = (c: TerminalCommand) => c.exitCode !== undefined && c.exitCode !== 0;

export type TrackerHost<M extends Mark> = {
	/** A marker on the cursor's line. */
	mark(): M;
	/** The cursor's column. */
	cursorX(): number;
	/** The text typed between B (line, column) and C, when the shell sent no E. */
	textBetween(from: M, x: number, to: M): string;
	now?(): number;
};

/** The most commands kept (VS Code keeps them while their lines are in the scrollback). */
export const MAX_COMMANDS = 1000;
/** The most recent directories kept for Go to Recent Directory. */
export const MAX_DIRECTORIES = 50;

export class CommandTracker<M extends Mark = Mark> {
	/** Finished commands and marks, oldest first. */
	commands: TerminalCommand<M>[] = [];
	/** The command being typed or running. */
	current: TerminalCommand<M> | null = null;
	/** The shell's current directory, as last reported. */
	cwd: string | undefined;
	/** Directories visited in this terminal, most recent last. */
	directories: string[] = [];
	/** The shell program, when the script said (Kingu's `P;Shell=`). */
	shell: string | undefined;
	/** Any shell integration sequence arrived: commands are known. */
	active = false;
	#seq = 0;
	#listeners = new Set<(c: TerminalCommand<M>) => void>();
	#host: TrackerHost<M>;

	constructor(host: TrackerHost<M>) {
		this.#host = host;
	}

	/** Called with each command as it finishes (and each mark). */
	onFinished(fn: (c: TerminalCommand<M>) => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	#now() {
		return this.#host.now ? this.#host.now() : Date.now();
	}

	#fresh(): TerminalCommand<M> {
		return { id: ++this.#seq, kind: 'command', command: '' };
	}

	#drop(c: TerminalCommand<M> | null) {
		for (const m of [c?.promptStart, c?.commandStart, c?.executed, c?.end]) m?.dispose();
	}

	#push(c: TerminalCommand<M>) {
		this.commands.push(c);
		if (this.commands.length > MAX_COMMANDS) for (const old of this.commands.splice(0, this.commands.length - MAX_COMMANDS)) this.#drop(old);
		for (const fn of [...this.#listeners]) fn(c);
	}

	/** Ends the running command (a D, or a prompt that came without one). */
	#finish(exitCode: number | undefined) {
		const c = this.current;
		if (!c?.executed) return;
		c.end = this.#host.mark();
		c.exitCode = exitCode;
		c.finishedAt = this.#now();
		this.current = null;
		this.#push(c);
	}

	setCwd(cwd: string) {
		this.cwd = cwd;
		this.directories = [...this.directories.filter((d) => d !== cwd), cwd].slice(-MAX_DIRECTORIES);
	}

	handle(e: ShellEvent) {
		this.active = true;
		switch (e.type) {
			case 'promptStart': {
				// A prompt after output that never got its D: that command is over.
				if (this.current?.executed) this.#finish(undefined);
				// A prompt drawn again (a resize, a theme repaint) replaces the one not yet used.
				this.#drop(this.current);
				this.current = { ...this.#fresh(), promptStart: this.#host.mark() };
				break;
			}
			case 'commandStart': {
				if (this.current?.executed) this.#finish(undefined);
				const c = (this.current ??= this.#fresh());
				c.commandStart?.dispose();
				c.commandStart = this.#host.mark();
				c.commandStartX = this.#host.cursorX();
				break;
			}
			case 'commandLine': {
				const c = (this.current ??= this.#fresh());
				c.command = e.command;
				break;
			}
			case 'executed': {
				const c = (this.current ??= this.#fresh());
				if (c.executed) break;
				c.executed = this.#host.mark();
				c.startedAt = this.#now();
				c.cwd = this.cwd;
				if (!c.command && c.commandStart) c.command = this.#host.textBetween(c.commandStart, c.commandStartX ?? 0, c.executed).trim();
				break;
			}
			case 'finished': {
				if (this.current?.executed) this.#finish(e.exitCode);
				else {
					// Nothing ran (an empty line, the first prompt).
					this.#drop(this.current);
					this.current = null;
				}
				break;
			}
			case 'cwd':
				this.setCwd(e.cwd);
				break;
			case 'property':
				if (e.key === 'Shell' && e.value) this.shell = e.value;
				break;
			case 'mark': {
				const m = this.#host.mark();
				this.#push({ ...this.#fresh(), kind: 'mark', promptStart: m, finishedAt: this.#now() });
				break;
			}
		}
	}

	/** Forgets commands whose lines left the scrollback (or were cleared). */
	prune() {
		// The oldest lines go first: nothing to do while the oldest command is still there.
		if (!this.commands.length || commandLine(this.commands[0]) >= 0) return;
		const keep = (c: TerminalCommand<M>) => commandLine(c) >= 0;
		const gone = this.commands.filter((c) => !keep(c));
		if (!gone.length) return;
		for (const c of gone) this.#drop(c);
		this.commands = this.commands.filter(keep);
	}

	/** Every command and the running one, by first line. */
	all(): TerminalCommand<M>[] {
		return this.current?.executed ? [...this.commands, this.current] : this.commands;
	}

	/** The last finished real command (not a mark). */
	last(): TerminalCommand<M> | undefined {
		for (let i = this.commands.length - 1; i >= 0; i--) if (this.commands[i].kind === 'command') return this.commands[i];
		return undefined;
	}

	/** The command whose prompt or output holds buffer line `line`. */
	at(line: number): TerminalCommand<M> | undefined {
		const all = this.all().filter((c) => c.kind === 'command');
		for (let i = all.length - 1; i >= 0; i--) {
			const start = commandLine(all[i]);
			if (start < 0 || start > line) continue;
			const end = all[i].end && !all[i].end!.isDisposed ? all[i].end!.line : Infinity;
			return line < end || (line === end && end === start) ? all[i] : undefined;
		}
		return undefined;
	}

	dispose() {
		for (const c of this.commands) this.#drop(c);
		this.#drop(this.current);
		this.commands = [];
		this.current = null;
		this.#listeners.clear();
	}
}

/** The output lines of a finished command: from C to the line before D (inclusive), or null. */
export function outputRange(c: TerminalCommand): { start: number; end: number } | null {
	if (!c.executed || c.executed.isDisposed) return null;
	const start = c.executed.line;
	const end = c.end && !c.end.isDisposed ? c.end.line - 1 : start;
	return end >= start ? { start, end } : null;
}

/** The lines navigation stops at, in order (each command's first line). */
export function navigationLines(commands: readonly TerminalCommand[]): number[] {
	return [...new Set(commands.map(commandLine).filter((l) => l >= 0))].sort((a, b) => a - b);
}

/**
 * Go to Previous/Next Command (⌘↑ / ⌘↓): the next stop from `from` in `direction`, or null (none:
 * the top of the buffer going up, the prompt at the bottom going down). `from` is the stop navigated to last while the
 * viewport still shows it, else the viewport's top line (the cursor line when at the bottom).
 */
export function navigate(lines: readonly number[], from: number, direction: -1 | 1): number | null {
	if (direction < 0) {
		for (let i = lines.length - 1; i >= 0; i--) if (lines[i] < from) return lines[i];
		return null;
	}
	for (const l of lines) if (l > from) return l;
	return null;
}

/**
 * Sticky scroll (`terminal.integrated.stickyScroll.*`): the command whose output runs past the
 * viewport's top line `top` while its own first line is scrolled away, unless its program is one
 * of `ignored` (full-screen and agent CLIs).
 */
export function stickyCommand<M extends Mark>(commands: readonly TerminalCommand<M>[], top: number, ignored: readonly string[] = []): TerminalCommand<M> | undefined {
	for (let i = commands.length - 1; i >= 0; i--) {
		const c = commands[i];
		if (c.kind !== 'command') continue;
		const start = commandLine(c);
		if (start < 0 || start >= top) continue;
		const end = c.end && !c.end.isDisposed ? c.end.line : Infinity;
		if (end <= top) return undefined;
		const program = c.command.trim().split(/\s+/)[0] ?? '';
		return ignored.includes(program) ? undefined : c;
	}
	return undefined;
}

/** How long ago `at` was, for a decoration's hover (`5 minutes ago`). */
export function ago(at: number, now: number): { unit: 'second' | 'minute' | 'hour' | 'day'; count: number } {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 60) return { unit: 'second', count: s };
	if (s < 3600) return { unit: 'minute', count: Math.floor(s / 60) };
	if (s < 86400) return { unit: 'hour', count: Math.floor(s / 3600) };
	return { unit: 'day', count: Math.floor(s / 86400) };
}
