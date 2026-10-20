// The snippet grammar of VS Code's user snippets (editing/userdefinedsnippets.md, "Grammar"):
// tabstops, placeholders, choices, variables and transforms. Pure, so bun tests cover it.
//
// Monaco's snippet controller inserts the result and runs the tabstops, choices and placeholder
// transforms itself. What Kingu does before that: variables Monaco cannot answer in Kingu (the file
// and folder ones: Monaco's models are keyed by workspace-relative URIs, and it has no workspace)
// are resolved here, with their transforms, and unknown variables become placeholders, like VS
// Code's SnippetBodyInsights.

export type FormatPart = string | { group: number; modifier?: 'upcase' | 'downcase' | 'capitalize' | 'camelcase' | 'pascalcase'; ifValue?: string; elseValue?: string };
export type Transform = { regex: string; format: FormatPart[]; flags: string };
export type SnippetNode =
	| { kind: 'text'; value: string }
	| { kind: 'tabstop'; index: number; transform?: Transform }
	| { kind: 'placeholder'; index: number; children: SnippetNode[] }
	| { kind: 'choice'; index: number; options: string[] }
	| { kind: 'variable'; name: string; children?: SnippetNode[]; transform?: Transform };

/** The variables VS Code knows (snippetVariables.ts KnownSnippetVariableNames). */
export const KNOWN_VARIABLES: ReadonlySet<string> = new Set([
	'CURRENT_YEAR',
	'CURRENT_YEAR_SHORT',
	'CURRENT_MONTH',
	'CURRENT_DATE',
	'CURRENT_HOUR',
	'CURRENT_MINUTE',
	'CURRENT_SECOND',
	'CURRENT_DAY_NAME',
	'CURRENT_DAY_NAME_SHORT',
	'CURRENT_MONTH_NAME',
	'CURRENT_MONTH_NAME_SHORT',
	'CURRENT_SECONDS_UNIX',
	'CURRENT_MILLISECONDS_UNIX',
	'CURRENT_MILLISECOND',
	'CURRENT_TIMEZONE_OFFSET',
	'CURRENT_TIMEZONE_NAME',
	'SELECTION',
	'CLIPBOARD',
	'TM_SELECTED_TEXT',
	'TM_CURRENT_LINE',
	'TM_CURRENT_WORD',
	'TM_LINE_INDEX',
	'TM_LINE_NUMBER',
	'TM_FILENAME',
	'TM_FILENAME_BASE',
	'TM_DIRECTORY',
	'TM_DIRECTORY_BASE',
	'TM_FILEPATH',
	'CURSOR_INDEX',
	'CURSOR_NUMBER',
	'RELATIVE_FILEPATH',
	'BLOCK_COMMENT_START',
	'BLOCK_COMMENT_END',
	'LINE_COMMENT',
	'WORKSPACE_NAME',
	'WORKSPACE_FOLDER',
	'RANDOM',
	'RANDOM_HEX',
	'UUID'
]);

const MODIFIERS = ['upcase', 'downcase', 'capitalize', 'camelcase', 'pascalcase'] as const;

class Parser {
	i = 0;
	constructor(readonly s: string) {}

	peek(n = 0) {
		return this.s[this.i + n];
	}

	/** `[0-9]+` at the cursor, or null (the cursor stays). */
	int(): number | null {
		const m = /^\d+/.exec(this.s.slice(this.i));
		if (!m) return null;
		this.i += m[0].length;
		return Number(m[0]);
	}

	/** `[_a-zA-Z][_a-zA-Z0-9]*` at the cursor, or null. */
	varName(): string | null {
		const m = /^[_a-zA-Z][_a-zA-Z0-9]*/.exec(this.s.slice(this.i));
		if (!m) return null;
		this.i += m[0].length;
		return m[0];
	}

