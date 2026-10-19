// What a task's terminal runs (VS Code: terminalTaskSystem.ts _createShellLaunchConfig and
// _buildShellCommandLine). A `shell` task is one command line given to the shell with `-c`
// (quoted with the shell's quoting rules: an argument with a space gets strong quotes unless it
// says otherwise), a `process` task is its program and arguments as they are. The result is an
// argv that Rust passes on as separate arguments (src-tauri/src/tasks.rs), never typed into a
// shell, so nothing here can become shell syntax beyond what the task's own command line says.

import { commandValue, type CommandString, type ShellConfig, type ShellQuotingOptions } from './taskConfig.ts';

const SHELL_QUOTES: Record<string, ShellQuotingOptions> = {
	cmd: { strong: '"' },
	powershell: { escape: { escapeChar: '`', charsToEscape: ' "\'()' }, strong: "'", weak: '"' },
	bash: { escape: { escapeChar: '\\', charsToEscape: ' "\'' }, strong: "'", weak: '"' },
	zsh: { escape: { escapeChar: '\\', charsToEscape: ' "\'' }, strong: "'", weak: '"' }
};
const OS_QUOTES = SHELL_QUOTES.bash;

/** The shell's base name without extension, lower case (`/bin/zsh` → `zsh`). */
export function shellBasename(executable: string): string {
	const base = executable.slice(executable.replace(/\\/g, '/').lastIndexOf('/') + 1).toLowerCase();
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(0, dot) : base;
}

export function quotingOptions(basename: string, shell?: ShellConfig): ShellQuotingOptions {
	return shell?.quoting ?? SHELL_QUOTES[basename] ?? OS_QUOTES;
}

/** VS Code's needsQuotes: a space outside quotes and escapes, unless already quoted end to end. */
function needsQuotes(value: string, q: ShellQuotingOptions): boolean {
	if (value.length >= 2) {
		const first = value[0] === q.strong ? q.strong : value[0] === q.weak ? q.weak : undefined;
		if (first === value[value.length - 1]) return false;
	}
	let quote: string | undefined;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === quote) quote = undefined;
		else if (quote !== undefined) continue;
		else if (ch === q.escape) i++;
		else if (ch === q.strong || ch === q.weak) quote = ch;
		else if (ch === ' ') return true;
	}
	return false;
}

function quote(value: string, kind: 'escape' | 'strong' | 'weak', q: ShellQuotingOptions): [string, boolean] {
	if (kind === 'strong' && q.strong) return [q.strong + value + q.strong, true];
	if (kind === 'weak' && q.weak) return [q.weak + value + q.weak, true];
	if (kind === 'escape' && q.escape) {
		if (typeof q.escape === 'string') return [value.replace(/ /g, q.escape + ' '), true];
		const chars = new Set(q.escape.charsToEscape);
		const esc = q.escape.escapeChar;
		return [[...value].map((c) => (chars.has(c) ? esc + c : c)).join(''), true];
	}
	return [value, false];
}

function quoteIfNecessary(value: CommandString, q: ShellQuotingOptions): [string, boolean] {
	if (typeof value === 'string') return needsQuotes(value, q) ? quote(value, 'strong', q) : [value, false];
	return quote(value.value, value.quoting, q);
}

/**
 * The command line a shell task gives the shell. With no arguments a string command is used as
 * written (VS Code's backwards-compatible model), unless a variable made it need quotes.
 */
export function shellCommandLine(basename: string, shell: ShellConfig | undefined, command: CommandString, originalCommand: CommandString | undefined, args: CommandString[], windows = false): string {
	const q = quotingOptions(basename, shell);
	if (!args.length && typeof command === 'string' && (command === originalCommand || (typeof originalCommand === 'string' && needsQuotes(originalCommand, q)))) return command;
	const [cmd, commandQuoted] = quoteIfNecessary(command, q);
	const parts = [cmd];
	let argQuoted = false;
	for (const arg of args) {
		const [v, quoted] = quoteIfNecessary(arg, q);
		parts.push(v);
		argQuoted ||= quoted;
	}
	let line = parts.join(' ');
	if (windows) {
		if (basename === 'cmd' && commandQuoted && argQuoted) line = `"${line}"`;
		else if ((basename === 'powershell' || basename === 'pwsh') && commandQuoted) line = `& ${line}`;
	}
	return line;
}

/** VS Code's _addAllArgument: `-c` is added unless the configured args already end with it. */
export function addAllArgument(toAdd: string[], configured: string[]): string[] {
	const out = [...configured];
	for (const element of toAdd) {
		const add = configured.every((arg, index) => {
			if (arg.toLowerCase() === element && configured.length > index + 1) return !configured.slice(index + 1).every((a) => a.startsWith('-'));
			return arg.toLowerCase() !== element;
		});
		if (add) out.push(element);
	}
	return out;
}

/** What Rust starts: `argv` as given, or with the default shell put in front (`defaultShell`). */
export type TaskLaunch = { argv: string[]; defaultShell: boolean; commandLine: string };

/**
 * A resolved task's argv. `defaultShellArgs`: terminal.integrated.shellArgs of the platform (the
 * default profile's args, `-l` on macOS); `defaultShell`: its executable (empty: `$SHELL`).
 */
export function taskLaunch(
	task: { runtime?: 'shell' | 'process'; command?: CommandString; args: CommandString[]; options: { shell?: ShellConfig } },
	originalCommand: CommandString | undefined,
	defaultShell: { executable: string | null; args: string[] }
): TaskLaunch {
	if (task.command === undefined) throw new Error('task has no command');
	if (task.runtime === 'process') {
		const argv = [commandValue(task.command), ...task.args.map(commandValue)];
		return { argv, defaultShell: false, commandLine: argv.join(' ') };
	}
	const shell = task.options.shell;
	if (shell?.executable) {
		const line = shellCommandLine(shellBasename(shell.executable), shell, task.command, originalCommand, task.args);
		return { argv: [shell.executable, ...(shell.args ?? []), line], defaultShell: false, commandLine: line };
	}
	const executable = defaultShell.executable || '/bin/zsh';
	const line = shellCommandLine(shellBasename(executable), shell, task.command, originalCommand, task.args);
	const args = addAllArgument(['-c'], shell?.args ?? defaultShell.args);
	return defaultShell.executable ? { argv: [defaultShell.executable, ...args, line], defaultShell: false, commandLine: line } : { argv: [...args, line], defaultShell: true, commandLine: line };
}
