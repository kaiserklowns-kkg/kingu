// Problem matchers (VS Code: src/vs/workbench/contrib/tasks/common/problemMatcher.ts): the problem
// patterns and matchers VS Code ships in core, the ones its built-in extensions contribute
// ($tsc / $tsc-watch from typescript-language-features, $gcc from cpptools, $rustc / $rust-panic /
// $rustc-watch from rust-analyzer), the parser for matchers written in tasks.json (named, inline,
// `base`, multi-line `pattern` arrays with `loop`, `background` begins/ends patterns,
// `fileLocation`, `owner`, `severity`, `applyTo`) and the line matchers that turn task output
// into markers. Pure: resources are resolved through an injected file check.

export type FileLocationKind = 'relative' | 'absolute' | 'autoDetect' | 'search';
export type ApplyTo = 'allDocuments' | 'openDocuments' | 'closedDocuments';
export type Severity = 'error' | 'warning' | 'info';
export type SearchArgs = { include?: string | string[]; exclude?: string | string[] };

export type ProblemPattern = {
	regexp: RegExp;
	kind?: 'file' | 'location';
	file?: number;
	message?: number;
	location?: number;
	line?: number;
	character?: number;
	endLine?: number;
	endCharacter?: number;
	code?: number;
	severity?: number;
	loop?: boolean;
};

export type WatchingPattern = { regexp: RegExp; file?: number };
export type WatchingMatcher = { activeOnStart: boolean; beginsPattern: WatchingPattern; endsPattern: WatchingPattern };

export type ProblemMatcher = {
	owner: string;
	source?: string;
	applyTo: ApplyTo;
	fileLocation: FileLocationKind;
	filePrefix?: string | SearchArgs;
	pattern: ProblemPattern | ProblemPattern[];
	severity?: Severity;
	watching?: WatchingMatcher;
	/** Set on the registry's named matchers. */
	name?: string;
	label?: string;
	deprecated?: boolean;
};

/** A problem found in task output: 1-based lines and columns like Monaco markers, `endColumn` exclusive. */
export type Marker = {
	severity: Severity;
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
	message: string;
	code?: string;
	source?: string;
};

export type ProblemMatch = { resource: Promise<string>; marker: Marker; description: ProblemMatcher };

/** Answers whether a file exists (fileLocation autoDetect) and finds one by name (search). */
export type FileHost = {
	exists?(path: string): Promise<boolean>;
	search?(filename: string, args: SearchArgs): Promise<string | null>;
};

// --- Resources -----------------------------------------------------------------------------------

/** POSIX normalize: `.` and `..` segments resolved, duplicate slashes removed. */
export function normalizePath(path: string): string {
	const absolute = path.startsWith('/');
	const out: string[] = [];
	for (const seg of path.split('/')) {
		if (!seg || seg === '.') continue;
		if (seg === '..') {
			if (out.length && out[out.length - 1] !== '..') out.pop();
			else if (!absolute) out.push('..');
		} else out.push(seg);
	}
	return (absolute ? '/' : '') + out.join('/');
}

const joinPath = (a: string, b: string) => (b.startsWith('/') ? `${a}/${b}` : `${a}/${b}`);

/** VS Code's getResource: the absolute path a matched file name stands for. */
export async function getResource(filename: string, matcher: ProblemMatcher, host: FileHost = {}): Promise<string> {
	const kind = matcher.fileLocation;
	let full: string | undefined;
	if (kind === 'absolute') full = filename;
	else if (kind === 'relative' && typeof matcher.filePrefix === 'string') full = joinPath(matcher.filePrefix, filename);
	else if (kind === 'autoDetect') {
		const relative = await getResource(filename, { ...matcher, fileLocation: 'relative' }, host);
		if (host.exists && (await host.exists(relative).catch(() => false))) return relative;
		return getResource(filename, { ...matcher, fileLocation: 'absolute' }, host);
	} else if (kind === 'search') {
		const prefix = typeof matcher.filePrefix === 'object' ? matcher.filePrefix : {};
		full = (await host.search?.(filename, prefix).catch(() => null)) ?? undefined;
		if (!full) return getResource(filename, { ...matcher, fileLocation: 'absolute' }, host);
	}
	if (full === undefined) full = filename;
	full = normalizePath(full.replace(/\\/g, '/'));
	return full.startsWith('/') ? full : '/' + full;
}

