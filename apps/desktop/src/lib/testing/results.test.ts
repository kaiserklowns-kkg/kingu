/// <reference types="bun" />
// Every runner's output as Kingu reads it, from real runs (cargo 1.9x, go 1.27, bun 1.4 written to
// testdata/ as they printed) and the documented jest/vitest JSON and pytest xunit1 reports.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CargoParser, expectedActual, GoParser, locationIn, parseJestJson, parseJunit, type TestEvent } from './results.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'testdata', name), 'utf8');
const stream = (parser: { feed(l: string): TestEvent[]; end(): TestEvent[] }, text: string) => [...text.split('\n').flatMap((l) => parser.feed(l)), ...parser.end()];
const brief = (events: TestEvent[]) => events.map((e) => [e.scope ?? e.file ?? '', e.name ?? (e.path ?? []).join(' > '), e.state]);

describe('cargo test', () => {
	test('results as they print, then the failure details with location and left/right', () => {
		const events = stream(new CargoParser(), fixture('cargo-test.txt'));
		expect(brief(events)).toEqual([
			['demo_crate', 'tests::slow', 'skipped'],
			['demo_crate', 'tests::adds', 'passed'],
			['demo_crate', 'tests::fails', 'failed'],
			['demo_crate', 'tests::panics', 'failed'],
			['demo_crate', 'tests::fails', 'failed'],
			['demo_crate', 'tests::panics', 'failed']
		]);
		const fails = events[4].messages![0];
		expect(fails).toEqual({ message: 'assertion `left == right` failed: one plus one\n  left: 2\n right: 3', actual: '2', expected: '3', location: { rel: 'src/lib.rs', line: 16, column: 9 } });
		expect(events[5].messages![0]).toMatchObject({ message: 'boom', location: { rel: 'src/lib.rs', line: 25, column: 9 } });
	});

	test('older panic lines (no thread id) and workspace paths', () => {
		const out = ["     Running unittests src/lib.rs (target/debug/deps/kingu_lib-0123abcd)", 'test a::b ... FAILED', '', 'failures:', '', '---- a::b stdout ----', "thread 'a::b' panicked at apps/desktop/src-tauri/src/a.rs:3:5:", 'nope', '', 'failures:', '    a::b'].join('\n');
		const events = stream(new CargoParser(), out);
		expect(events.at(-1)).toMatchObject({ scope: 'kingu_lib', name: 'a::b', state: 'failed', messages: [{ message: 'nope', location: { rel: 'apps/desktop/src-tauri/src/a.rs', line: 3, column: 5 } }] });
	});
});

describe('go test -v', () => {
	test('results arrive with their package; t.Errorf lines are the messages', () => {
		const events = stream(new GoParser(), fixture('go-test.txt'));
		expect(brief(events)).toEqual([
			['example.com/demo', 'TestAdd', 'passed'],
			['example.com/demo', 'TestSub', 'failed'],
			['example.com/demo', 'TestSkip', 'skipped'],
			['example.com/demo', 'TestTable', 'passed'],
			['example.com/demo', 'TestTable/one_case', 'passed']
		]);
		expect(events[1].messages).toEqual([{ message: 'got 1, want 2', location: { rel: 'demo_test.go', line: 12 } }]);
		expect(events[1].duration).toBe(0);
	});

	test('a package that fails to build errors its tests', () => {
		const events = stream(new GoParser(), '# example.com/demo\n./a_test.go:3:1: syntax error\nFAIL\texample.com/demo [build failed]\n');
		expect(events).toEqual([{ scope: 'example.com/demo', state: 'errored', messages: [{ message: 'FAIL\texample.com/demo [build failed]' }] }]);
	});
});

