// Arkai's built-in tools, run in this process: Read, Write, Edit, Bash, Glob, Grep, TodoWrite and
// WebFetch (webFetch.ts), with Claude Code's names and input fields, so the chat's tool rows,
// permission cards, working set and todo bar show them as they show Claude's. Permission, the
// safety checks and the file snapshot happen before `runTool` (session.ts); these only do the work.
//
// Paths may be relative (to the run's folder) or absolute. Output for the model is capped; the
// chat gets a shorter excerpt.

import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { ToolDef } from './messages.ts';
import type { ToolKind } from '../runtimes/tools.ts';
import { webFetch } from './webFetch.ts';

type Obj = Record<string, unknown>;

export type ToolResult = { content: string; isError: boolean };
/** `fetch`: WebFetch's network (tests pass a fake; the global one otherwise). */
export type ToolContext = { cwd: string; env: Record<string, string | undefined>; signal: AbortSignal; todos?: (todos: unknown) => void; grep?: 'rg' | 'js'; fetch?: typeof fetch };

export const TOOL_NAMES = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'WebFetch'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
/** Light mode's tools (old Arkai's LIGHT_TOOLS): enough to read, change and run a project. */
export const LIGHT_TOOL_NAMES: readonly ToolName[] = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'];

export const KIND: Readonly<Record<ToolName, ToolKind>> = { Read: 'read', Write: 'edit', Edit: 'edit', Bash: 'execute', Glob: 'search', Grep: 'search', TodoWrite: 'think', WebFetch: 'fetch' };

/** Read: lines per call unless `limit` says otherwise, and the longest line kept whole. */
export const READ_LINES = 2000;
const MAX_LINE = 2000;
/** The most output the model gets from one call. */
export const MAX_OUTPUT = 30_000;
const MAX_READ_OUTPUT = 100_000;
export const BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;
const MAX_MATCHES = 250;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Folders Glob and Grep never go into. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);

const str = { type: 'string' } as const;

