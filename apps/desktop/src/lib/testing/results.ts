// Reading test results (VS Code: what a test controller reports to a TestRun): cargo's and go's
// text output as it streams in the test terminal, the JUnit XML bun and pytest write, and the JSON
// report jest and vitest write. Each becomes events naming a test the runner's way, with the
// failure message, expected/actual values and the location of the failure. Pure.

import type { TestMessage, TestState } from './model.ts';

/** A result as the runner names the test; the Testing service maps it to an item. */
export type TestEvent = {
	/** cargo: the test binary's crate (`demo_crate`); go: the package import path. */
	scope?: string;
	/** cargo `tests::adds`, go `TestAdd` (`TestA/sub` for subtests). */
	name?: string;
	/** junit/json: the file (as the report names it) and the names from the file down. */
	file?: string;
	path?: string[];
	/** junit (pytest): the dotted class name. */
	classname?: string;
	/** junit: the declaration's line as reported. */
	line?: number;
	state: TestState;
	duration?: number;
	messages?: TestMessage[];
};

/** A failure message's location as `file:line[:column]` (rel or absolute, as printed). */
export type RawLocation = { file: string; line: number; column?: number };
export type RawMessage = { message: string; expected?: string; actual?: string; at?: RawLocation };

/**
 * Expected and actual values in a failure message: jest/bun `Expected: … Received: …`, Rust
 * `left: … right: …` (assert_eq!(actual, expected)), pytest `assert actual == expected`, vitest's
 * `- Expected / + Received` diff with one line each.
 */
export function expectedActual(text: string): { expected?: string; actual?: string } {
	let m = text.match(/Expected:\s*(.*)\n\s*Received:\s*(.*)/);
	if (m) return { expected: m[1].trim(), actual: m[2].trim() };
	m = text.match(/\bleft:\s*(.*)\n\s*right:\s*(.*)/);
	if (m) return { actual: m[1].trim(), expected: m[2].trim() };
	m = text.match(/^E\s+(?:AssertionError: )?assert (.+?) == (.+)$/m) ?? text.match(/^(?:AssertionError: )?assert (.+?) == (.+)$/m);
	if (m) return { actual: m[1].trim(), expected: m[2].trim() };
	m = text.match(/- Expected\s*\n\+ Received\s*\n\s*\n- (.*)\n\+ (.*)/);
	if (m) return { expected: m[1].trim(), actual: m[2].trim() };
	return {};
}

// --- cargo test (libtest's text output) ----------------------------------------------------------

/** Streams `cargo test` output: per-test results as they print, failure details at the end. */
export class CargoParser {
	#crate = '';
	#capturing: { name: string; lines: string[] } | null = null;