	/** Nodes up to (not including) an unescaped `stop` character, or the end. */
	nodes(stop?: string): SnippetNode[] {
		const out: SnippetNode[] = [];
		let text = '';
		const flush = () => {
			if (text) out.push({ kind: 'text', value: text });
			text = '';
		};
		while (this.i < this.s.length) {
			const c = this.s[this.i];
			if (stop && c === stop) break;
			if (c === '\\' && (this.peek(1) === '$' || this.peek(1) === '}' || this.peek(1) === '\\')) {
				text += this.peek(1);
				this.i += 2;
				continue;
			}
			if (c === '$') {
				const start = this.i;
				const node = this.dollar();
				if (node) {
					flush();
					out.push(node);
					continue;
				}
				// Not a valid construct: the `$` is text.
				this.i = start + 1;
				text += '$';
				continue;
			}
			text += c;
			this.i++;
		}
		flush();
		return out;
	}

	/** A construct starting at `$`, or null (the caller resets the cursor). */
	dollar(): SnippetNode | null {
		this.i++;
		const index = this.int();
		if (index !== null) return { kind: 'tabstop', index };
		const name = this.varName();
		if (name !== null) return { kind: 'variable', name };
		if (this.peek() !== '{') return null;
		this.i++;
		const n = this.int();
		if (n !== null) {
			if (this.peek() === '}') {
				this.i++;
				return { kind: 'tabstop', index: n };
			}
			if (this.peek() === ':') {
				this.i++;
				const children = this.nodes('}');
				if (this.peek() !== '}') return null;
				this.i++;
				return { kind: 'placeholder', index: n, children };
			}
			if (this.peek() === '|') {
				this.i++;
				const options = this.choiceOptions();
				if (!options) return null;
				return { kind: 'choice', index: n, options };
			}
			if (this.peek() === '/') {
				const transform = this.transform();
				if (!transform) return null;
				return { kind: 'tabstop', index: n, transform };
			}
			return null;
		}
		const v = this.varName();
		if (v === null) return null;
		if (this.peek() === '}') {
			this.i++;
			return { kind: 'variable', name: v };
		}
		if (this.peek() === ':') {
			this.i++;
			const children = this.nodes('}');
			if (this.peek() !== '}') return null;
			this.i++;
			return { kind: 'variable', name: v, children };
		}
		if (this.peek() === '/') {
			const transform = this.transform();
			if (!transform) return null;
			return { kind: 'variable', name: v, transform };
		}
		return null;
	}

	/** `a,b,c|}` after `${n|`; escapes `\,` `\|` `\\`. */
	choiceOptions(): string[] | null {
		const options: string[] = [];
		let cur = '';
		while (this.i < this.s.length) {
			const c = this.s[this.i];
			if (c === '\\' && [',', '|', '\\', '$', '}'].includes(this.peek(1) ?? '')) {
				cur += this.peek(1);
				this.i += 2;
			} else if (c === ',') {
				options.push(cur);
				cur = '';
				this.i++;
			} else if (c === '|' && this.peek(1) === '}') {
				options.push(cur);
				this.i += 2;
				return options;
			} else {
				cur += c;
				this.i++;
			}
		}
		return null;
	}

	/** `/regex/format/options}` at a `/`. */
	transform(): Transform | null {
		this.i++;
		let regex = '';
		while (this.i < this.s.length && this.peek() !== '/') {
			if (this.peek() === '\\' && this.peek(1) === '/') {
				regex += '/';
				this.i += 2;
			} else regex += this.s[this.i++];
		}
		if (this.peek() !== '/') return null;
		this.i++;
		const format: FormatPart[] = [];
		let text = '';
		const flush = () => {
			if (text) format.push(text);
			text = '';
		};
		while (this.i < this.s.length && this.peek() !== '/') {
			const c = this.peek();
			if (c === '\\' && ['/', '$', '\\', '}'].includes(this.peek(1) ?? '')) {
				text += this.peek(1);
				this.i += 2;
			} else if (c === '\\' && (this.peek(1) === 'n' || this.peek(1) === 't')) {
				text += this.peek(1) === 'n' ? '\n' : '\t';
				this.i += 2;
			} else if (c === '$') {
				const start = this.i;
				const part = this.formatPart();
				if (part) {
					flush();
					format.push(part);
				} else {
					this.i = start + 1;
					text += '$';
				}
			} else {
				text += c;
				this.i++;
			}
		}
		flush();
		if (this.peek() !== '/') return null;
		this.i++;
		const flags = /^[a-z]*/.exec(this.s.slice(this.i))![0];
		this.i += flags.length;
		if (this.peek() !== '}') return null;
		this.i++;
		return { regex, format, flags };
	}