export const TOOL_DEFS: Readonly<Record<ToolName, ToolDef>> = {
	Read: {
		name: 'Read',
		description: 'Read a text file. Lines come numbered (number, tab, text). Use offset and limit for parts of a long file.',
		parameters: {
			type: 'object',
			properties: {
				file_path: { ...str, description: 'The file, relative to the project folder or absolute' },
				offset: { type: 'integer', description: 'First line to read (1-based)' },
				limit: { type: 'integer', description: `How many lines (default ${READ_LINES})` }
			},
			required: ['file_path']
		}
	},
	Write: {
		name: 'Write',
		description: 'Create a file or replace its whole content. Read an existing file first; prefer Edit for changes to part of it.',
		parameters: {
			type: 'object',
			properties: { file_path: { ...str, description: 'The file, relative to the project folder or absolute' }, content: { ...str, description: 'The whole new content' } },
			required: ['file_path', 'content']
		}
	},
	Edit: {
		name: 'Edit',
		description: 'Replace exact text in a file. old_string must match the file exactly (whitespace included) and only once, unless replace_all is true.',
		parameters: {
			type: 'object',
			properties: {
				file_path: { ...str, description: 'The file, relative to the project folder or absolute' },
				old_string: { ...str, description: 'The exact text to replace' },
				new_string: { ...str, description: 'The text to put in its place' },
				replace_all: { type: 'boolean', description: 'Replace every occurrence' }
			},
			required: ['file_path', 'old_string', 'new_string']
		}
	},
	Bash: {
		name: 'Bash',
		description: 'Run a shell command in the project folder and get its output and exit code. Not for reading or editing files: use Read, Edit and Write.',
		parameters: {
			type: 'object',
			properties: {
				command: { ...str, description: 'The command' },
				description: { ...str, description: 'What it does, in a few words' },
				timeout: { type: 'integer', description: `Milliseconds before it is stopped (default ${BASH_TIMEOUT_MS}, at most ${MAX_BASH_TIMEOUT_MS})` }
			},
			required: ['command']
		}
	},
	Glob: {
		name: 'Glob',
		description: 'Find files by glob pattern, e.g. "src/**/*.ts". Paths come relative to the project folder.',
		parameters: { type: 'object', properties: { pattern: { ...str, description: 'The glob pattern' }, path: { ...str, description: 'Folder to search in (default: the project folder)' } }, required: ['pattern'] }
	},
	Grep: {
		name: 'Grep',
		description: 'Search file contents with a regular expression. Returns matching lines as path:line:text, or only the file paths.',
		parameters: {
			type: 'object',
			properties: {
				pattern: { ...str, description: 'Regular expression' },
				path: { ...str, description: 'File or folder to search (default: the project folder)' },
				glob: { ...str, description: 'Only files matching this glob, e.g. "*.ts"' },
				'-i': { type: 'boolean', description: 'Ignore case' },
				output_mode: { type: 'string', enum: ['content', 'files_with_matches'], description: 'Matching lines (default) or file paths only' }
			},
			required: ['pattern']
		}
	},
	TodoWrite: {
		name: 'TodoWrite',
		description: 'Keep a todo list for a task with several steps: send the whole list each time, one item in_progress at a time.',
		parameters: {
			type: 'object',
			properties: {
				todos: {
					type: 'array',
					items: {
						type: 'object',
						properties: { content: str, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { ...str, description: 'The item as "doing it" (e.g. "Running tests")' } },
						required: ['content', 'status']
					}
				}
			},
			required: ['todos']
		}
	},
	WebFetch: {
		name: 'WebFetch',
		description: 'Fetch a web page (http or https) and get its readable text. The user approves each site first. A redirect to another site is reported, not followed.',
		parameters: {
			type: 'object',
			properties: { url: { ...str, description: 'The full URL' }, prompt: { ...str, description: 'What you are looking for on the page' } },
			required: ['url']
		}
	}
};

export const isToolName = (n: string): n is ToolName => (TOOL_NAMES as readonly string[]).includes(n);

/** An absolute path for a tool's path argument. */
export function resolvePath(p: string, cwd: string): string {
	return normalize(isAbsolute(p) ? p : join(cwd, p));
}

/** The path as the model should see it: relative inside the folder, absolute outside. */
export function shownPath(p: string, cwd: string): string {
	const rel = relative(cwd, p);
	return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : p;
}

const fail = (content: string): ToolResult => ({ content, isError: true });

function need(input: Obj, field: string): string | ToolResult {
	const v = input[field];
	return typeof v === 'string' && (field.endsWith('_string') || field === 'content' || v.trim()) ? v : fail(`Invalid arguments: missing required string \`${field}\``);
}

