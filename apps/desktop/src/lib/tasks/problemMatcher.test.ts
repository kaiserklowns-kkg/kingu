/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { getResource, matcherNames, namedMatcher, normalizePath, parseProblemMatchers, resolveMatcher, type Marker, type ProblemMatcher } from './problemMatcher.ts';
import { StartStopCollector, WatchingCollector, type MarkerStore } from './problemCollector.ts';

const ROOT = '/work/app';

class Store implements MarkerStore {
	data = new Map<string, Map<string, Marker[]>>();
	open = new Set<string>();
	resources(owner: string) {
		return [...(this.data.get(owner)?.keys() ?? [])];
	}
	change(owner: string, resource: string, markers: Marker[]) {
		let m = this.data.get(owner);
		if (!m) this.data.set(owner, (m = new Map()));
		m.set(resource, markers);
	}
	remove(owner: string, resources: string[]) {
		for (const r of resources) this.data.get(owner)?.delete(r);
	}
	isOpen(resource: string) {
		return this.open.has(resource);
	}
	all(owner: string) {
		return [...(this.data.get(owner)?.entries() ?? [])].flatMap(([r, ms]) => ms.map((m) => ({ resource: r, ...m })));
	}
}

const resolved = (name: string, vars: Record<string, string> = { workspaceFolder: ROOT, cwd: ROOT }) =>
	resolveMatcher(namedMatcher(name)!, (s) => s.replace(/\$\{(\w+)\}/g, (_, v: string) => vars[v] ?? ''));

async function collect(matchers: ProblemMatcher[], lines: string[], store = new Store(), exists?: (p: string) => boolean) {
	const c = new StartStopCollector(matchers, store, exists ? { exists: async (p) => exists(p) } : {});
	for (const l of lines) c.processLine(l);
	await c.done();
	return { store, collector: c };
}

