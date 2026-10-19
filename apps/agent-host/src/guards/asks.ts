// Kingu's "always ask" checks (Cursor's yoloOutsideWorkspaceDisabled, yoloDeleteFileDisabled and
// yoloMcpToolsDisabled, plus .cursorignore-style protected files): a tool call that writes outside
// the run's folder, deletes files, touches a protected path or calls an MCP tool is never run
// without the user's yes, whatever the permission mode or the user's allow rules say. Pure apart
// from `realpath` (passed in), so `bun test` covers it; guards/index.ts asks from its PreToolUse hook.

import { homedir } from 'node:os';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

/** Which asks are on, and the protected paths (gitignore-style patterns, relative to the run's folder). */
export type AskConfig = {
	outsideCwd?: boolean;
	deletes?: boolean;
	mcpTools?: boolean;
	protectedPaths?: string[];
};

export type AskCheck = 'outside_cwd' | 'delete' | 'protected' | 'mcp';

/** Why a call needs the user: the first check that applies, and the paths it is about. */
export type Ask = { check: AskCheck; paths: string[] };

/** Tools that write a file given by its input; Read and the search tools only read. */
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** Tools that take a path to read: a protected path is asked about here too. */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

/** At most this many patterns are kept (a .kinguignore is short; a huge one is a mistake). */
export const MAX_PATTERNS = 500;

// ---------------------------------------------------------------------------------------------
// Protected paths: gitignore-style patterns

export type Rule = { re: RegExp; negate: boolean };

/** One gitignore pattern as a regular expression over a `/`-separated relative path. */
function patternRegex(pattern: string): RegExp {
	const anchored = pattern.includes('/');
	const body = pattern.replace(/^\//, '');
	let re = '';
	for (let i = 0; i < body.length; i++) {
		const c = body.charAt(i);
		if (c === '*') {
			if (body[i + 1] === '*') {
				// `**/` any folders (also none), a trailing `**` everything below.
				const slash = body[i + 2] === '/';
				re += slash ? '(?:.*/)?' : '.*';
				i += slash ? 2 : 1;
			} else re += '[^/]*';
		} else if (c === '?') re += '[^/]';
		else if (c === '[') {
			const end = body.indexOf(']', i + 1);
			if (end < 0) re += '\\[';
			else {
				re += `[${body.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
				i = end;
			}
		} else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
	}
	// Unanchored: the name matches at any depth. Either way everything inside a match is matched.
	return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`);
}

/** The patterns of a .kinguignore (or the setting): comments, blanks and bad lines left out. */
export function parsePatterns(lines: readonly string[]): Rule[] {
	const rules: Rule[] = [];
	for (const raw of lines.slice(0, MAX_PATTERNS)) {
		let line = raw.replace(/\s+$/, '');
		if (!line || line.startsWith('#') || line.length > 500) continue;
		const negate = line.startsWith('!');
		if (negate) line = line.slice(1);
		line = line.replace(/\/+$/, '');
		if (!line) continue;
		try {
			rules.push({ re: patternRegex(line), negate });
		} catch {
			// A pattern that does not compile protects nothing.
		}
	}
	return rules;
}

/** Whether `rel` (relative to the run's folder, `/`-separated) is protected; the last matching rule wins. */
export function isProtected(rules: readonly Rule[], rel: string): boolean {
	let hit = false;
	for (const r of rules) {
		// A `dir/` pattern is matched like `dir` (a tool names files; what is under it is matched either way).
		if (r.re.test(rel)) hit = !r.negate;
	}
	return hit;
}

// ---------------------------------------------------------------------------------------------
// Paths of a call

const str = (o: Record<string, unknown>, ...keys: string[]) => keys.map((k) => o[k]).filter((v): v is string => typeof v === 'string' && v.length > 0);

/** The file paths a file tool's input names. */
export function toolPaths(tool: string, input: unknown): string[] {
	const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
	if (WRITE_TOOLS.has(tool) || READ_TOOLS.has(tool)) return str(o, 'file_path', 'notebook_path', 'path');
	return [];
}

/** Shell words of one command line, quotes removed (no expansion: `$X` stays as written). */
export function shellWords(command: string): string[][] {
	const commands: string[][] = [];
	let words: string[] = [];
	let cur = '';
	let any = false;
	let quote: '"' | "'" | null = null;
	const end = () => {
		if (any) words.push(cur);
		cur = '';
		any = false;
	};
	const next = () => {
		end();
		if (words.length) commands.push(words);
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			if (c === quote) quote = null;
			else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
			else cur += c;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			any = true;
		} else if (c === '\\' && i + 1 < command.length) {
			cur += command[++i];
			any = true;
		} else if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')') next();
		else if (c === ' ' || c === '\t') end();
		else {
			cur += c;
			any = true;
		}
	}
	next();
	return commands;
}

/** Leading `VAR=value`, `sudo`, `env`, `command`, `nohup`, `xargs`, `time` before the program. */
function program(words: readonly string[]): { name: string; args: string[] } | null {
	const i = words.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !['sudo', 'env', 'command', 'nohup', 'xargs', 'time', 'exec'].includes(w));
	const word = i < 0 ? undefined : words[i];
	if (word === undefined) return null;
	return { name: word.split('/').pop() ?? word, args: words.slice(i + 1) };
}