	feed(line: string): TestEvent[] {
		const out: TestEvent[] = [];
		const run = line.match(/^\s*Running\s+(?:unittests\s+)?\S+\s+\(([^)]+)\)/);
		if (run) {
			out.push(...this.#flush());
			this.#crate = run[1].slice(run[1].lastIndexOf('/') + 1).replace(/-[0-9a-f]+(\.exe)?$/, '');
			return out;
		}
		const section = line.match(/^---- (\S+) stdout ----$/);
		if (section) {
			out.push(...this.#flush());
			this.#capturing = { name: section[1], lines: [] };
			return out;
		}
		if (this.#capturing) {
			if (/^(failures:|test result:|successes:)/.test(line)) out.push(...this.#flush());
			else {
				this.#capturing.lines.push(line);
				return out;
			}
		}
		const result = line.match(/^test (\S+)(?: - should panic)? \.\.\. (ok|FAILED|ignored|bench)\b/);
		if (result && result[2] !== 'bench') {
			const state: TestState = result[2] === 'ok' ? 'passed' : result[2] === 'ignored' ? 'skipped' : 'failed';
			out.push({ scope: this.#crate, name: result[1], state });
		}
		return out;
	}

	end(): TestEvent[] {
		return this.#flush();
	}

	#flush(): TestEvent[] {
		const c = this.#capturing;
		this.#capturing = null;
		if (!c) return [];
		const text = c.lines.join('\n').replace(/\nnote: run with `RUST_BACKTRACE=1`[^\n]*/, '').trim();
		const at = text.match(/panicked at ([^\s:]+(?::[^\s:]+)*?):(\d+):(\d+):?/);
		// The panic message is what follows the "panicked at …:" line.
		const body = at ? text.slice(text.indexOf(at[0]) + at[0].length).trim() : text;
		const message: RawMessage = { message: body || text, ...expectedActual(body), ...(at ? { at: { file: at[1], line: Number(at[2]), column: Number(at[3]) } } : {}) };
		return [{ scope: this.#crate, name: c.name, state: 'failed', messages: [rawToMessage(message)] }];
	}
}

/** A raw message's location goes in `location.rel` as printed; the service resolves it to a workspace file. */
function rawToMessage(m: RawMessage): TestMessage {
	return { message: m.message, ...(m.expected !== undefined ? { expected: m.expected } : {}), ...(m.actual !== undefined ? { actual: m.actual } : {}), ...(m.at ? { location: { rel: m.at.file, line: m.at.line, column: m.at.column } } : {}) };
}

// --- go test -v ----------------------------------------------------------------------------------

/** Streams `go test -v` output; results are reported when their package's ok/FAIL line arrives. */
export class GoParser {
	#pending: TestEvent[] = [];
	#output = new Map<string, string[]>();
	#current: string | null = null;

	feed(line: string): TestEvent[] {
		const run = line.match(/^=== (?:RUN|CONT|PAUSE)\s+(\S+)/);
		if (run) {
			this.#current = run[1];
			if (!this.#output.has(run[1])) this.#output.set(run[1], []);
			if (line.startsWith('=== RUN')) this.#pending.push({ name: run[1], state: 'running' });
			return [];
		}
		const done = line.match(/^\s*--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+)s\)/);
		if (done) {
			const state: TestState = done[1] === 'PASS' ? 'passed' : done[1] === 'FAIL' ? 'failed' : 'skipped';
			const lines = this.#output.get(done[2]) ?? [];
			const messages = state === 'passed' ? [] : goMessages(lines);
			this.#pending.push({ name: done[2], state, duration: Number(done[3]) * 1000, messages });
			return [];
		}
		const pkg = line.match(/^(ok|FAIL|---? FAIL)\s+(\S+)\s+(?:[\d.]+s|\(cached\)|\[build failed\]|\[setup failed\])/) ?? line.match(/^(FAIL)\s+(\S+)\s+\[(?:build|setup) failed\]/);
		if (pkg) {
			const scope = pkg[2];
			const failedBuild = /\[(build|setup) failed\]/.test(line);
			const events = this.#pending.filter((e) => e.state !== 'running').map((e) => ({ ...e, scope }));
			if (failedBuild) events.push({ scope, state: 'errored', messages: [{ message: line.trim() }] });
			this.#pending = [];
			this.#output.clear();
			this.#current = null;
			return events;
		}
		if (this.#current && /^\s{4}/.test(line)) this.#output.get(this.#current)?.push(line);
		return [];
	}

	end(): TestEvent[] {
		const left = this.#pending.filter((e) => e.state !== 'running');
		this.#pending = [];
		return left;
	}
}

/** `    file_test.go:12: message` lines (continuations indented further) as messages. */
function goMessages(lines: readonly string[]): TestMessage[] {
	const out: TestMessage[] = [];
	for (const raw of lines) {
		const m = raw.match(/^\s{4}(\S+\.go):(\d+): (.*)$/);
		if (m) out.push({ message: m[3], location: { rel: m[1], line: Number(m[2]) }, ...expectedActual(m[3]) });
		else if (out.length && raw.trim()) out[out.length - 1].message += `\n${raw.trim()}`;
	}
	return out;
}

// --- JUnit XML (bun test --reporter=junit, pytest --junitxml) ------------------------------------

export function decodeXml(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
		if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
		return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e] ?? _;
	});
}

function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
	return out;
}

/**
 * Test cases of a JUnit report: the file and nested suite names around each (bun nests a suite per
 * describe block inside the file's suite), its class name, line, time and result with the message.
 */
export function parseJunit(xml: string): TestEvent[] {
	const out: TestEvent[] = [];
	const suites: { name: string; file?: string }[] = [];
	const tag = /<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g;
	let open: (TestEvent & { body?: number }) | null = null;
	for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
		const [whole, closing, name, rest, selfClosing] = m;
		if (name === 'testsuite') {
			if (closing) suites.pop();
			else if (!selfClosing) {
				const a = attrs(rest);
				suites.push({ name: a.name ?? '', file: a.file });
			}
		} else if (name === 'testcase') {
			if (closing) {
				if (open) out.push(open);
				open = null;
				continue;
			}
			const a = attrs(rest);
			const file = a.file ?? [...suites].reverse().find((s) => s.file)?.file;
			// Suites below the file's own (bun's describe blocks).
			const fileSuite = suites.findIndex((s) => s.file && s.file === file);
			const inner = fileSuite >= 0 ? suites.slice(fileSuite + 1).map((s) => s.name) : [];
			const event: TestEvent = {
				file,
				path: [...inner, a.name ?? ''],
				classname: a.classname,
				...(a.line !== undefined ? { line: Number(a.line) } : {}),
				state: 'passed',
				...(a.time !== undefined ? { duration: Number(a.time) * 1000 } : {})
			};
			if (selfClosing) out.push(event);
			else open = event;
		} else if (open && !closing && (name === 'failure' || name === 'error' || name === 'skipped')) {
			const a = attrs(rest);
			if (name === 'skipped') {
				open.state = 'skipped';
				continue;
			}
			let text = '';
			if (!selfClosing) {
				const end = xml.indexOf(`</${name}>`, m.index + whole.length);
				text = decodeXml(xml.slice(m.index + whole.length, end < 0 ? undefined : end));
				tag.lastIndex = end < 0 ? xml.length : end + name.length + 3;
			}
			open.state = name === 'failure' ? 'failed' : 'errored';
			const message = (a.message ?? '').trim() || text.trim();
			const at = locationIn(text) ?? locationIn(message);
			open.messages = [{ message, ...expectedActual(message.includes('\n') ? message : `${message}\n${text}`), ...(at ? { location: { rel: at.file, line: at.line, column: at.column } } : {}) }];
			// bun repeats the message as `Type: message` plus the stack; pytest's text is the traceback, worth keeping.
			const bare = text
				.split('\n')
				.filter((l) => !/^\s*at /.test(l))
				.join('\n')
				.trim()
				.replace(/^\w+: /, '');
			if (text.trim() && bare !== message.trim() && text.trim() !== message) open.messages[0].message = `${message}\n\n${text.trim()}`;
		}
	}
	return out;
}