describe('built-in matchers', () => {
	test('every VS Code core and extension matcher is registered', () => {
		for (const n of ['msCompile', 'lessCompile', 'gulp-tsc', 'jshint', 'jshint-stylish', 'eslint-compact', 'eslint-stylish', 'go', 'tsc', 'tsc-watch', 'tsgo-watch', 'gcc', 'rustc', 'rustc-json', 'rust-panic', 'rustc-watch'])
			expect(matcherNames()).toContain(n);
	});

	test('$tsc: relative to the folder, both output styles, error code and severity', async () => {
		const { store } = await collect(
			[resolved('tsc')],
			['src/main.ts(3,7): error TS2322: Type \'string\' is not assignable to type \'number\'.', 'src/util.ts:10:2 - warning TS6133: \'x\' is declared but never read.', 'Found 2 errors.']
		);
		const all = store.all('typescript');
		expect(all).toHaveLength(2);
		expect(all[0]).toMatchObject({ resource: `${ROOT}/src/main.ts`, severity: 'error', code: '2322', startLineNumber: 3, startColumn: 7, source: 'ts' });
		expect(all[0].message).toBe("Type 'string' is not assignable to type 'number'.");
		expect(all[1]).toMatchObject({ resource: `${ROOT}/src/util.ts`, severity: 'warning', code: '6133', startLineNumber: 10, startColumn: 2 });
	});

	test('$tsc applies to closed documents only', async () => {
		const store = new Store();
		store.open.add(`${ROOT}/src/main.ts`);
		await collect([resolved('tsc')], ['src/main.ts(1,1): error TS1005: \';\' expected.'], store);
		expect(store.all('typescript')).toHaveLength(0);
	});

	test('$eslint-stylish: multi-line with a looping last pattern', async () => {
		const { store } = await collect(
			[resolved('eslint-stylish')],
			['/work/app/src/a.js', '  1:10  error    \'x\' is defined but never used  no-unused-vars', '  4:1   warning  Unexpected console statement    no-console', '', '✖ 2 problems (1 error, 1 warning)']
		);
		const all = store.all('eslint');
		expect(all).toHaveLength(2);
		expect(all[0]).toMatchObject({ resource: '/work/app/src/a.js', severity: 'error', startLineNumber: 1, startColumn: 10, code: 'no-unused-vars', message: "'x' is defined but never used" });
		expect(all[1]).toMatchObject({ severity: 'warning', startLineNumber: 4, startColumn: 1, code: 'no-console' });
	});

	test('$eslint-compact', async () => {
		const { store } = await collect([resolved('eslint-compact')], ['/work/app/src/a.js: line 2, col 5, Error - Missing semicolon. (semi)']);
		expect(store.all('eslint')[0]).toMatchObject({ resource: '/work/app/src/a.js', severity: 'error', startLineNumber: 2, startColumn: 5, message: 'Missing semicolon.', code: 'semi' });
	});

	test('$gcc: autoDetect falls back to the absolute path', async () => {
		const exists = (p: string) => p === `${ROOT}/src/main.c`;
		const { store } = await collect(
			[resolved('gcc')],
			['src/main.c:12:5: error: expected \';\' before \'}\' token', '/usr/include/stdio.h:3:1: warning: something odd', 'main.c:7:: fatal error: foo.h: No such file or directory'],
			new Store(),
			exists
		);
		const all = store.all('cpptools');
		expect(all.map((m) => m.resource)).toEqual([`${ROOT}/src/main.c`, '/usr/include/stdio.h', '/main.c']);
		expect(all[0]).toMatchObject({ severity: 'error', startLineNumber: 12, startColumn: 5, message: "expected ';' before '}' token" });
		expect(all[1].severity).toBe('warning');
		expect(all[2]).toMatchObject({ severity: 'error', message: 'foo.h: No such file or directory', startColumn: 1, endColumn: 2 ** 31 - 1 });
	});

	test('$go: relative to the folder', async () => {
		const { store } = await collect([resolved('go')], ['# example.com/m', './main.go:8:2: undefined: fmt.Printn', 'pkg/util.go:3: missing return']);
		const all = store.all('go');
		expect(all[0]).toMatchObject({ resource: `${ROOT}/main.go`, startLineNumber: 8, startColumn: 2, message: 'undefined: fmt.Printn' });
		expect(all[1]).toMatchObject({ resource: `${ROOT}/pkg/util.go`, startLineNumber: 3, startColumn: 1 });
	});

	test('$rustc: cargo\'s two-line error and warning, code captured', async () => {
		const exists = (p: string) => p.startsWith(`${ROOT}/src/`);
		const { store } = await collect(
			[resolved('rustc')],
			[
				'   Compiling app v0.1.0 (/work/app)',
				'error[E0425]: cannot find value `y` in this scope',
				' --> src/main.rs:4:13',
				'  |',
				'4 |     let x = y;',
				'warning: unused variable: `x`',
				'  --> src/lib.rs:2:9',
				'error: could not compile `app` (bin "app") due to 1 previous error'
			],
			new Store(),
			exists
		);
		const all = store.all('rustc');
		expect(all).toHaveLength(2);
		expect(all[0]).toMatchObject({ resource: `${ROOT}/src/main.rs`, severity: 'error', code: 'E0425', startLineNumber: 4, startColumn: 13, message: 'cannot find value `y` in this scope', source: 'rustc' });
		expect(all[1]).toMatchObject({ resource: `${ROOT}/src/lib.rs`, severity: 'warning', startLineNumber: 2, startColumn: 9 });
	});

	test('$rust-panic', async () => {
		const { store } = await collect([resolved('rust-panic')], ["thread 'main' panicked at src/main.rs:5:9:", 'attempt to divide by zero'], new Store(), () => true);
		expect(store.all('rustc')[0]).toMatchObject({ resource: `${ROOT}/src/main.rs`, startLineNumber: 5, startColumn: 9, message: 'attempt to divide by zero' });
	});

	test('$rustc-json', async () => {
		const line = '{"reason":"compiler-message","message":{"message":"unused import","code":null,"level":"warning","spans":[{"file_name":"src/a.rs","line_start":1,"line_end":1,"column_start":5,"column_end":12}]}}';
		const { store } = await collect([resolved('rustc-json')], [line], new Store(), () => true);
		expect(store.all('rustc')[0]).toMatchObject({ resource: `${ROOT}/src/a.rs`, startLineNumber: 1, endLineNumber: 1, startColumn: 5, endColumn: 12, message: 'unused import' });
	});

	test('$msCompile: absolute paths and a location group', async () => {
		const { store } = await collect([resolved('msCompile')], ['C:\\src\\a.cpp(10,5): error C2065: \'x\': undeclared identifier', '  1>/src/b.cs(3): warning CS0168: The variable is declared but never used']);
		const all = store.all('msCompile');
		expect(all[0]).toMatchObject({ resource: '/C:/src/a.cpp', severity: 'error', code: 'C2065', startLineNumber: 10, startColumn: 5 });
		expect(all[1]).toMatchObject({ resource: '/src/b.cs', severity: 'warning', code: 'CS0168', startLineNumber: 3 });
	});

	test('$lessCompile', async () => {
		const { store } = await collect([resolved('lessCompile')], ['Unrecognised input in file /work/app/a.less line no. 7']);
		expect(store.all('lessCompile')[0]).toMatchObject({ resource: '/work/app/a.less', startLineNumber: 7, message: 'Unrecognised input', severity: 'error' });
	});

	test('$gulp-tsc', async () => {
		const { store } = await collect([resolved('gulp-tsc')], ['src/a.ts(4,2): 2304 Cannot find name \'x\'.']);
		expect(store.all('typescript')[0]).toMatchObject({ resource: `${ROOT}/src/a.ts`, code: '2304', startLineNumber: 4, startColumn: 2 });
	});

	test('$jshint and $jshint-stylish (E/W severities)', async () => {
		const one = await collect([resolved('jshint')], ['/work/app/a.js: line 3, col 9, Missing semicolon. (W033)']);
		expect(one.store.all('jshint')[0]).toMatchObject({ severity: 'warning', code: '033', startLineNumber: 3, startColumn: 9, message: 'Missing semicolon.' });
		const two = await collect([resolved('jshint-stylish')], ['/work/app/b.js', '  line 1  col 2  Bad thing. (E001)', '  line 5  col 1  Other thing.']);
		const all = two.store.all('jshint');
		expect(all).toHaveLength(2);
		expect(all[0]).toMatchObject({ resource: '/work/app/b.js', severity: 'error', code: '001' });
		expect(all[1]).toMatchObject({ severity: 'error', startLineNumber: 5, message: 'Other thing.' });
	});
});