	/** `$1`, `${1}`, `${1:/upcase}`, `${1:+if}`, `${1:?if:else}`, `${1:-else}`, `${1:else}`. */
	formatPart(): FormatPart | null {
		this.i++;
		const direct = this.int();
		if (direct !== null) return { group: direct };
		if (this.peek() !== '{') return null;
		this.i++;
		const group = this.int();
		if (group === null) return null;
		if (this.peek() === '}') {
			this.i++;
			return { group };
		}
		if (this.peek() !== ':') return null;
		this.i++;
		if (this.peek() === '/') {
			this.i++;
			const name = this.varName();
			if (!name || !(MODIFIERS as readonly string[]).includes(name) || this.peek() !== '}') return null;
			this.i++;
			return { group, modifier: name as (typeof MODIFIERS)[number] };
		}
		const until = (end: string) => {
			let out = '';
			while (this.i < this.s.length && !end.includes(this.peek())) {
				if (this.peek() === '\\' && this.peek(1) !== undefined) {
					out += this.peek(1);
					this.i += 2;
				} else out += this.s[this.i++];
			}
			return out;
		};
		if (this.peek() === '+') {
			this.i++;
			const ifValue = until('}');
			if (this.peek() !== '}') return null;
			this.i++;
			return { group, ifValue };
		}
		if (this.peek() === '?') {
			this.i++;
			const ifValue = until(':}');
			if (this.peek() !== ':') return null;
			this.i++;
			const elseValue = until('}');
			if (this.peek() !== '}') return null;
			this.i++;
			return { group, ifValue, elseValue };
		}
		if (this.peek() === '-') this.i++;
		const elseValue = until('}');
		if (this.peek() !== '}') return null;
		this.i++;
		return { group, elseValue };
	}
}

/** The snippet as a tree. Text that is not a valid construct stays text (`$` alone, `${`). */
export function parseSnippet(source: string): SnippetNode[] {
	return new Parser(source).nodes();
}

const escapeText = (s: string) => s.replace(/[\\$}]/g, (c) => `\\${c}`);
const escapeChoice = (s: string) => s.replace(/[\\,|$}]/g, (c) => `\\${c}`);
const escapeFormatText = (s: string) => s.replace(/[\\/$}]/g, (c) => `\\${c}`).replace(/\n/g, '\\n').replace(/\t/g, '\\t');
const escapeConditional = (s: string) => s.replace(/[\\:}]/g, (c) => `\\${c}`);

function formatPartString(p: FormatPart): string {
	if (typeof p === 'string') return escapeFormatText(p);
	if (p.modifier) return `\${${p.group}:/${p.modifier}}`;
	if (p.ifValue !== undefined && p.elseValue !== undefined) return `\${${p.group}:?${escapeConditional(p.ifValue)}:${escapeConditional(p.elseValue)}}`;
	if (p.ifValue !== undefined) return `\${${p.group}:+${escapeConditional(p.ifValue)}}`;
	if (p.elseValue !== undefined) return `\${${p.group}:-${escapeConditional(p.elseValue)}}`;
	return `\${${p.group}}`;
}

const transformString = (t: Transform) => `/${t.regex.replace(/\//g, '\\/')}/${t.format.map(formatPartString).join('')}/${t.flags}`;

/** The tree back in snippet syntax (what Monaco's snippet controller reads). */
export function serializeSnippet(nodes: readonly SnippetNode[]): string {
	return nodes
		.map((n) => {
			switch (n.kind) {
				case 'text':
					return escapeText(n.value);
				case 'tabstop':
					return n.transform ? `\${${n.index}${transformString(n.transform)}}` : `\$${n.index}`;
				case 'placeholder':
					return `\${${n.index}:${serializeSnippet(n.children)}}`;
				case 'choice':
					return `\${${n.index}|${n.options.map(escapeChoice).join(',')}|}`;
				case 'variable':
					if (n.transform) return `\${${n.name}${transformString(n.transform)}}`;
					if (n.children) return `\${${n.name}:${serializeSnippet(n.children)}}`;
					return `\${${n.name}}`;
			}
		})
		.join('');
}

