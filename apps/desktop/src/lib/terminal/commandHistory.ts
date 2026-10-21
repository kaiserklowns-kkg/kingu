// Run Recent Command and Go to Recent Directory (VS Code's terminal history): commands and
// directories that shell integration saw, kept per shell type across sessions
// (`terminal.integrated.shellIntegration.history` entries), plus the shell's own history file.
// Pure apart from the storage passed in.

import type { PickItem } from '#lib/workbench/quick.svelte.ts';

export type HistoryStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

const COMMANDS_KEY = 'kingu.terminal.history.commands';
const DIRS_KEY = 'kingu.terminal.history.dirs';

/** The shell type history is kept for: `zsh` for `/bin/zsh`, `default` when unknown. */
export function shellType(shell: string | undefined | null): string {
	const name = (shell ?? '').trim().split('/').pop()?.replace(/^-/, '').replace(/\.exe$/, '') ?? '';
	return /^[\w.-]+$/.test(name) ? name : 'default';
}

/** `list` with `entry` moved to its end (most recent last), at most `limit` long. */
export function remember(list: readonly string[], entry: string, limit: number): string[] {
	const text = entry.replace(/\s+$/, '');
	if (!text.trim() || limit <= 0) return limit <= 0 ? [] : [...list];
	return [...list.filter((x) => x !== text), text].slice(-limit);
}

function read(storage: HistoryStorage | undefined, key: string): Record<string, string[]> {
	try {
		const v = JSON.parse(storage?.getItem(key) ?? '{}');
		if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
		const out: Record<string, string[]> = {};
		for (const [k, list] of Object.entries(v)) if (Array.isArray(list)) out[k] = list.filter((x): x is string => typeof x === 'string');
		return out;
	} catch {
		return {};
	}
}

function write(storage: HistoryStorage | undefined, key: string, value: Record<string, string[]>) {
	try {
		storage?.setItem(key, JSON.stringify(value));
	} catch {
		// Storage full or unavailable: the history lasts until reload.
	}
}

/** History of earlier sessions, per shell type (VS Code's "previous session" section). */
export class TerminalHistory {
	#storage: HistoryStorage | undefined;
	constructor(storage: HistoryStorage | undefined) {
		this.#storage = storage;
	}

	commands(shell: string): string[] {
		return read(this.#storage, COMMANDS_KEY)[shellType(shell)] ?? [];
	}

	directories(shell: string): string[] {
		return read(this.#storage, DIRS_KEY)[shellType(shell)] ?? [];
	}

	addCommand(shell: string, command: string, limit: number) {
		this.#add(COMMANDS_KEY, shell, command, limit);
	}

	addDirectory(shell: string, dir: string, limit: number) {
		this.#add(DIRS_KEY, shell, dir, limit);
	}

	#add(key: string, shell: string, entry: string, limit: number) {
		const all = read(this.#storage, key);
		const type = shellType(shell);
		all[type] = remember(all[type] ?? [], entry, limit);
		write(this.#storage, key, all);
	}

	clear() {
		write(this.#storage, COMMANDS_KEY, {});
		write(this.#storage, DIRS_KEY, {});
	}
}

export type HistorySection = 'session' | 'previous' | 'shellFile';

/**
 * Run Recent Command's list, VS Code's sections: this terminal's session, then earlier sessions
 * of this shell type, then the shell's history file, each most recent first and without a command
 * an earlier section shows. Each `id` is `<section>:<index>`; `entries` maps it back to the text.
 */
export function recentCommandItems(
	sources: { session: readonly string[]; previous: readonly string[]; shellFile: readonly string[] },
	labels: Record<HistorySection, string>
): { items: PickItem[]; entries: Map<string, string> } {
	const seen = new Set<string>();
	const items: PickItem[] = [];
	const entries = new Map<string, string>();
	for (const section of ['session', 'previous', 'shellFile'] as const) {
		let first = true;
		const list = sources[section];
		for (let i = list.length - 1; i >= 0; i--) {
			const text = list[i];
			if (!text.trim() || seen.has(text)) continue;
			seen.add(text);
			const id = `${section}:${i}`;
			entries.set(id, text);
			// A multi-line command shows on one row.
			items.push({ id, label: text.replace(/\s*\n\s*/g, ' ⏎ '), ...(first ? { separator: labels[section] } : {}) });
			first = false;
		}
	}
	return { items, entries };
}

/** Go to Recent Directory's list: this terminal's directories, then earlier sessions', most recent first. */
export function recentDirectoryItems(session: readonly string[], previous: readonly string[], labels: { session: string; previous: string }, home?: string): PickItem[] {
	const seen = new Set<string>();
	const out: PickItem[] = [];
	for (const [section, list] of [['session', session], ['previous', previous]] as const) {
		let first = true;
		for (let i = list.length - 1; i >= 0; i--) {
			const dir = list[i];
			if (!dir || seen.has(dir)) continue;
			seen.add(dir);
			const label = home && (dir === home || dir.startsWith(home + '/')) ? '~' + dir.slice(home.length) : dir;
			out.push({ id: dir, label, ...(first ? { separator: labels[section] } : {}) });
			first = false;
		}
	}
	return out;
}

/** `arg` as one word for a POSIX shell, fish or pwsh (single-quoted when it needs quoting). */
export function shellQuote(arg: string, shell?: string): string {
	if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
	const type = shellType(shell);
	if (type === 'pwsh' || type === 'powershell') return `'${arg.replace(/'/g, "''")}'`;
	if (type === 'fish') return `'${arg.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Go to Recent Directory's command for `dir`. */
export const cdCommand = (dir: string, shell?: string) => `cd ${shellQuote(dir, shell)}`;

/** What to type for a picked history entry: run it (Enter) or only write it (Alt held). A
 *  multi-line command goes as a bracketed paste when the shell asked for that mode. */
export function commandInput(text: string, run: boolean, bracketed: boolean): string {
	const multiline = text.includes('\n');
	const body = multiline && bracketed ? `\x1b[200~${text}\x1b[201~` : text.replace(/\r?\n/g, '\r');
	return run ? body + '\r' : body;
}