describe('tasks.json matchers', () => {
	test('inline pattern with defaults (file 1, line 2, column 3, message 0) and owner', async () => {
		const errors: string[] = [];
		const [m] = parseProblemMatchers({ owner: 'mine', fileLocation: ['relative', '${workspaceFolder}/sub'], pattern: { regexp: '^(.*):(\\d+):(\\d+): (.*)$', message: 4 } }, errors);
		expect(errors).toEqual([]);
		const { store } = await collect([resolveMatcher(m, (s) => s.replace('${workspaceFolder}', ROOT))], ['x.c:1:2: boom']);
		expect(store.all('mine')[0]).toMatchObject({ resource: `${ROOT}/sub/x.c`, startLineNumber: 1, startColumn: 2, message: 'boom', severity: 'error' });
	});

	test('multi-line array pattern, severity default and kind file', async () => {
		const errors: string[] = [];
		const [m] = parseProblemMatchers(
			{
				owner: 'multi',
				fileLocation: 'absolute',
				severity: 'warning',
				pattern: [{ regexp: '^FILE (.*)$', file: 1, kind: 'file' }, { regexp: '^MSG (.*)$', message: 1 }]
			},
			errors
		);
		expect(errors).toEqual([]);
		const { store } = await collect([m], ['FILE /x/y.txt', 'MSG broken file']);
		expect(store.all('multi')[0]).toMatchObject({ resource: '/x/y.txt', severity: 'warning', message: 'broken file', startLineNumber: 0 });
	});

	test('base extends a named matcher; unknown names and bad patterns are reported', () => {
		const errors: string[] = [];
		const ms = parseProblemMatchers(['$tsc', '$nope', { base: '$tsc', owner: 'other', fileLocation: 'absolute' }, { pattern: { regexp: '(' } }, { pattern: [{ regexp: 'x' }] }], errors);
		expect(ms).toHaveLength(2);
		expect(ms[1]).toMatchObject({ owner: 'other', fileLocation: 'absolute', source: 'ts' });
		expect(errors.some((e) => e.includes('$nope'))).toBe(true);
		expect(errors.some((e) => e.includes('not a valid regular expression'))).toBe(true);
		expect(errors.some((e) => e.includes('must have at least have a file and a message'))).toBe(true);
	});

	test('the loop property only on the last pattern', () => {
		const errors: string[] = [];
		parseProblemMatchers({ owner: 'o', pattern: [{ regexp: 'a', file: 1, loop: true }, { regexp: 'b', message: 1, line: 2 }] }, errors);
		expect(errors.some((e) => e.includes('only supported on the last line matcher'))).toBe(true);
	});

	test('fileLocation forms', async () => {
		const m = (fileLocation: unknown) => parseProblemMatchers({ owner: 'o', fileLocation, pattern: { regexp: '^(.*):(\\d+):(\\d+) (.*)$', message: 4 } }, [])[0];
		expect(m(undefined)).toMatchObject({ fileLocation: 'relative', filePrefix: '${workspaceFolder}' });
		expect(m('autodetect')).toMatchObject({ fileLocation: 'autoDetect', filePrefix: '${workspaceFolder}' });
		expect(m(['absolute'])).toMatchObject({ fileLocation: 'absolute' });
		expect(m(['search', { include: ['${workspaceFolder}/src'] }])).toMatchObject({ fileLocation: 'search', filePrefix: { include: ['${workspaceFolder}/src'] } });
		const search = m(['search']);
		expect(await getResource('a.ts', { ...search, filePrefix: { include: ['/r'] } }, { search: async (f, a) => (f === 'a.ts' ? `${a.include}/deep/a.ts` : null) })).toBe('/r/deep/a.ts');
		expect(await getResource('missing.ts', search, { search: async () => null })).toBe('/missing.ts');
	});

	test('paths are normalized', () => {
		expect(normalizePath('/a/./b/../c//d')).toBe('/a/c/d');
	});
});