// --- Line matchers -------------------------------------------------------------------------------

type ProblemData = {
	kind?: 'file' | 'location';
	file?: string;
	location?: string;
	line?: string;
	character?: string;
	endLine?: string;
	endCharacter?: string;
	message?: string;
	severity?: string;
	code?: string;
};

type HandleResult = { match: ProblemMatch | null; continue: boolean };

/** VS Code's Severity.fromValue plus the matcher's E/W/I/hint/note fallbacks. */
export function severityOf(value: string | undefined, fallback: Severity | undefined): Severity {
	const v = value?.toLowerCase();
	if (v === 'error') return 'error';
	if (v === 'warning' || v === 'warn') return 'warning';
	if (v === 'info') return 'info';
	if (value === 'E') return 'error';
	if (value === 'W') return 'warning';
	if (value === 'I' || v === 'hint' || v === 'note') return 'info';
	return fallback ?? 'error';
}

const MAX_COLUMN = 2 ** 31 - 1;

abstract class LineMatcher {
	constructor(
		protected matcher: ProblemMatcher,
		protected host: FileHost
	) {}

	abstract get matchLength(): number;
	abstract handle(lines: string[], start?: number): HandleResult;
	next(_line: string): ProblemMatch | null {
		return null;
	}

	protected fill(data: ProblemData, pattern: ProblemPattern, matches: RegExpExecArray) {
		this.fillProperty(data, 'file', pattern, matches, true);
		this.appendProperty(data, 'message', pattern, matches, true);
		this.fillProperty(data, 'code', pattern, matches, true);
		this.fillProperty(data, 'severity', pattern, matches, true);
		this.fillProperty(data, 'location', pattern, matches, true);
		this.fillProperty(data, 'line', pattern, matches);
		this.fillProperty(data, 'character', pattern, matches);
		this.fillProperty(data, 'endLine', pattern, matches);
		this.fillProperty(data, 'endCharacter', pattern, matches);
	}

	private appendProperty(data: ProblemData, prop: keyof ProblemData & keyof ProblemPattern, pattern: ProblemPattern, matches: RegExpExecArray, trim: boolean) {
		const index = pattern[prop] as number | undefined;
		if (data[prop] === undefined) this.fillProperty(data, prop, pattern, matches, trim);
		else if (index !== undefined && index < matches.length) {
			let value = matches[index] ?? '';
			if (trim) value = value.trim();
			(data as Record<string, string>)[prop] = `${data[prop]}\n${value}`;
		}
	}

	private fillProperty(data: ProblemData, prop: keyof ProblemData & keyof ProblemPattern, pattern: ProblemPattern, matches: RegExpExecArray, trim = false) {
		const index = pattern[prop] as number | undefined;
		if (data[prop] !== undefined || index === undefined || index >= matches.length) return;
		let value = matches[index];
		if (value === undefined) return;
		if (trim) value = value.trim();
		(data as Record<string, string>)[prop] = value;
	}

	protected markerMatch(data: ProblemData): ProblemMatch | null {
		const location = this.location(data);
		if (!data.file || !location || !data.message) return null;
		const marker: Marker = { severity: severityOf(data.severity, this.matcher.severity), ...location, message: data.message };
		if (data.code !== undefined) marker.code = data.code;
		if (this.matcher.source !== undefined) marker.source = this.matcher.source;
		const resource = getResource(data.file, this.matcher, this.host);
		resource.catch(() => {});
		return { description: this.matcher, resource, marker };
	}

	private location(data: ProblemData): Pick<Marker, 'startLineNumber' | 'startColumn' | 'endLineNumber' | 'endColumn'> | null {
		if (data.kind === 'file') return create(0, 0, 0, 0);
		if (data.location) return parseLocation(data.location);
		if (!data.line) return null;
		const num = (s: string | undefined) => (s ? parseInt(s) : undefined);
		return create(parseInt(data.line), num(data.character), num(data.endLine), num(data.endCharacter));
	}
}

