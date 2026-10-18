// Add Context (VS Code's chatContextActions + chatInputCompletions, Cursor's @-mentions), the pure
// part so `bun test` covers it: the `#` / `@` word being typed in the chat input, the sources the
// picker offers, and how each source's content becomes a `ContextText` (problems, a folder's
// files, the terminal's last command, a past chat).

import { parseRequest, type ContextText } from './chatPrompt.ts';
import type { AgentEvent } from './events';

/** Add Context's sources, in the picker's order (VS Code's "Add Context..." quick pick). */
export const CONTEXT_SOURCES = ['files', 'selection', 'problems', 'scm', 'terminal', 'clipboardImage', 'pastChat', 'instructions'] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

// ---- `#` / `@` in the input ------------------------------------------------------------------

export type Mention = { start: number; trigger: '#' | '@'; query: string };

/**
 * The `#word` / `@word` the caret is in: the trigger at the start of the input or after a space,
 * and what follows it up to the caret (no spaces). null otherwise.
 */
export function mentionQuery(text: string, caret: number): Mention | null {
	const before = text.slice(0, caret);
	const m = /(^|\s)([#@])([^\s#@]*)$/.exec(before);
	if (!m) return null;
	return { start: before.length - m[3].length - 1, trigger: m[2] as '#' | '@', query: m[3] };
}

/** The input with the mention (`start` up to the caret) taken out; the caret goes where it was. */
export function removeMention(text: string, start: number, caret: number): { text: string; caret: number } {
	return { text: text.slice(0, start) + text.slice(caret), caret: start };
}

/** Sources whose label matches `query` (all of them for an empty one). */
export function matchSources(query: string, label: (s: ContextSource) => string): ContextSource[] {
	const q = query.toLowerCase();
	return CONTEXT_SOURCES.filter((s) => !q || label(s).toLowerCase().includes(q) || s.toLowerCase().includes(q));
}

// ---- files and folders -----------------------------------------------------------------------

/** The folders of a file list (every ancestor of every file), sorted. */
export function foldersOf(files: readonly string[]): string[] {
	const dirs = new Set<string>();
	for (const f of files) {
		const parts = f.split('/');
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
	}
	return [...dirs].sort();
}

/** A folder as context: the files under it (from the listing), at most `max`. */
export function folderContext(folder: string, files: readonly string[], max = 500): ContextText {
	const base = folder.replace(/\/+$/, '') + '/';
	const inside = files.filter((f) => f.startsWith(base));
	const shown = inside.slice(0, max);
	const more = inside.length > max ? `\n… ${inside.length - max} more` : '';
	return { kind: 'folder', label: folder.split('/').pop() || folder, text: `Folder ${base} (${inside.length} files):\n${shown.join('\n')}${more}` };
}

/** Instructions and rules files in a file list (CLAUDE.md, AGENTS.md, Cursor and Copilot rules). */
export function isInstructionsFile(path: string): boolean {
	const name = path.split('/').pop() ?? '';
	if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md' || name === 'AGENTS.md') return true;
	return (
		path === '.github/copilot-instructions.md' ||
		/(^|\/)\.github\/instructions\/[^/]+\.instructions\.md$/.test(path) ||
		/(^|\/)\.cursor\/rules\/.+\.mdc?$/.test(path) ||
		path === '.cursorrules' ||
		/(^|\/)\.claude\/rules\/.+\.md$/.test(path)
	);
}

// ---- problems --------------------------------------------------------------------------------

type ProblemLike = { label: string; items: { range: { start: { line: number; character: number } }; severity?: number; message: string; source?: string; code?: number | string }[] };

const SEVERITY = ['error', 'error', 'warning', 'info', 'hint'];

/** The Problems panel as text: `path:line:col severity: message (source code)`, at most `max` rows. */
export function problemsContext(files: readonly ProblemLike[], max = 200): ContextText | null {
	const rows: string[] = [];
	let total = 0;
	for (const f of files) {
		for (const d of f.items) {
			total++;
			if (rows.length >= max) continue;
			const where = `${f.label}:${d.range.start.line + 1}:${d.range.start.character + 1}`;
			const tag = [d.source, d.code !== undefined ? String(d.code) : ''].filter(Boolean).join(' ');
			rows.push(`${where} ${SEVERITY[d.severity ?? 1] ?? 'error'}: ${d.message.replace(/\s*\n\s*/g, ' ')}${tag ? ` (${tag})` : ''}`);
		}
	}
	if (!total) return null;
	return { kind: 'problems', label: `${total}`, text: rows.join('\n') + (total > max ? `\n… ${total - max} more` : '') };
}

// ---- terminal --------------------------------------------------------------------------------

/** Ends like a shell prompt: `$`, `%`, `#`, `>`, `❯`, `➜`, `»` (then nothing typed yet). */
const PROMPT_END = /[$%#>❯➜»λ]$/;

/**
 * The terminal's last command and its output, from its lines (oldest first). Without shell
 * integration the prompt is guessed: the last line is the waiting prompt, and the command is the
 * nearest earlier line that starts with that prompt. Failing that, the last `tail` lines.
 */
export function lastCommandOutput(lines: readonly string[], tail = 80): { command: string | null; output: string } {
	const all = lines.map((l) => l.replace(/\s+$/, ''));
	while (all.length && !all[all.length - 1]) all.pop();
	if (!all.length) return { command: null, output: '' };
	const prompt = all[all.length - 1];
	if (PROMPT_END.test(prompt)) {
		for (let i = all.length - 2; i >= 0; i--) {
			const line = all[i];
			if (line.startsWith(prompt) && line.length > prompt.length) {
				return { command: line.slice(prompt.length).trim(), output: all.slice(i + 1, -1).join('\n') };
			}
		}
		return { command: null, output: all.slice(-tail - 1, -1).join('\n') };
	}
	return { command: null, output: all.slice(-tail).join('\n') };
}

// ---- past chat -------------------------------------------------------------------------------

/**
 * A saved chat as context: its requests (what the user typed) and the agent's answers, newest
 * last, cut from the oldest end to `max` characters.
 */
export function pastChatContext(title: string, events: readonly AgentEvent[], max = 24 * 1024): ContextText | null {
	const parts: string[] = [];
	for (const ev of events) {
		if (ev.kind !== 'message' || ev.parent_tool_use_id) continue;
		const text = ev.role === 'user' ? parseRequest(ev.text).text : ev.text.trim();
		if (text) parts.push(`${ev.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
	}
	if (!parts.length) return null;
	let body = parts.join('\n\n');
	if (body.length > max) body = `… (earlier messages cut)\n\n${body.slice(body.length - max)}`;
	return { kind: 'chat', label: title, text: `Earlier chat "${title}":\n\n${body}` };
}