describe('watching collector (background tasks)', () => {
	const tscWatch = () => resolved('tsc-watch');

	test('begins / ends: each cycle replaces the previous problems, events fire', async () => {
		const store = new Store();
		const c = new WatchingCollector([tscWatch()], store);
		const events: string[] = [];
		c.onEvent((e) => events.push(e.kind));
		c.aboutToStart();
		const feed = async (lines: string[]) => {
			lines.forEach((l) => c.processLine(l));
			await c.idle();
		};
		await feed(['[10:00:00 AM] Starting compilation in watch mode...', 'src/a.ts(1,1): error TS1005: \';\' expected.', '[10:00:02 AM] Found 1 error. Watching for file changes.']);
		expect(store.all('typescript').map((m) => m.resource)).toEqual([`${ROOT}/src/a.ts`]);
		expect(events).toEqual(['begins', 'ends']);
		await feed(['[10:01:00 AM] File change detected. Starting incremental compilation...', 'src/b.ts(2,3): error TS2304: Cannot find name \'q\'.', '[10:01:01 AM] Found 1 error. Watching for file changes.']);
		expect(store.all('typescript').map((m) => m.resource)).toEqual([`${ROOT}/src/b.ts`]);
		await feed(['[10:02:00 AM] File change detected. Starting incremental compilation...', '[10:02:01 AM] Found 0 errors. Watching for file changes.']);
		expect(store.all('typescript')).toEqual([]);
		expect(events).toEqual(['begins', 'ends', 'begins', 'ends', 'begins', 'ends']);
		expect(c.activeCount).toBe(0);
	});

	test('activeOnStart false waits for the begins pattern; rustc-watch', async () => {
		const store = new Store();
		const c = new WatchingCollector([resolved('rustc-watch')], store, { exists: async () => true });
		const events: string[] = [];
		c.onEvent((e) => events.push(e.kind));
		c.aboutToStart();
		expect(events).toEqual([]);
		['[Running \'cargo check\']', 'error: oops', ' --> src/x.rs:1:1', '[Finished running. Exit status: 101]'].forEach((l) => c.processLine(l));
		await c.idle();
		expect(events).toEqual(['begins', 'ends']);
		expect(store.all('rustc')[0]).toMatchObject({ resource: `${ROOT}/src/x.rs`, message: 'oops' });
	});

	test('inline background patterns in tasks.json', async () => {
		const [m] = parseProblemMatchers(
			{ owner: 'w', fileLocation: 'absolute', pattern: { regexp: '^ERR (.*):(\\d+) (.*)$', file: 1, line: 2, message: 3 }, background: { activeOnStart: false, beginsPattern: 'rebuilding', endsPattern: { regexp: 'done' } } },
			[]
		);
		expect(m.watching?.beginsPattern.regexp.source).toBe('rebuilding');
		const store = new Store();
		const c = new WatchingCollector([m], store);
		['rebuilding', 'ERR /f.txt:3 bad', 'done'].forEach((l) => c.processLine(l));
		await c.idle();
		expect(store.all('w')).toHaveLength(1);
		await c.done();
		// A watcher's problems go away when the task exits.
		expect(store.all('w')).toHaveLength(0);
	});
});

describe('start/stop collector', () => {
	test('a new run replaces the previous run\'s problems of the same owner', async () => {
		const store = new Store();
		await collect([resolved('go')], ['a.go:1:1: one', 'b.go:2:2: two'], store);
		expect(store.all('go')).toHaveLength(2);
		await collect([resolved('go')], ['b.go:3:3: three'], store);
		expect(store.all('go').map((m) => [m.resource, m.message])).toEqual([[`${ROOT}/b.go`, 'three']]);
	});

	test('counts matches and the worst severity', async () => {
		const { collector } = await collect([resolved('tsc')], ['a.ts(1,1): warning TS1: w', 'b.ts(1,1): error TS2: e']);
		expect(collector.numberOfMatches).toBe(2);
		expect(collector.maxMarkerSeverity).toBe('error');
	});
});