function create(startLine: number, startColumn: number | undefined, endLine: number | undefined, endColumn: number | undefined) {
	if (startColumn !== undefined && endColumn !== undefined) return { startLineNumber: startLine, startColumn, endLineNumber: endLine || startLine, endColumn };
	if (startColumn !== undefined) return { startLineNumber: startLine, startColumn, endLineNumber: startLine, endColumn: startColumn };
	return { startLineNumber: startLine, startColumn: 1, endLineNumber: startLine, endColumn: MAX_COLUMN };
}

function parseLocation(value: string) {
	if (!/(\d+|\d+,\d+|\d+,\d+,\d+,\d+)/.test(value)) return null;
	const parts = value.split(',');
	const startLine = parseInt(parts[0]);
	const startColumn = parts.length > 1 ? parseInt(parts[1]) : undefined;
	return parts.length > 3 ? create(startLine, startColumn, parseInt(parts[2]), parseInt(parts[3])) : create(startLine, startColumn, undefined, undefined);
}

class SingleLineMatcher extends LineMatcher {
	get matchLength() {
		return 1;
	}

	handle(lines: string[], start = 0): HandleResult {
		const pattern = this.matcher.pattern as ProblemPattern;
		const data: ProblemData = {};
		if (pattern.kind !== undefined) data.kind = pattern.kind;
		const matches = pattern.regexp.exec(lines[start]);
		if (matches) {
			this.fill(data, pattern, matches);
			if (data.kind === 'location' && !data.location && !data.line && data.file) data.kind = 'file';
			const match = this.markerMatch(data);
			if (match) return { match, continue: false };
		}
		return { match: null, continue: false };
	}
}

class MultiLineMatcher extends LineMatcher {
	private data: ProblemData | undefined;

	private get patterns() {
		return this.matcher.pattern as ProblemPattern[];
	}

	get matchLength() {
		return this.patterns.length;
	}

	handle(lines: string[], start = 0): HandleResult {
		const patterns = this.patterns;
		this.data = { kind: patterns[0].kind };
		let data = this.data;
		for (let i = 0; i < patterns.length; i++) {
			const matches = patterns[i].regexp.exec(lines[i + start]);
			if (!matches) return { match: null, continue: false };
			// Only the last pattern can loop: the earlier lines' data is kept for every looped line.
			if (patterns[i].loop && i === patterns.length - 1) data = { ...data };
			this.fill(data, patterns[i], matches);
		}
		const loop = !!patterns[patterns.length - 1].loop;
		if (!loop) this.data = undefined;
		return { match: this.markerMatch(data), continue: loop };
	}

	next(line: string): ProblemMatch | null {
		const pattern = this.patterns[this.patterns.length - 1];
		const matches = pattern.regexp.exec(line);
		if (!matches || !this.data) {
			this.data = undefined;
			return null;
		}
		const data = { ...this.data };
		this.fill(data, pattern, matches);
		return this.markerMatch(data);
	}
}

export type LineMatcherApi = { matchLength: number; handle(lines: string[], start?: number): HandleResult; next(line: string): ProblemMatch | null };

export function createLineMatcher(matcher: ProblemMatcher, host: FileHost = {}): LineMatcherApi {
	return Array.isArray(matcher.pattern) ? new MultiLineMatcher(matcher, host) : new SingleLineMatcher(matcher, host);
}

// --- Registries (VS Code core + built-in extensions) ---------------------------------------------