const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash', 'srm']);

/** The files a shell command deletes (`rm`, `git rm`, `git clean`, `find … -delete`); `*` when it cannot tell. */
export function deletedPaths(command: string): string[] | null {
	const out: string[] = [];
	let found = false;
	for (const words of shellWords(command)) {
		const p = program(words);
		if (!p) continue;
		const operands = p.args.filter((a) => !a.startsWith('-'));
		if (DELETERS.has(p.name)) {
			found = true;
			out.push(...operands);
		} else if (p.name === 'git' && (p.args[0] === 'rm' || p.args[0] === 'clean')) {
			found = true;
			out.push(...(p.args[0] === 'rm' ? operands.slice(1) : ['*']));
		} else if (p.name === 'find' && p.args.some((a) => a === '-delete' || a === 'rm')) {
			found = true;
			out.push(operands[0] ?? '.');
		}
	}
	return found ? (out.length ? out : ['*']) : null;
}

/** Every word of a shell command that could be a path (for protected paths). */
const shellPathWords = (command: string) => shellWords(command).flatMap((w) => w.filter((x) => !x.startsWith('-') && /[\w.~]/.test(x)));

// ---------------------------------------------------------------------------------------------
// The check

/** `path` against `cwd`: its resolved form and whether it stays inside. */
export function insideCwd(path: string, cwd: string, realpath: (p: string) => string = (p) => p): { abs: string; rel: string; inside: boolean } {
	const home = /^~(?=$|\/)/.test(path) ? homedir() + path.slice(1) : path;
	const abs = normalize(isAbsolute(home) ? home : resolve(cwd, home));
	const realCwd = realpath(cwd);
	const real = realpath(abs);
	const rel = relative(realCwd, real);
	const inside = rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
	return { abs, rel: rel.split(sep).join('/'), inside };
}

/**
 * Why `tool` with `input` must be asked about in a run in `cwd`, or null. `realpath` resolves the
 * existing part of a path (symlinks out of the folder count as outside); tests pass the identity.
 */
export function askFor(tool: string, input: unknown, cwd: string, config: AskConfig, rules: readonly Rule[], realpath?: (p: string) => string): Ask | null {
	const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
	const command = tool === 'Bash' && typeof o.command === 'string' ? o.command : null;
	const paths = command === null ? toolPaths(tool, input) : [];
	const where = (p: string) => insideCwd(p, cwd, realpath);

	if (rules.length) {
		const words = command === null ? paths : shellPathWords(command);
		const hit = words.filter((p) => {
			if (/^[a-z]+:\/\//i.test(p)) return false;
			const w = where(p);
			return w.inside && w.rel !== '' && isProtected(rules, w.rel);
		});
		if (hit.length) return { check: 'protected', paths: hit };
	}
	if (config.deletes && command !== null) {
		const deleted = deletedPaths(command);
		if (deleted) return { check: 'delete', paths: deleted };
	}
	if (config.outsideCwd && WRITE_TOOLS.has(tool)) {
		const outside = paths.filter((p) => !where(p).inside);
		if (outside.length) return { check: 'outside_cwd', paths: outside };
	}
	if (config.mcpTools && tool.startsWith('mcp__')) return { check: 'mcp', paths: [] };
	return null;
}

/** What the model is told when the user says no. */
export function askDeniedReason(ask: Ask, message?: string | null): string {
	const why: Record<AskCheck, string> = {
		outside_cwd: 'it writes outside the project folder',
		delete: 'it deletes files',
		protected: 'it touches a file the user protected (.kinguignore)',
		mcp: 'it calls an MCP tool'
	};
	const said = message?.trim();
	return `The user did not allow this call (Kingu asks before running it because ${why[ask.check]}).${said ? ` They said: ${said}` : ''} Do not try another way to do the same thing.`;
}