/** What the snippet inserts with every placeholder at its default and variables empty (the
 * suggestion's preview, VS Code's SnippetParser.asInsertText). */
export function snippetText(nodes: readonly SnippetNode[]): string {
	return nodes
		.map((n) => {
			switch (n.kind) {
				case 'text':
					return n.value;
				case 'placeholder':
					return snippetText(n.children);
				case 'choice':
					return n.options[0] ?? '';
				case 'variable':
					return n.children ? snippetText(n.children) : '';
				default:
					return '';
			}
		})
		.join('');
}

function walk(nodes: readonly SnippetNode[], visit: (n: SnippetNode) => void) {
	for (const n of nodes) {
		visit(n);
		if (n.kind === 'placeholder') walk(n.children, visit);
		if (n.kind === 'variable' && n.children) walk(n.children, visit);
	}
}

/** Names of the variables the snippet uses. */
export function variablesOf(nodes: readonly SnippetNode[]): Set<string> {
	const out = new Set<string>();
	walk(nodes, (n) => n.kind === 'variable' && out.add(n.name));
	return out;
}

const maxIndex = (nodes: readonly SnippetNode[]) => {
	let max = 0;
	walk(nodes, (n) => {
		if (n.kind === 'tabstop' || n.kind === 'placeholder' || n.kind === 'choice') max = Math.max(max, n.index);
	});
	return max;
};

/** `${foo}` (unknown, no default) becomes `${N:foo}`, one index per name (VS Code SnippetBodyInsights). */
export function rewriteUnknownVariables(nodes: SnippetNode[]): { nodes: SnippetNode[]; changed: boolean } {
	let next = maxIndex(nodes);
	const indexOf = new Map<string, number>();
	let changed = false;
	const rewrite = (list: SnippetNode[]): SnippetNode[] =>
		list.map((n) => {
			if (n.kind === 'variable' && !n.children && !n.transform && !KNOWN_VARIABLES.has(n.name)) {
				changed = true;
				if (!indexOf.has(n.name)) indexOf.set(n.name, ++next);
				return { kind: 'placeholder', index: indexOf.get(n.name)!, children: [{ kind: 'text', value: n.name }] };
			}
			if (n.kind === 'placeholder') return { ...n, children: rewrite(n.children) };
			if (n.kind === 'variable' && n.children) return { ...n, children: rewrite(n.children) };
			return n;
		});
	const out = rewrite(nodes);
	return { nodes: out, changed };
}

function caseChange(value: string, modifier: NonNullable<Exclude<FormatPart, string>['modifier']>): string {
	switch (modifier) {
		case 'upcase':
			return value.toLocaleUpperCase();
		case 'downcase':
			return value.toLocaleLowerCase();
		case 'capitalize':
			return value ? value[0].toLocaleUpperCase() + value.slice(1) : value;
		case 'camelcase':
		case 'pascalcase': {
			const words = value.match(/[a-zA-Z0-9]+/g) ?? [];
			const out = words.map((w, i) => (i === 0 && modifier === 'camelcase' ? w[0].toLocaleLowerCase() : w[0].toLocaleUpperCase()) + w.slice(1)).join('');
			return out;
		}
	}
}

/** The format string for one regex match (VS Code FormatString.resolve). */
function formatMatch(format: readonly FormatPart[], groups: readonly (string | undefined)[]): string {
	return format
		.map((p) => {
			if (typeof p === 'string') return p;
			const value = groups[p.group] ?? '';
			if (p.modifier) return caseChange(value, p.modifier);
			if (p.ifValue !== undefined && p.elseValue !== undefined) return value ? p.ifValue : p.elseValue;
			if (p.ifValue !== undefined) return value ? p.ifValue : '';
			if (p.elseValue !== undefined) return value || p.elseValue;
			return value;
		})
		.join('');
}

