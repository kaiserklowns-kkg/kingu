// Shell integration in an xterm terminal (VS Code's ShellIntegrationAddon, command detection and
// decorations): parses the sequences (shellIntegration.ts) into commands (commandTracker.ts),
// draws a success / failure mark beside each command and in the overview ruler, and offers
// command navigation, output selection and the command text for Run Recent Command, sticky
// scroll and quick fixes.

import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import { ago, CommandTracker, commandLine, failed, navigate, navigationLines, outputRange, stickyCommand, type TerminalCommand } from './commandTracker.ts';
import { decorationPlaces, SHELL_INTEGRATION_OSCS } from './shellIntegration.ts';
import { quickFixes, type QuickFix } from './quickFixes.ts';

export type Command = TerminalCommand<IMarker>;

export type IntegrationOptions = {
	/** terminal.integrated.shellIntegration.decorationsEnabled. */
	decorations(): string;
	/** terminal.integrated.shellIntegration.quickFixEnabled. */
	quickFixes(): boolean;
	/** The page is writing the replay of a re-attached session (its commands ran earlier). */
	replaying(): boolean;
	/** A command finished live (not replayed): history, signals. */
	onCommand?(c: Command): void;
	/** A command's decoration was clicked. */
	onDecorationClick?(c: Command, e: MouseEvent): void;
	/** The text of a decoration's hover. */
	describe(c: Command): string;
	/** Commands, the cwd or sticky scroll changed. */
	onChange?(): void;
};

/** VS Code's terminalCommandDecoration.* defaults. */
const COLORS = {
	default: ['--vscode-terminalCommandDecoration-defaultBackground', '#ffffff40'],
	success: ['--vscode-terminalCommandDecoration-successBackground', '#1b81a8'],
	error: ['--vscode-terminalCommandDecoration-errorBackground', '#f14c4c']
} as const;

function color(kind: keyof typeof COLORS): string {
	const [variable, fallback] = COLORS[kind];
	const v = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
	return v || fallback;
}

/** The lines `start..=end` of the buffer as text, a soft-wrapped row joined to the one above. */
export function bufferText(t: Terminal, start: number, end: number, firstX = 0): string {
	const buf = t.buffer.active;
	const out: string[] = [];
	for (let y = Math.max(0, start); y <= end && y < buf.length; y++) {
		const line = buf.getLine(y);
		if (!line) break;
		const text = line.translateToString(true, y === start ? firstX : 0);
		if (line.isWrapped && out.length) out[out.length - 1] += text;
		else out.push(text);
	}
	return out.join('\n');
}

export class ShellIntegration {
	readonly tracker: CommandTracker<IMarker>;
	/** Quick fixes of the last finished command, while its output is the last one. */
	fixes: { command: Command; fixes: QuickFix[] } | null = null;
	#t: Terminal;
	#opts: IntegrationOptions;
	#disposables: { dispose(): void }[] = [];
	#decorations = new Map<number, IDecoration>();
	#fixDecoration: IDecoration | undefined;
	/** The command line navigated to last (⌘↑ / ⌘↓), while it is on screen. */
	#navLine: number | null = null;

