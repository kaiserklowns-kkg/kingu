// `/` commands in the chat input (VS Code's chatSlashCommands + chatInputCompletions), pure so
// `bun test` covers it. The list is Kingu's own commands (handled before anything is sent), then
// the session's (SDK `supportedCommands()`: built-ins, skills, plugins), then the `.claude/commands`
// files and skills Rust found (`chat_slash_commands`, for a chat with no session yet). Anything
// that is not Kingu's goes to the agent as text; the SDK expands it.

import type { SessionCommand } from './events';

/** Where a command comes from (`project`… are `chat_slash_commands`' sources). */
export type SlashSource = 'kingu' | 'session' | 'project' | 'user' | 'project-skill' | 'user-skill';

export type SlashItem = { name: string; description: string; argumentHint: string; source: SlashSource };

/** A command file or skill from Rust (`slash_commands.rs`). */
export type FileCommand = { name: string; description: string; argument_hint: string; source: Exclude<SlashSource, 'kingu' | 'session'> };

/**
 * A Kingu command: runs in the app instead of being sent. `run` gets what followed the name.
 * Built by the panel (`kinguCommands`), which knows how to do each.
 */
export type LocalCommand = SlashItem & { source: 'kingu'; run: (args: string) => void | Promise<void> };

/**
 * Kingu's commands from the panel's handlers: `/clear` (a new chat), `/model` (the model picker),
 * and `/fork` when a fork handler is given.
 */
export function kinguCommands(
	h: { clear: () => void; model: () => void; fork?: () => void | Promise<void> },
	label: (name: 'clear' | 'model' | 'fork') => string
): LocalCommand[] {
	const cmd = (name: 'clear' | 'model' | 'fork', run: () => void | Promise<void>): LocalCommand => ({ name, description: label(name), argumentHint: '', source: 'kingu', run: () => run() });
	return [cmd('clear', h.clear), cmd('model', h.model), ...(h.fork ? [cmd('fork', h.fork)] : [])];
}

/**
 * The `/` being typed: the text after it while the caret is still in the first word of an input
 * that starts with `/` (VS Code completes the command only there). null otherwise.
 */
export function slashQuery(text: string, caret: number): string | null {
	if (!text.startsWith('/') || caret < 1) return null;
	const word = text.slice(1, caret);
	return /\s|\//.test(word) ? null : word;
}

/** Kingu's commands first, then the session's, then files the session does not already list. */
export function mergeCommands(local: readonly SlashItem[], session: readonly SessionCommand[], files: readonly FileCommand[]): SlashItem[] {
	const out: SlashItem[] = [];
	const seen = new Set<string>();
	const add = (item: SlashItem) => {
		if (!item.name || seen.has(item.name)) return;
		seen.add(item.name);
		out.push(item);
	};
	local.forEach(add);
	for (const c of session) add({ name: c.name, description: c.description, argumentHint: c.argument_hint, source: 'session' });
	for (const f of files) add({ name: f.name, description: f.description, argumentHint: f.argument_hint, source: f.source });
	return out;
}

/** Commands matching `query`: names starting with it first, then names containing it, in list order. */
export function filterCommands<T extends SlashItem>(items: readonly T[], query: string, max = 50): T[] {
	const q = query.toLowerCase();
	if (!q) return items.slice(0, max);
	const starts = items.filter((c) => c.name.toLowerCase().startsWith(q));
	const contains = items.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
	return [...starts, ...contains].slice(0, max);
}

/** The input after picking `name`: `/name ` replacing the typed word, the rest kept. Caret goes after the space. */
export function completeCommand(text: string, name: string): { text: string; caret: number } {
	const end = text.search(/\s/);
	const rest = end < 0 ? '' : text.slice(end).replace(/^[ \t]+/, '');
	const head = `/${name} `;
	return { text: head + rest, caret: head.length };
}

/** `/name args…` → its parts; null when the input is not a command. */
export function parseCommand(text: string): { name: string; args: string } | null {
	const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return m ? { name: m[1], args: (m[2] ?? '').trim() } : null;
}

/** The Kingu command an input runs, if any. */
export function localCommandFor<T extends { name: string }>(text: string, local: readonly T[]): { command: T; args: string } | null {
	const parsed = parseCommand(text);
	const command = parsed && local.find((c) => c.name === parsed.name);
	return command && parsed ? { command, args: parsed.args } : null;
}

/** The next highlighted row for ↑/↓ (wrapping, like VS Code's suggest widget). */
export function moveActive(active: number, count: number, dir: 'up' | 'down'): number {
	if (count <= 0) return 0;
	return dir === 'down' ? (active + 1) % count : (active - 1 + count) % count;
}