/** The first `path:line[:col]` of a source file in a stack or traceback (`at x (file:1:2)`, `file.py:3: Error`). */
export function locationIn(text: string): RawLocation | null {
	// In parentheses a path may have spaces (`at f (/a b/x.ts:1:2)`); elsewhere it is one word.
	const m = text.match(/\(([^()\n]+?\.(?:[cm]?[jt]sx?|py|rs|go)):(\d+)(?::(\d+))?\)/) ?? text.match(/(?:^|[\s(])([^\s():]+\.(?:[cm]?[jt]sx?|py|rs|go)):(\d+)(?::(\d+))?/m);
	if (!m) return null;
	return { file: m[1].trim(), line: Number(m[2]), ...(m[3] ? { column: Number(m[3]) } : {}) };
}

// --- jest --json / vitest --reporter=json --------------------------------------------------------

type JestAssertion = { ancestorTitles?: string[]; title: string; status: string; duration?: number | null; failureMessages?: string[]; location?: { line: number; column: number } | null };
type JestReport = { testResults?: { name: string; message?: string; status?: string; assertionResults?: JestAssertion[] }[] };

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Results of a jest/vitest JSON report: file (absolute), names from the file down, failures with locations. */
export function parseJestJson(json: string): TestEvent[] {
	let report: JestReport;
	try {
		report = JSON.parse(json);
	} catch {
		return [];
	}
	const out: TestEvent[] = [];
	for (const file of report.testResults ?? []) {
		const results = file.assertionResults ?? [];
		for (const a of results) {
			const state: TestState = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : a.status === 'pending' || a.status === 'skipped' || a.status === 'todo' || a.status === 'disabled' ? 'skipped' : 'unset';
			const messages = (a.failureMessages ?? []).map((raw) => {
				const message = stripAnsi(raw);
				// The first stack frame in the test file itself.
				const frames = [...message.matchAll(/(?:\(|at |❯ )(\/[^\s():]+):(\d+):(\d+)/g)];
				const own = frames.find((f) => f[1] === file.name) ?? frames[0];
				const at = own ? { rel: own[1], line: Number(own[2]), column: Number(own[3]) } : a.location ? { rel: file.name, line: a.location.line, column: a.location.column } : undefined;
				return { message: message.split('\n    at ')[0].trim(), ...expectedActual(message), ...(at ? { location: at } : {}) };
			});
			out.push({ file: file.name, path: [...(a.ancestorTitles ?? []), a.title], state, ...(a.duration != null ? { duration: a.duration } : {}), ...(messages.length ? { messages } : {}) });
		}
		// A file that failed to load (syntax error, import failure) has no assertions.
		if (!results.length && file.status === 'failed' && file.message) out.push({ file: file.name, path: [], state: 'errored', messages: [{ message: stripAnsi(file.message).trim() }] });
	}
	return out;
}