describe('JUnit', () => {
	test("bun test --reporter=junit: describe blocks nest under the file's suite, skips and todos, failures with location", () => {
		const events = parseJunit(fixture('bun-junit.xml'));
		expect(brief(events)).toEqual([
			['math.test.ts', 'math > adds', 'passed'],
			['math.test.ts', 'math > subtracts', 'failed'],
			['math.test.ts', 'math > later', 'skipped'],
			['math.test.ts', 'math > someday', 'skipped'],
			['math.test.ts', 'equal objects', 'failed'],
			['math.test.ts', 'throws', 'failed']
		]);
		expect(events[1].messages![0]).toMatchObject({ expected: '1', actual: '2', location: { rel: 'math.test.ts', line: 5, column: 19 } });
		expect(events[1].messages![0].message.startsWith('expect(received).toBe(expected)')).toBe(true);
		expect(events[5].messages![0]).toMatchObject({ location: { rel: 'math.test.ts', line: 11, column: 46 } });
		expect(events[0].line).toBe(3);
		expect(events[0].duration).toBeCloseTo(0.009);
	});

	test('pytest --junitxml (xunit1): class names, parameters, skips, setup errors', () => {
		const events = parseJunit(fixture('pytest-junit.xml'));
		expect(events.map((e) => [e.classname, e.path?.join(' > '), e.state])).toEqual([
			['tests.test_math', 'test_add', 'passed'],
			['tests.test_math', 'test_sub', 'failed'],
			['tests.test_math.TestDiv', 'test_zero', 'failed'],
			['tests.test_math', 'test_param[2-3]', 'passed'],
			['tests.test_math', 'test_later', 'skipped'],
			['tests.test_fixture', 'test_db', 'errored']
		]);
		expect(events[1].messages![0]).toMatchObject({ actual: '1', expected: '2', location: { rel: 'tests/test_math.py', line: 8 } });
		expect(events[1].file).toBe('tests/test_math.py');
		expect(events[5].messages![0].message).toContain("fixture 'db' not found");
	});
});

describe('jest / vitest JSON', () => {
	test('jest: names from the file down, the failure stack frame in the test file, a suite that failed to run', () => {
		const events = parseJestJson(fixture('jest.json'));
		expect(brief(events)).toEqual([
			['/ws/web/src/sum.test.js', 'sum > adds', 'passed'],
			['/ws/web/src/sum.test.js', 'sum > subtracts', 'failed'],
			['/ws/web/src/sum.test.js', 'later', 'skipped'],
			['/ws/web/src/broken.test.js', '', 'errored']
		]);
		expect(events[1].messages![0]).toEqual({ message: 'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 1\nReceived: 2', expected: '1', actual: '2', location: { rel: '/ws/web/src/sum.test.js', line: 8, column: 19 } });
		expect(events[3].messages![0].message).toContain('SyntaxError: Unexpected token');
	});

	test('vitest: the - Expected / + Received diff', () => {
		const events = parseJestJson(fixture('vitest.json'));
		expect(brief(events)).toEqual([
			['/ws/web/src/math.test.ts', 'math > nested > multiplies', 'passed'],
			['/ws/web/src/math.test.ts', 'math > divides', 'failed'],
			['/ws/web/src/math.test.ts', 'math > skipped one', 'skipped']
		]);
		expect(events[1].messages![0]).toMatchObject({ expected: '3', actual: '2', location: { rel: '/ws/web/src/math.test.ts', line: 9, column: 19 } });
		expect(parseJestJson('not json')).toEqual([]);
	});
});

test('expected/actual and locations in free text', () => {
	expect(expectedActual('Expected: "a"\nReceived: "b"')).toEqual({ expected: '"a"', actual: '"b"' });
	expect(expectedActual('E       assert [1, 2] == [1, 3]')).toEqual({ actual: '[1, 2]', expected: '[1, 3]' });
	expect(expectedActual('nothing to compare')).toEqual({});
	expect(locationIn('Traceback:\n  tests/test_a.py:12: in test_x')).toEqual({ file: 'tests/test_a.py', line: 12 });
	expect(locationIn('    at foo (/ws/a b/x.test.ts:3:9)')).toEqual({ file: '/ws/a b/x.test.ts', line: 3, column: 9 });
	expect(locationIn('no location')).toBeNull();
});