const PATTERNS: Record<string, ProblemPattern | ProblemPattern[]> = {
	msCompile: {
		regexp: /^\s*(?:\s*\d+>)?(\S.*?)(?:\((\d+|\d+,\d+|\d+,\d+,\d+,\d+)\))?\s*:\s+(?:(\S+)\s+)?((?:fatal +)?error|warning|info)\s+(\w+\d+)?\s*:\s*(.*)$/,
		kind: 'location',
		file: 1,
		location: 2,
		severity: 4,
		code: 5,
		message: 6
	},
	'gulp-tsc': { regexp: /^([^\s].*)\((\d+|\d+,\d+|\d+,\d+,\d+,\d+)\):\s+(\d+)\s+(.*)$/, kind: 'location', file: 1, location: 2, code: 3, message: 4 },
	cpp: { regexp: /^(\S.*)\((\d+|\d+,\d+|\d+,\d+,\d+,\d+)\):\s+(error|warning|info)\s+(C\d+)\s*:\s*(.*)$/, kind: 'location', file: 1, location: 2, severity: 3, code: 4, message: 5 },
	csc: { regexp: /^(\S.*)\((\d+|\d+,\d+|\d+,\d+,\d+,\d+)\):\s+(error|warning|info)\s+(CS\d+)\s*:\s*(.*)$/, kind: 'location', file: 1, location: 2, severity: 3, code: 4, message: 5 },
	vb: { regexp: /^(\S.*)\((\d+|\d+,\d+|\d+,\d+,\d+,\d+)\):\s+(error|warning|info)\s+(BC\d+)\s*:\s*(.*)$/, kind: 'location', file: 1, location: 2, severity: 3, code: 4, message: 5 },
	lessCompile: { regexp: /^\s*(.*) in file (.*) line no. (\d+)$/, kind: 'location', message: 1, file: 2, line: 3 },
	jshint: { regexp: /^(.*):\s+line\s+(\d+),\s+col\s+(\d+),\s(.+?)(?:\s+\((\w)(\d+)\))?$/, kind: 'location', file: 1, line: 2, character: 3, message: 4, severity: 5, code: 6 },
	'jshint-stylish': [
		{ regexp: /^(.+)$/, kind: 'location', file: 1 },
		{ regexp: /^\s+line\s+(\d+)\s+col\s+(\d+)\s+(.+?)(?:\s+\((\w)(\d+)\))?$/, line: 1, character: 2, message: 3, severity: 4, code: 5, loop: true }
	],
	'eslint-compact': { regexp: /^(.+):\sline\s(\d+),\scol\s(\d+),\s(Error|Warning|Info)\s-\s(.+)\s\((.+)\)$/, file: 1, kind: 'location', line: 2, character: 3, severity: 4, message: 5, code: 6 },
	'eslint-stylish': [
		{ regexp: /^((?:[a-zA-Z]:)*[./\\]+.*?)$/, kind: 'location', file: 1 },
		{ regexp: /^\s+(\d+):(\d+)\s+(error|warning|info)\s+(.+?)(?:\s\s+(.*))?$/, line: 1, character: 2, severity: 3, message: 4, code: 5, loop: true }
	],
	go: { regexp: /^([^:]*: )?((.:)?[^:]*):(\d+)(:(\d+))?: (.*)$/, kind: 'location', file: 2, line: 4, character: 6, message: 7 },
	// typescript-language-features contributes.problemPatterns.
	tsc: { regexp: /^([^\s].*)[(:](\d+)[,:](\d+)(?:\):\s+|\s+-\s+)(error|warning|info)\s+TS(\d+)\s*:\s*(.*)$/, kind: 'location', file: 1, line: 2, character: 3, severity: 4, code: 5, message: 6 },
	// rust-analyzer contributes.problemPatterns (cargo / rustc's human output).
	rustc: [
		{ regexp: /^(warning|warn|error)(?:\[(.*?)\])?: (.*)$/, kind: 'location', severity: 1, code: 2, message: 3 },
		{ regexp: /^[\s->=]*(.*?):(\d*):(\d*)\s*$/, file: 1, line: 2, character: 3 }
	],
	'rustc-json': {
		regexp: /^.*"message":{"message":"([^"]*).*?"file_name":"([^"]+).*?"line_start":(\d+).*?"line_end":(\d+).*?"column_start":(\d+).*?"column_end":(\d+).*}$/,
		kind: 'location',
		message: 1,
		file: 2,
		line: 3,
		endLine: 4,
		character: 5,
		endCharacter: 6
	},
	'rust-panic': [
		{ regexp: /^thread '.*' panicked at (.*):(\d*):(\d*):$/, kind: 'location', file: 1, line: 2, character: 3 },
		{ regexp: /(.*)/, message: 1 }
	]
};

const TSC_BEGINS = /^\s*(?:message TS6032:|\[?\D*.{1,2}[:.].{1,2}[:.].{1,2}\D*(├\D*\d{1,2}\D+┤)?(?:\]| -)) (Starting compilation in watch mode|File change detected\. Starting incremental compilation)\.\.\./;
const TSC_ENDS = /^\s*(?:message TS6042:|\[?\D*.{1,2}[:.].{1,2}[:.].{1,2}\D*(├\D*\d{1,2}\D+┤)?(?:\]| -)) (?:Compilation complete\.|Found \d+ errors?\.) Watching for file changes\./;