/** Applies a transform to a value; an invalid regex leaves the value as it is. */
export function applyTransform(value: string, t: Transform): string {
	let re: RegExp;
	try {
		re = new RegExp(t.regex, t.flags.replace(/[^gimsuy]/g, ''));
	} catch {
		return value;
	}
	let matched = false;
	const out = value.replace(re, (...args: unknown[]) => {
		matched = true;
		// (match, ...groups, offset, input[, named groups])
		const end = args.length - (typeof args[args.length - 1] === 'object' ? 3 : 2);
		return formatMatch(t.format, args.slice(0, end) as (string | undefined)[]);
	});
	// No match: a format with an else branch still applies, to empty groups (VS Code Transform.resolve).
	if (!matched && t.format.some((p) => typeof p !== 'string' && p.elseValue !== undefined)) return formatMatch(t.format, []);
	return out;
}

/**
 * Replaces the variables `resolve` knows (it returns undefined for the others, which stay for
 * Monaco: selection, clipboard, time, comments, random) with their value, transformed. A known
 * variable whose value is empty takes its default (`${TM_SELECTED_TEXT:default}`).
 */
export function resolveVariables(nodes: readonly SnippetNode[], resolve: (name: string) => string | undefined): SnippetNode[] {
	return nodes.flatMap((n): SnippetNode[] => {
		if (n.kind === 'placeholder') return [{ ...n, children: resolveVariables(n.children, resolve) }];
		if (n.kind !== 'variable') return [n];
		const value = resolve(n.name);
		if (value === undefined) return [n.children ? { ...n, children: resolveVariables(n.children, resolve) } : n];
		if (n.transform) return [{ kind: 'text', value: applyTransform(value, n.transform) }];
		if (!value && n.children) return resolveVariables(n.children, resolve);
		return [{ kind: 'text', value }];
	});
}

export type FileVariables = {
	/** The file's absolute path ('' for an untitled editor). */
	path: string;
	/** Its path relative to the workspace folder. */
	relativePath: string;
	/** The workspace folder's absolute path, or null without one. */
	workspaceFolder: string | null;
	/** An untitled editor's name (Untitled-1). */
	untitledName?: string;
};

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) || '/' : '');

/** The file and workspace variables (VS Code ModelBasedVariableResolver / WorkspaceBasedVariableResolver). */
export function fileVariableResolver(file: FileVariables): (name: string) => string | undefined {
	return (name) => {
		const name_ = file.path ? baseName(file.path) : (file.untitledName ?? '');
		switch (name) {
			case 'TM_FILENAME':
				return name_;
			case 'TM_FILENAME_BASE': {
				const dot = name_.lastIndexOf('.');
				return dot <= 0 ? name_ : name_.slice(0, dot);
			}
			case 'TM_DIRECTORY':
				return file.path ? dirName(file.path) : '';
			case 'TM_DIRECTORY_BASE':
				return file.path ? baseName(dirName(file.path)) : '';
			case 'TM_FILEPATH':
				return file.path || name_;
			case 'RELATIVE_FILEPATH':
				return file.relativePath || name_;
			case 'WORKSPACE_NAME':
				return file.workspaceFolder ? baseName(file.workspaceFolder) : undefined;
			case 'WORKSPACE_FOLDER':
				return file.workspaceFolder ?? undefined;
			default:
				return undefined;
		}
	};
}

/** What Kingu hands Monaco's snippet controller for a snippet body: unknown variables as
 * placeholders, the file and folder variables resolved. */
export function prepareSnippet(body: string, file: FileVariables): string {
	const { nodes } = rewriteUnknownVariables(parseSnippet(body));
	return serializeSnippet(resolveVariables(nodes, fileVariableResolver(file)));
}

/** The snippet uses the selection (TM_SELECTED_TEXT or SELECTION), so Surround With offers it. */
export const usesSelection = (body: string) => {
	const vars = variablesOf(parseSnippet(body));
	return vars.has('TM_SELECTED_TEXT') || vars.has('SELECTION');
};