export function cap(s: string, max = MAX_OUTPUT): string {
	return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters cut)` : s;
}

/** Runs one built-in tool (never throws: a failure is an error result). */
export async function runTool(name: ToolName, input: Obj, ctx: ToolContext): Promise<ToolResult> {
	try {
		switch (name) {
			case 'Read':
				return read(input, ctx);
			case 'Write':
				return write(input, ctx);
			case 'Edit':
				return edit(input, ctx);
			case 'Bash':
				return await bash(input, ctx);
			case 'Glob':
				return glob(input, ctx);
			case 'Grep':
				return await grep(input, ctx);
			case 'TodoWrite':
				return todoWrite(input, ctx);
			case 'WebFetch':
				return await webFetch(input, ctx.signal, ctx.fetch);
		}
	} catch (e) {
		const code = (e as { code?: unknown }).code;
		return fail(code === 'ENOENT' ? `File does not exist: ${String((e as { path?: unknown }).path ?? '')}` : e instanceof Error ? e.message : String(e));
	}
}

function isBinary(bytes: Uint8Array): boolean {
	const n = Math.min(bytes.length, 8000);
	for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
	return false;
}

function read(input: Obj, ctx: ToolContext): ToolResult {
	const p = need(input, 'file_path');
	if (typeof p !== 'string') return p;
	const path = resolvePath(p, ctx.cwd);
	const st = statSync(path);
	if (st.isDirectory()) return fail(`${shownPath(path, ctx.cwd)} is a folder: use Glob to list it`);
	if (st.size > 20 * 1024 * 1024) return fail(`${shownPath(path, ctx.cwd)} is too large to read (${st.size} bytes)`);
	const bytes = readFileSync(path);
	if (isBinary(bytes)) return fail(`${shownPath(path, ctx.cwd)} is a binary file`);
	const lines = bytes.toString('utf8').split('\n');
	if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
	const offset = typeof input.offset === 'number' && input.offset > 0 ? Math.floor(input.offset) : 1;
	const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : READ_LINES;
	if (bytes.length === 0) return { content: '(the file is empty)', isError: false };
	if (offset > lines.length) return fail(`${shownPath(path, ctx.cwd)} has only ${lines.length} lines`);
	const slice = lines.slice(offset - 1, offset - 1 + limit);
	const body = slice.map((l, i) => `${String(offset + i).padStart(6)}\t${l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l}`).join('\n');
	const more = offset - 1 + slice.length < lines.length ? `\n… (${lines.length - (offset - 1 + slice.length)} more lines: read on with offset ${offset + slice.length})` : '';
	return { content: cap(body + more, MAX_READ_OUTPUT), isError: false };
}

function write(input: Obj, ctx: ToolContext): ToolResult {
	const p = need(input, 'file_path');
	if (typeof p !== 'string') return p;
	const content = need(input, 'content');
	if (typeof content !== 'string') return content;
	const path = resolvePath(p, ctx.cwd);
	let existed = false;
	try {
		const st = lstatSync(path);
		if (st.isDirectory()) return fail(`${shownPath(path, ctx.cwd)} is a folder`);
		existed = true;
	} catch {
		// A new file.
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	const lines = content ? content.split('\n').length : 0;
	return { content: `${existed ? 'Wrote' : 'Created'} ${shownPath(path, ctx.cwd)} (${lines} lines)`, isError: false };
}

function edit(input: Obj, ctx: ToolContext): ToolResult {
	const p = need(input, 'file_path');
	if (typeof p !== 'string') return p;
	const oldString = need(input, 'old_string');
	if (typeof oldString !== 'string') return oldString;
	const newString = need(input, 'new_string');
	if (typeof newString !== 'string') return newString;
	const path = resolvePath(p, ctx.cwd);
	if (oldString === newString) return fail('old_string and new_string are the same: nothing to change');
	const text = readFileSync(path, 'utf8');
	if (oldString === '') {
		if (text !== '') return fail('old_string is empty: use Write to replace a whole file');
		writeFileSync(path, newString);
		return { content: `Edited ${shownPath(path, ctx.cwd)}`, isError: false };
	}
	const count = text.split(oldString).length - 1;
	if (count === 0) return fail(`old_string was not found in ${shownPath(path, ctx.cwd)}`);
	if (count > 1 && input.replace_all !== true) return fail(`old_string matches ${count} places in ${shownPath(path, ctx.cwd)}: add surrounding lines to make it unique, or set replace_all`);
	writeFileSync(path, input.replace_all === true ? text.split(oldString).join(newString) : text.replace(oldString, () => newString));
	return { content: `Edited ${shownPath(path, ctx.cwd)}${count > 1 ? ` (${count} places)` : ''}`, isError: false };
}

const SHELL = ['/bin/bash', '/bin/zsh', '/bin/sh'].find((s) => {
	try {
		return statSync(s).isFile();
	} catch {
		return false;
	}
}) ?? 'sh';

async function bash(input: Obj, ctx: ToolContext): Promise<ToolResult> {
	const command = need(input, 'command');
	if (typeof command !== 'string') return command;
	const timeout = Math.min(typeof input.timeout === 'number' && input.timeout > 0 ? input.timeout : BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
	if (ctx.signal.aborted) return fail('Interrupted');
	const proc = Bun.spawn([SHELL, '-c', command], { cwd: ctx.cwd, env: ctx.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
	let timedOut = false;
	const kill = () => {
		try {
			proc.kill('SIGTERM');
			setTimeout(() => proc.kill('SIGKILL'), 2000).unref?.();
		} catch {
			// Already gone.
		}
	};
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, timeout);
	ctx.signal.addEventListener('abort', kill, { once: true });
	const collect = async (s: ReadableStream<Uint8Array>) => {
		let out = '';
		const decoder = new TextDecoder();
		for await (const chunk of s) if (out.length < MAX_OUTPUT * 2) out += decoder.decode(chunk, { stream: true });
		return out;
	};
	const [stdout, stderr, code] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
	clearTimeout(timer);
	ctx.signal.removeEventListener('abort', kill);
	const out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
	if (ctx.signal.aborted) return fail(cap(`${out}\n(interrupted)`.trim()));
	if (timedOut) return fail(cap(`${out}\n(stopped after ${timeout} ms)`.trim()));
	if (code !== 0) return fail(cap(`${out}\nExit code ${code}`.trim()));
	return { content: cap(out || '(no output)'), isError: false };
}

/** Files under `dir` (relative paths, `/`-separated), skipping SKIP_DIRS and symlinked folders. */
function* walk(dir: string, base = dir): Generator<string> {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) yield* walk(full, base);
		} else if (e.isFile()) yield relative(base, full).split(sep).join('/');
	}
}

function searchRoot(input: Obj, ctx: ToolContext): string {
	return typeof input.path === 'string' && input.path.trim() ? resolvePath(input.path, ctx.cwd) : ctx.cwd;
}

function glob(input: Obj, ctx: ToolContext): ToolResult {
	const pattern = need(input, 'pattern');
	if (typeof pattern !== 'string') return pattern;
	const root = searchRoot(input, ctx);
	if (!statSync(root).isDirectory()) return fail(`${shownPath(root, ctx.cwd)} is not a folder`);
	const g = new Bun.Glob(pattern);
	const found: string[] = [];
	for (const rel of walk(root)) {
		if (g.match(rel) || (!pattern.includes('/') && g.match(rel.split('/').pop()!))) {
			found.push(shownPath(join(root, rel), ctx.cwd));
			if (found.length > MAX_MATCHES) break;
		}
	}
	if (!found.length) return { content: 'No files found', isError: false };
	const more = found.length > MAX_MATCHES ? `\n… (more than ${MAX_MATCHES}: narrow the pattern)` : '';
	return { content: found.slice(0, MAX_MATCHES).join('\n') + more, isError: false };
}

async function grep(input: Obj, ctx: ToolContext): Promise<ToolResult> {
	const pattern = need(input, 'pattern');
	if (typeof pattern !== 'string') return pattern;
	const root = searchRoot(input, ctx);
	const files = input.output_mode === 'files_with_matches';
	const ignoreCase = input['-i'] === true;
	const only = typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : null;
	let re: RegExp;
	try {
		re = new RegExp(pattern, ignoreCase ? 'i' : '');
	} catch (e) {
		return fail(`Invalid arguments: bad regular expression (${e instanceof Error ? e.message : 'error'})`);
	}
	const rg = ctx.grep !== 'js' ? Bun.which('rg') : null;
	if (rg) {
		const args = [rg, '--no-heading', '--color', 'never', '--line-number', '--max-columns', '500', ...(ignoreCase ? ['-i'] : []), ...(files ? ['-l'] : []), ...(only ? ['--glob', only] : []), '--', pattern, root];
		const proc = Bun.spawn(args, { cwd: ctx.cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
		const kill = () => proc.kill();
		ctx.signal.addEventListener('abort', kill, { once: true });
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		ctx.signal.removeEventListener('abort', kill);
		if (code === 1) return { content: 'No matches', isError: false };
		if (code !== 0) return fail(err.trim() || `rg failed (${code})`);
		const lines = out.split('\n').filter(Boolean);
		const shown = lines.slice(0, MAX_MATCHES).map((l) => relLine(l, files, ctx.cwd));
		return { content: cap(shown.join('\n') + (lines.length > MAX_MATCHES ? `\n… (${lines.length - MAX_MATCHES} more)` : '')), isError: false };
	}
	const g = only ? new Bun.Glob(only) : null;
	const st = statSync(root);
	const list = st.isFile() ? [''] : [...walk(root)];
	const out: string[] = [];
	for (const rel of list) {
		if (ctx.signal.aborted) return fail('Interrupted');
		const full = rel ? join(root, rel) : root;
		if (g && rel && !g.match(rel) && !g.match(rel.split('/').pop()!)) continue;
		let bytes: Buffer;
		try {
			if (statSync(full).size > MAX_FILE_BYTES) continue;
			bytes = readFileSync(full);
		} catch {
			continue;
		}
		if (isBinary(bytes)) continue;
		const shown = shownPath(full, ctx.cwd);
		const lines = bytes.toString('utf8').split('\n');
		let hit = false;
		for (let i = 0; i < lines.length; i++) {
			if (!re.test(lines[i]!)) continue;
			hit = true;
			if (files) break;
			out.push(`${shown}:${i + 1}:${lines[i]!.slice(0, 500)}`);
			if (out.length > MAX_MATCHES) break;
		}
		if (files && hit) out.push(shown);
		if (out.length > MAX_MATCHES) break;
	}
	if (!out.length) return { content: 'No matches', isError: false };
	return { content: cap(out.slice(0, MAX_MATCHES).join('\n') + (out.length > MAX_MATCHES ? `\n… (more than ${MAX_MATCHES})` : '')), isError: false };
}

/** An rg line (`/abs/a.ts:3:text`, or the path alone with `-l`) with its path shown relative to the folder. */
function relLine(line: string, pathOnly: boolean, cwd: string): string {
	if (pathOnly) return shownPath(line, cwd);
	const m = /^(.+?):(\d+):(.*)$/.exec(line);
	return m ? `${shownPath(m[1]!, cwd)}:${m[2]}:${m[3]}` : line;
}

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

function todoWrite(input: Obj, ctx: ToolContext): ToolResult {
	if (!Array.isArray(input.todos)) return fail('Invalid arguments: `todos` must be a list');
	const todos = input.todos.flatMap((t) => {
		if (!t || typeof t !== 'object') return [];
		const o = t as Obj;
		const content = typeof o.content === 'string' ? o.content.trim() : '';
		if (!content) return [];
		const status = typeof o.status === 'string' && STATUSES.has(o.status) ? o.status : 'pending';
		return [{ content, status, activeForm: typeof o.activeForm === 'string' && o.activeForm.trim() ? o.activeForm : content }];
	});
	ctx.todos?.(todos);
	const left = todos.filter((t) => t.status !== 'completed').length;
	return { content: `Todo list updated (${todos.length} items, ${left} open)`, isError: false };
}

/** The tools of a run, as offered to the model. */
export function toolDefs(light: boolean): ToolDef[] {
	return (light ? LIGHT_TOOL_NAMES : TOOL_NAMES).map((n) => TOOL_DEFS[n]);
}

/** Files a call writes (snapshotted before it runs). */
export function writtenPaths(name: ToolName, input: Obj, cwd: string): string[] {
	if ((name === 'Write' || name === 'Edit') && typeof input.file_path === 'string' && input.file_path.trim() && !input.file_path.includes('\0')) return [resolvePath(input.file_path, cwd)];
	return [];
}
