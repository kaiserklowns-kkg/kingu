// A task terminal's output stream as the problem matchers see it (VS Code: the terminal's
// onLineData): complete lines without escape sequences, a carriage return overwriting the line
// like the terminal shows it. The task wrapper (src-tauri/src/tasks.rs) reports the command's exit
// code and the closing of the terminal with private OSC 7337 sequences, taken out here.

/** CSI, OSC (BEL or ST terminated), charset selection and other two-byte escape sequences. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_=>78]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

/** What the wrapper's sequences say. */
export type TaskSignal = { kind: 'exit'; code: number } | { kind: 'close' };

const SIGNAL = /\x1b\]7337;(?:exit;(-?\d+)|close)\x07/g;
/** What kingu-ptyd prints when a session's process is gone (session.rs EXITED). */
const PROCESS_EXITED = '[process exited]';

export class TaskOutput {
	#pending = '';

	/** Feeds a chunk; returns the complete lines and the wrapper's signals in it. */
	feed(chunk: string): { lines: string[]; signals: TaskSignal[]; processExited: boolean } {
		let text = this.#pending + chunk;
		const signals: TaskSignal[] = [];
		text = text.replace(SIGNAL, (_, code: string | undefined) => {
			signals.push(code !== undefined ? { kind: 'exit', code: Number(code) } : { kind: 'close' });
			return '';
		});
		const parts = text.split('\n');
		this.#pending = parts.pop() ?? '';
		// A sequence still being received stays pending; a very long line without one is let through.
		if (this.#pending.length > 64 * 1024) {
			parts.push(this.#pending);
			this.#pending = '';
		}
		const lines = parts.map(visibleLine);
		const processExited = lines.some((l) => l === PROCESS_EXITED);
		return { lines: lines.filter((l) => l !== PROCESS_EXITED), signals, processExited };
	}

	/** The last, unterminated line (the task ended without a newline). */
	flush(): string[] {
		const rest = this.#pending;
		this.#pending = '';
		const line = visibleLine(rest.replace(SIGNAL, ''));
		return line && line !== PROCESS_EXITED ? [line] : [];
	}
}

/** One line as the terminal shows it: escapes removed, text after the last carriage return. */
export function visibleLine(raw: string): string {
	const line = stripAnsi(raw.replace(/\r+$/, ''));
	const cr = line.lastIndexOf('\r');
	return cr >= 0 ? line.slice(cr + 1) : line;
}

/** VS Code's formatMessageForTerminal: ` * ` in reverse video before `message`. */
export function formatMessageForTerminal(message: string, opts: { excludeLeadingNewLine?: boolean } = {}): string {
	return `${opts.excludeLeadingNewLine ? '' : '\r\n'}\x1b[0m\x1b[7m * \x1b[0m ${message} \x1b[0m\n\r`;
}