const MATCHERS: Record<string, ProblemMatcher> = {
	msCompile: { name: 'msCompile', label: 'Microsoft compiler problems', owner: 'msCompile', source: 'cpp', applyTo: 'allDocuments', fileLocation: 'absolute', pattern: PATTERNS.msCompile },
	lessCompile: { name: 'lessCompile', label: 'Less problems', deprecated: true, owner: 'lessCompile', source: 'less', applyTo: 'allDocuments', fileLocation: 'absolute', pattern: PATTERNS.lessCompile, severity: 'error' },
	'gulp-tsc': { name: 'gulp-tsc', label: 'Gulp TSC Problems', owner: 'typescript', source: 'ts', applyTo: 'closedDocuments', fileLocation: 'relative', filePrefix: '${workspaceFolder}', pattern: PATTERNS['gulp-tsc'] },
	jshint: { name: 'jshint', label: 'JSHint problems', owner: 'jshint', source: 'jshint', applyTo: 'allDocuments', fileLocation: 'absolute', pattern: PATTERNS.jshint },
	'jshint-stylish': { name: 'jshint-stylish', label: 'JSHint stylish problems', owner: 'jshint', source: 'jshint', applyTo: 'allDocuments', fileLocation: 'absolute', pattern: PATTERNS['jshint-stylish'] },
	'eslint-compact': { name: 'eslint-compact', label: 'ESLint compact problems', owner: 'eslint', source: 'eslint', applyTo: 'allDocuments', fileLocation: 'absolute', filePrefix: '${workspaceFolder}', pattern: PATTERNS['eslint-compact'] },
	'eslint-stylish': { name: 'eslint-stylish', label: 'ESLint stylish problems', owner: 'eslint', source: 'eslint', applyTo: 'allDocuments', fileLocation: 'absolute', pattern: PATTERNS['eslint-stylish'] },
	go: { name: 'go', label: 'Go problems', owner: 'go', source: 'go', applyTo: 'allDocuments', fileLocation: 'relative', filePrefix: '${workspaceFolder}', pattern: PATTERNS.go },
	// typescript-language-features contributes.problemMatchers.
	tsc: { name: 'tsc', label: 'TypeScript problems', owner: 'typescript', source: 'ts', applyTo: 'closedDocuments', fileLocation: 'relative', filePrefix: '${cwd}', pattern: PATTERNS.tsc },
	'tsc-watch': {
		name: 'tsc-watch',
		label: 'TypeScript problems (watch mode)',
		owner: 'typescript',
		source: 'ts',
		applyTo: 'closedDocuments',
		fileLocation: 'relative',
		filePrefix: '${cwd}',
		pattern: PATTERNS.tsc,
		watching: { activeOnStart: true, beginsPattern: { regexp: TSC_BEGINS, file: 1 }, endsPattern: { regexp: TSC_ENDS, file: 1 } }
	},
	'tsgo-watch': {
		name: 'tsgo-watch',
		label: 'TypeScript problems (tsgo watch mode)',
		owner: 'typescript',
		source: 'ts',
		applyTo: 'closedDocuments',
		fileLocation: 'relative',
		filePrefix: '${cwd}',
		pattern: PATTERNS.tsc,
		watching: { activeOnStart: true, beginsPattern: { regexp: /^build starting at .*$/, file: 1 }, endsPattern: { regexp: /^build finished in .*$/, file: 1 } }
	},
	// ms-vscode.cpptools contributes.problemMatchers.
	gcc: {
		name: 'gcc',
		label: 'GCC problems',
		owner: 'cpptools',
		source: 'gcc',
		applyTo: 'allDocuments',
		fileLocation: 'autoDetect',
		filePrefix: '${cwd}',
		pattern: { regexp: /^(.*?):(\d+):(\d*):?\s+(?:fatal\s+)?(warning|error):\s+(.*)$/, kind: 'location', file: 1, line: 2, character: 3, severity: 4, message: 5 }
	},
	// rust-analyzer contributes.problemMatchers.
	rustc: { name: 'rustc', label: 'Rust problems', owner: 'rustc', source: 'rustc', applyTo: 'allDocuments', fileLocation: 'autoDetect', filePrefix: '${workspaceFolder}', pattern: PATTERNS.rustc },
	'rustc-json': { name: 'rustc-json', label: 'Rust problems (JSON)', owner: 'rustc', source: 'rustc', applyTo: 'allDocuments', fileLocation: 'autoDetect', filePrefix: '${workspaceFolder}', pattern: PATTERNS['rustc-json'] },
	'rust-panic': { name: 'rust-panic', label: 'Rust panics', owner: 'rustc', source: 'rustc', applyTo: 'allDocuments', fileLocation: 'autoDetect', filePrefix: '${workspaceFolder}', pattern: PATTERNS['rust-panic'] },
	'rustc-watch': {
		name: 'rustc-watch',
		label: 'Rust problems (watch mode)',
		owner: 'rustc',
		source: 'rustc',
		applyTo: 'allDocuments',
		fileLocation: 'autoDetect',
		filePrefix: '${workspaceFolder}',
		pattern: PATTERNS.rustc,
		watching: { activeOnStart: false, beginsPattern: { regexp: /^\[Running\b/, file: 1 }, endsPattern: { regexp: /^\[Finished running\b/, file: 1 } }
	}
};

/** The built-in named matchers (`$tsc` is `namedMatcher('tsc')`). */
export function namedMatcher(name: string): ProblemMatcher | undefined {
	return Object.hasOwn(MATCHERS, name) ? MATCHERS[name] : undefined;
}

export function namedPattern(name: string): ProblemPattern | ProblemPattern[] | undefined {
	return Object.hasOwn(PATTERNS, name) ? PATTERNS[name] : undefined;
}

export function matcherNames(): string[] {
	return Object.keys(MATCHERS);
}

// --- Parsing tasks.json matchers -----------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';

function regex(value: unknown, errors: string[]): RegExp | null {
	if (!isString(value) || !value) return null;
	try {
		return new RegExp(value);
	} catch {
		errors.push(`Error: The string ${value} is not a valid regular expression.`);
		return null;
	}
}

function singlePattern(value: Record<string, unknown>, setDefaults: boolean, errors: string[]): ProblemPattern | undefined {
	const regexp = regex(value.regexp, errors);
	if (!regexp) return undefined;
	let result: ProblemPattern = { regexp };
	if (isString(value.kind)) {
		const kind = value.kind.toLowerCase();
		if (kind === 'file' || kind === 'location') result.kind = kind;
	}
	const copy = (to: keyof ProblemPattern, from: string) => {
		if (typeof value[from] === 'number') (result as Record<string, unknown>)[to] = value[from];
	};
	copy('file', 'file');
	copy('location', 'location');
	copy('line', 'line');
	copy('character', 'column');
	copy('endLine', 'endLine');
	copy('endCharacter', 'endColumn');
	copy('severity', 'severity');
	copy('code', 'code');
	copy('message', 'message');
	if (typeof value.loop === 'boolean') result.loop = value.loop;
	if (setDefaults) {
		const defaults: Partial<ProblemPattern> = result.location || result.kind === 'file' ? { file: 1, message: 0 } : { file: 1, line: 2, character: 3, message: 0 };
		result = { ...defaults, ...result };
	}
	return result;
}

function validPattern(values: ProblemPattern[], errors: string[]): boolean {
	let file = false, message = false, location = false, line = false;
	const kind = values[0].kind ?? 'location';
	values.forEach((p, i) => {
		if (i !== 0 && p.kind) errors.push('The problem pattern is invalid. The kind property must be provided only in the first element');
		file ||= p.file !== undefined;
		message ||= p.message !== undefined;
		location ||= p.location !== undefined;
		line ||= p.line !== undefined;
	});
	if (!(file && message)) {
		errors.push('The problem pattern is invalid. It must have at least have a file and a message.');
		return false;
	}
	if (kind === 'location' && !(location || line)) {
		errors.push('The problem pattern is invalid. It must either have kind: "file" or have a line or location match group.');
		return false;
	}
	return true;
}

/** A `pattern` value: `"$name"`, one inline pattern, or an array of them (multi-line). */
export function parsePattern(value: unknown, errors: string[]): ProblemPattern | ProblemPattern[] | null {
	if (isString(value)) {
		if (value.length > 1 && value[0] === '$') {
			const p = namedPattern(value.slice(1));
			if (!p) errors.push(`Error: the pattern with the identifier ${value} doesn't exist.`);
			return p ?? null;
		}
		errors.push(value.length ? `Error: the pattern property ${value} is not a valid pattern variable name.` : 'Error: the pattern property refers to an empty identifier.');
		return null;
	}
	if (Array.isArray(value)) {
		const out: ProblemPattern[] = [];
		for (let i = 0; i < value.length; i++) {
			const item = value[i];
			const p = isObject(item) ? singlePattern(item, false, errors) : undefined;
			if (!p) {
				if (isObject(item) && !isString(item.regexp)) errors.push('The problem pattern is missing a regular expression.');
				return null;
			}
			if (i < value.length - 1 && p.loop) {
				p.loop = false;
				errors.push('The loop property is only supported on the last line matcher.');
			}
			out.push(p);
		}
		if (!out.length) {
			errors.push('The problem pattern is invalid. It must contain at least one pattern.');
			return null;
		}
		out[0].kind ??= 'location';
		return validPattern(out, errors) ? out : null;
	}
	if (isObject(value)) {
		if (!isString(value.regexp)) {
			errors.push('The problem pattern is missing a regular expression.');
			return null;
		}
		const p = singlePattern(value, true, errors);
		if (!p) return null;
		p.kind ??= 'location';
		return validPattern([p], errors) ? p : null;
	}
	return null;
}

function fileLocationOf(value: unknown): { kind?: FileLocationKind; prefix?: string | SearchArgs } {
	const kindOf = (s: unknown): FileLocationKind | undefined => {
		if (!isString(s)) return undefined;
		const v = s.toLowerCase();
		return v === 'absolute' ? 'absolute' : v === 'relative' ? 'relative' : v === 'autodetect' ? 'autoDetect' : v === 'search' ? 'search' : undefined;
	};
	if (value === undefined) return { kind: 'relative', prefix: '${workspaceFolder}' };
	if (isString(value)) {
		const kind = kindOf(value);
		if (kind === 'relative' || kind === 'autoDetect') return { kind, prefix: '${workspaceFolder}' };
		if (kind === 'search') return { kind, prefix: { include: ['${workspaceFolder}'] } };
		return { kind };
	}
	if (Array.isArray(value) && value.length) {
		const kind = kindOf(value[0]);
		if (kind === 'search') return { kind, prefix: isObject(value[1]) ? (value[1] as SearchArgs) : { include: ['${workspaceFolder}'] } };
		if (value.every(isString)) {
			if (value.length === 1 && kind === 'absolute') return { kind };
			if (value.length === 2 && (kind === 'relative' || kind === 'autoDetect') && value[1]) return { kind, prefix: value[1] };
		}
	}
	return {};
}

function watchingPattern(value: unknown, errors: string[]): WatchingPattern | null {
	if (value === undefined || value === null) return null;
	const regexp = regex(isString(value) ? value : isObject(value) ? value.regexp : undefined, errors);
	if (!regexp) return null;
	const file = isObject(value) && typeof value.file === 'number' ? value.file : 1;
	return { regexp, file };
}

/** A stable owner for a matcher that names none (VS Code makes a UUID per parse; a stable one lets
 * the next run of the same task clear its markers). */
function ownerFor(description: unknown): string {
	const text = JSON.stringify(description) ?? '';
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return `external-${(h >>> 0).toString(16)}`;
}

/** VS Code's ProblemMatcherParser: an inline tasks.json matcher (with an optional `base`). */
export function parseMatcherObject(description: Record<string, unknown>, errors: string[]): ProblemMatcher | undefined {
	const owner = isString(description.owner) ? description.owner : ownerFor(description);
	const source = isString(description.source) ? description.source : undefined;
	const applyToRaw = isString(description.applyTo) ? description.applyTo.toLowerCase() : 'alldocuments';
	const applyTo: ApplyTo = applyToRaw === 'opendocuments' ? 'openDocuments' : applyToRaw === 'closeddocuments' ? 'closedDocuments' : 'allDocuments';
	const { kind: fileLocation, prefix: filePrefix } = fileLocationOf(description.fileLocation);
	const pattern = description.pattern !== undefined ? parsePattern(description.pattern, errors) : null;
	let severity: Severity | undefined;
	if (isString(description.severity)) {
		const v = description.severity.toLowerCase();
		severity = v === 'error' || v === 'warning' || v === 'info' ? v : v === 'warn' ? 'warning' : undefined;
		if (!severity) {
			errors.push(`Info: unknown severity ${description.severity}. Valid values are error, warning and info.`);
			severity = 'error';
		}
	}
	let result: ProblemMatcher | null = null;
	if (isString(description.base)) {
		const base = description.base.length > 1 && description.base[0] === '$' ? namedMatcher(description.base.slice(1)) : undefined;
		if (base) {
			result = { ...base };
			delete result.name;
			delete result.label;
			if (description.owner !== undefined) result.owner = owner;
			if (description.source !== undefined && source !== undefined) result.source = source;
			if (description.fileLocation !== undefined && fileLocation !== undefined) {
				result.fileLocation = fileLocation;
				result.filePrefix = filePrefix;
			}
			if (description.pattern !== undefined && pattern) result.pattern = pattern;
			if (description.severity !== undefined && severity !== undefined) result.severity = severity;
			if (description.applyTo !== undefined) result.applyTo = applyTo;
		}
	} else if (fileLocation && pattern) {
		result = { owner, applyTo, fileLocation, pattern };
		if (source) result.source = source;
		if (filePrefix) result.filePrefix = filePrefix;
		if (severity) result.severity = severity;
	}
	if (!result) {
		errors.push(`Error: the description can't be converted into a problem matcher:\n${JSON.stringify(description, null, 4)}`);
		return undefined;
	}
	// The legacy watchedTaskBeginsRegExp / EndsRegExp, else background (or the older watching).
	const oldBegins = regex(description.watchedTaskBeginsRegExp, errors);
	const oldEnds = regex(description.watchedTaskEndsRegExp, errors);
	if (oldBegins && oldEnds) result.watching = { activeOnStart: false, beginsPattern: { regexp: oldBegins }, endsPattern: { regexp: oldEnds } };
	else {
		const monitor = description.background ?? description.watching;
		if (isObject(monitor)) {
			const begins = watchingPattern(monitor.beginsPattern, errors);
			const ends = watchingPattern(monitor.endsPattern, errors);
			if (begins && ends) result.watching = { activeOnStart: monitor.activeOnStart === true, beginsPattern: begins, endsPattern: ends };
			else if (begins || ends) errors.push('A problem matcher must define both a begin pattern and an end pattern for watching.');
		}
	}
	return result;
}

/** A task's `problemMatcher` value (a name, an object or an array of both) → matchers, with the
 * problems found on the way in `errors` (VS Code shows them in the Tasks output). */
export function parseProblemMatchers(value: unknown, errors: string[]): ProblemMatcher[] {
	if (value === undefined || value === null) return [];
	const list = Array.isArray(value) ? value : [value];
	const out: ProblemMatcher[] = [];
	for (const item of list) {
		if (isString(item)) {
			const m = item.length > 1 && item[0] === '$' ? namedMatcher(item.slice(1)) : undefined;
			if (m) out.push(m);
			else errors.push(`Problem matcher ${item} can't be resolved. The matcher will be ignored`);
		} else if (isObject(item)) {
			const m = parseMatcherObject(item, errors);
			if (m) out.push(m);
		}
	}
	return out;
}

/** `${workspaceFolder}`, `${cwd}`… in a matcher's file prefix (VS Code's _resolveMatchers). */
export function resolveMatcher(matcher: ProblemMatcher, resolve: (s: string) => string): ProblemMatcher {
	const prefix = matcher.filePrefix;
	if (prefix === undefined) return matcher;
	if (isString(prefix)) return { ...matcher, filePrefix: resolve(prefix) };
	const list = (v: string | string[] | undefined) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).map(resolve));
	return { ...matcher, filePrefix: { include: list(prefix.include), exclude: list(prefix.exclude) } };
}