	constructor(t: Terminal, opts: IntegrationOptions) {
		this.#t = t;
		this.#opts = opts;
		this.tracker = new CommandTracker<IMarker>({
			mark: () => t.registerMarker(0),
			cursorX: () => t.buffer.active.cursorX,
			textBetween: (from, x, to) => bufferText(t, from.line, Math.max(from.line, to.line - 1), x)
		});
		for (const [code, parse] of SHELL_INTEGRATION_OSCS) {
			this.#disposables.push(
				t.parser.registerOscHandler(code, (data) => {
					const e = parse(data);
					if (!e) return false;
					this.tracker.handle(e);
					if (e.type === 'cwd' || e.type === 'promptStart') opts.onChange?.();
					// OSC 7 and 1337 may matter to someone else too.
					return code === 633 || code === 133;
				})
			);
		}
		this.#disposables.push({ dispose: this.tracker.onFinished((c) => this.#finished(c)) });
		// Lines leaving the scrollback take their commands along.
		this.#disposables.push(t.onScroll(() => (this.tracker.prune(), opts.onChange?.())));
	}

	#finished(c: Command) {
		this.decorate(c);
		if (c.kind !== 'command') return;
		this.#fixDecoration?.dispose();
		this.fixes = null;
		if (!this.#opts.replaying()) {
			this.#opts.onCommand?.(c);
			if (this.#opts.quickFixes()) {
				const fixes = quickFixes(c.command, this.output(c), c.exitCode);
				if (fixes.length) {
					this.fixes = { command: c, fixes };
					this.#decorateFix(c);
				}
			}
		}
		this.#opts.onChange?.();
	}

	/** Draws `c`'s mark in the gutter and the overview ruler (decorationsEnabled). */
	decorate(c: Command) {
		const places = decorationPlaces(this.#opts.decorations());
		const marker = c.promptStart && !c.promptStart.isDisposed ? c.promptStart : c.commandStart;
		if ((!places.gutter && !places.ruler) || !marker || marker.isDisposed) return;
		const state = c.kind === 'mark' || c.exitCode === undefined ? 'default' : failed(c) ? 'error' : 'success';
		const deco = this.#t.registerDecoration({
			marker,
			width: 1,
			...(places.ruler ? { overviewRulerOptions: { color: color(state), position: 'left' as const } } : {})
		});
		if (!deco) return;
		this.#decorations.set(c.id, deco);
		deco.onDispose(() => this.#decorations.get(c.id) === deco && this.#decorations.delete(c.id));
		deco.onRender((el) => {
			if (!places.gutter) {
				el.style.display = 'none';
				return;
			}
			el.classList.add('kingu-command-decoration', `kingu-command-${state}`);
			el.title = this.#opts.describe(c);
			el.onclick = (e) => (e.stopPropagation(), this.#opts.onDecorationClick?.(c, e));
			el.onmousedown = (e) => e.stopPropagation();
		});
	}

	/** A lightbulb on the line after a command with quick fixes (VS Code's quick fix decoration). */
	#decorateFix(c: Command) {
		if (!c.end || c.end.isDisposed || !decorationPlaces(this.#opts.decorations()).gutter) return;
		const deco = this.#t.registerDecoration({ marker: c.end, width: 1, layer: 'top' });
		if (!deco) return;
		this.#fixDecoration = deco;
		deco.onRender((el) => {
			el.classList.add('kingu-command-decoration', 'kingu-command-quickfix');
			el.title = this.#opts.describe(c);
			el.onclick = (e) => (e.stopPropagation(), this.#opts.onDecorationClick?.(c, e));
			el.onmousedown = (e) => e.stopPropagation();
		});
	}

	/** Redraws every decoration (the setting or the color theme changed). */
	redecorate() {
		for (const d of this.#decorations.values()) d.dispose();
		this.#decorations.clear();
		for (const c of this.tracker.commands) this.decorate(c);
	}

	/** The output of `c` as text. */
	output(c: Command): string {
		const r = outputRange(c);
		return r ? bufferText(this.#t, r.start, r.end).replace(/\s+$/, '') : '';
	}

	/** The last finished command. */
	last(): Command | undefined {
		return this.tracker.last();
	}

	/** Where navigation goes from: the stop shown last, else the viewport top (the prompt at the bottom). */
	#from(): number {
		const buf = this.#t.buffer.active;
		const top = buf.viewportY;
		if (this.#navLine !== null && this.#navLine >= top && this.#navLine < top + this.#t.rows) return this.#navLine;
		return top >= buf.baseY ? buf.baseY + buf.cursorY : top;
	}

	/** Go to Previous / Next Command: false when the shell sent no commands (the caller scrolls by page). */
	scrollToCommand(direction: -1 | 1): boolean {
		const lines = navigationLines(this.tracker.all());
		if (!lines.length) return false;
		const target = navigate(lines, this.#from(), direction);
		if (target === null) {
			this.#navLine = null;
			if (direction > 0) this.#t.scrollToBottom();
			else this.#t.scrollToTop();
		} else {
			this.#navLine = target;
			this.#t.scrollToLine(target);
		}
		return true;
	}

	/** Select To Previous / Next Command: from the current stop to the next one. */
	selectToCommand(direction: -1 | 1): boolean {
		const lines = navigationLines(this.tracker.all());
		if (!lines.length) return false;
		const buf = this.#t.buffer.active;
		const from = this.#from();
		const target = navigate(lines, from, direction) ?? (direction > 0 ? buf.baseY + buf.cursorY : 0);
		const [a, b] = from < target ? [from, target - 1] : [target, from - 1];
		if (b >= a) this.#t.selectLines(a, b);
		this.#navLine = target;
		this.#t.scrollToLine(target);
		return true;
	}

	/** Selects the output of `c` (default: the last command). */
	selectOutput(c: Command | undefined = this.last()): boolean {
		const r = c && outputRange(c);
		if (!r) return false;
		this.#t.selectLines(r.start, r.end);
		this.#t.scrollToLine(r.start);
		return true;
	}

	/** Scrolls so `c`'s first line is at the top. */
	reveal(c: Command) {
		const m = c.promptStart && !c.promptStart.isDisposed ? c.promptStart : c.commandStart;
		if (m && !m.isDisposed) this.#t.scrollToLine(m.line);
	}

	/** Sticky scroll: the command to show above the viewport, and its prompt and command lines. */
	sticky(ignored: readonly string[], maxLines: number): { command: Command; text: string } | null {
		const buf = this.#t.buffer.active;
		if (buf.type !== 'normal') return null;
		const c = stickyCommand(this.tracker.all(), buf.viewportY, ignored);
		if (!c) return null;
		const start = commandLine(c);
		const last = c.executed && !c.executed.isDisposed ? c.executed.line - 1 : start;
		const end = Math.min(last, start + Math.max(1, maxLines) - 1, buf.viewportY - 1);
		const text = bufferText(this.#t, start, Math.max(start, end));
		return text.trim() ? { command: c, text } : null;
	}

	/** The directory a command on buffer line `line` ran in (links resolve against it). */
	cwdAt(line: number): string | undefined {
		return this.tracker.at(line)?.cwd ?? this.tracker.cwd;
	}

	dispose() {
		for (const d of this.#disposables) d.dispose();
		for (const d of this.#decorations.values()) d.dispose();
		this.#fixDecoration?.dispose();
		this.#decorations.clear();
		this.tracker.dispose();
	}
}

export { ago, failed };
