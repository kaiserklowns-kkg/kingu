/// <reference types="bun" />
// The commands Kingu runs for a selection of tests, and the launch configurations that debug one.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countBadge, fileItem, findItem, leaves, projectItems, stateOf, summary, testAt, type TestItem, type TestResult } from './model.ts';
import { cargoBinaryName, cargoTestExecutable, debugConfig, namePattern, pytestNodeId, runPlans, shellLine } from './runners.ts';

const rust = fileItem(
	'cargo',
	'crates/demo',
	'crates/demo/src/net/http.rs',
	[{ name: 'tests', line: 10, kind: 'suite', children: [{ name: 'adds', line: 12, kind: 'test', children: [] }, { name: 'subs', line: 15, kind: 'test', children: [] }] }],
	{ crate: 'demo-crate', target: 'lib', prefix: 'net::http' }
);
const go = fileItem('go', '', 'pkg/math/math_test.go', [{ name: 'TestAdd', line: 5, kind: 'test', children: [] }, { name: 'TestSub', line: 9, kind: 'test', children: [] }], { dir: 'pkg/math', importPath: 'example.com/m/pkg/math' });
const bun = fileItem('bun', 'apps/web', 'apps/web/src/a.test.ts', [{ name: 'math', line: 1, kind: 'suite', children: [{ name: 'adds (1+1)', line: 2, kind: 'test', children: [] }] }]);
const vitest = fileItem('vitest', 'web', 'web/src/b.test.ts', [{ name: 'b', line: 3, kind: 'test', children: [] }]);
const py = fileItem('pytest', '', 'tests/test_math.py', [
	{ name: 'TestDiv', line: 6, kind: 'suite', children: [{ name: 'test_zero', line: 7, kind: 'test', children: [] }] },
	{ name: 'test_param', line: 13, kind: 'suite', children: [{ name: 'test_param[1-2]', line: 13, kind: 'test', children: [] }] }
]);
const tree = projectItems([rust, go, bun, vitest, py]);
const at = (id: string) => findItem(tree, id)!;
let n = 0;
const opts = { report: () => `/tmp/r${++n}.json`, python: () => '/ws/.venv/bin/python' };

describe('runPlans', () => {
	test('cargo: one command per crate target with exact names; a whole project runs everything', () => {
		const [plan] = runPlans([at('cargo:crates/demo/src/net/http.rs::tests > adds')], opts);
		expect(plan).toMatchObject({ project: 'crates/demo', parser: 'cargo', argv: ['cargo', 'test', '-p', 'demo-crate', '--lib', '--', '--exact', 'net::http::tests::adds'] });
		expect(runPlans([at(rust.id)], opts)[0].argv.slice(-2)).toEqual(['net::http::tests::adds', 'net::http::tests::subs']);
		expect(runPlans([at('cargo:project:crates/demo')], opts)[0].argv).toEqual(['cargo', 'test', '-p', 'demo-crate', '--no-fail-fast']);
		expect(cargoBinaryName('demo-crate', 'lib')).toBe('demo_crate');
		expect(cargoBinaryName('demo-crate', 'test:api-v2')).toBe('api_v2');
	});

	test('go: -run with anchored names per package, ./... for the module', () => {
		expect(runPlans([at(go.id)], opts)[0]).toMatchObject({ project: '', parser: 'go', argv: ['go', 'test', '-v', '-run', '^(TestAdd|TestSub)$', './pkg/math'] });
		expect(runPlans([at('go:project:')], opts)[0].argv).toEqual(['go', 'test', '-v', './...']);
	});

	test('bun: JUnit report, files and an anchored -t pattern of the names', () => {
		const [plan] = runPlans([at('bun:apps/web/src/a.test.ts::math > adds (1+1)')], opts);
		expect(plan.parser).toBe('junit');
		expect(plan.argv).toEqual(['bun', 'test', '--reporter=junit', `--reporter-outfile=${plan.report}`, './src/a.test.ts', '-t', '^math adds \\(1\\+1\\)$']);
		// A whole file: no pattern.
		expect(runPlans([at(bun.id)], opts)[0].argv).not.toContain('-t');
	});

	test('vitest and jest write JSON reports', () => {
		const [plan] = runPlans([at(vitest.id)], opts);
		expect(plan.argv).toEqual(['npx', 'vitest', 'run', 'src/b.test.ts', '--reporter=default', '--reporter=json', `--outputFile.json=${plan.report}`]);
		const jest = fileItem('jest', '', 'x.test.js', [{ name: 'x', line: 1, kind: 'test', children: [] }]);
		const [j] = runPlans([jest.children[0]], opts);
		expect(j.argv).toEqual(['npx', 'jest', 'x.test.js', '-t', '^x$', '--json', `--outputFile=${j.report}`, '--testLocationInResults']);
	});

	test('pytest: node ids (classes, parameters), the project venv, xunit1 JUnit', () => {
		const [plan] = runPlans([at('pytest:tests/test_math.py::TestDiv > test_zero'), at('pytest:tests/test_math.py::test_param > test_param[1-2]')], opts);
		expect(plan.argv).toEqual(['/ws/.venv/bin/python', '-m', 'pytest', '-v', '--tb=short', '-o', 'junit_family=xunit1', `--junitxml=${plan.report}`, 'tests/test_math.py::TestDiv::test_zero', 'tests/test_math.py::test_param[1-2]']);
		expect(pytestNodeId(at('pytest:tests/test_math.py::TestDiv'))).toBe('tests/test_math.py::TestDiv');
	});

	test('the name pattern for suites is a prefix', () => {
		expect(namePattern([at('bun:apps/web/src/a.test.ts::math')])).toBe('^math');
		expect(namePattern([])).toBeNull();
	});

	test('shell quoting', () => {
		expect(shellLine(['go', 'test', '-run', '^(TestA|TestB)$', './x'])).toBe("go test -run '^(TestA|TestB)$' ./x");
		expect(shellLine(['bun', 'test', "it's"])).toBe("bun test 'it'\\''s'");
	});
});

describe('debugging a test', () => {
	test('cargo: lldb on the libtest binary from the build output', () => {
		const made = debugConfig(at('cargo:crates/demo/src/net/http.rs::tests > adds'), '/ws')!;
		expect(made.build).toEqual(['cargo', 'test', '--no-run', '-p', 'demo-crate', '--lib', '--message-format=json']);
		expect(made.config).toMatchObject({ type: 'lldb', request: 'launch', args: ['net::http::tests::adds', '--exact', '--nocapture'], cwd: '/ws/crates/demo' });
		const out = readFileSync(join(import.meta.dir, 'testdata', 'cargo-list.txt'), 'utf8') + '\n{"reason":"compiler-artifact","target":{"kind":["lib"],"name":"demo_crate"},"profile":{"test":true},"executable":"/ws/target/debug/deps/demo_crate-1"}\n{"reason":"build-finished","success":true}';
		expect(cargoTestExecutable(out, 'demo-crate', 'lib')).toBe('/ws/target/debug/deps/demo_crate-1');
		expect(cargoTestExecutable(out, 'demo-crate', 'test:api')).toBeNull();
	});

	test('go, pytest, vitest; bun has no debugger', () => {
		expect(debugConfig(at('go:pkg/math/math_test.go::TestSub'), '/ws')?.config).toMatchObject({ type: 'go', mode: 'test', program: '/ws/pkg/math', args: ['-test.run', '^TestSub$', '-test.v'] });
		expect(debugConfig(at('pytest:tests/test_math.py::TestDiv > test_zero'), '/ws')?.config).toMatchObject({ type: 'debugpy', module: 'pytest', args: ['tests/test_math.py::TestDiv::test_zero', '-q'], cwd: '/ws' });
		expect(debugConfig(at('vitest:web/src/b.test.ts::b'), '/ws')?.config).toMatchObject({ type: 'node', program: '/ws/web/node_modules/vitest/vitest.mjs', args: ['run', 'src/b.test.ts', '-t', '^b$'], cwd: '/ws/web' });
		expect(debugConfig(at('bun:apps/web/src/a.test.ts::math'), '/ws')).toBeNull();
	});
});

describe('the model', () => {
	test('projects group files; states roll up; the test at the cursor; badge and summary', () => {
		expect(tree.map((p) => p.label)).toEqual(['Bun · apps/web', 'Cargo · crates/demo', 'Go', 'pytest', 'Vitest · web']);
		const results = new Map<string, TestResult>([
			['cargo:crates/demo/src/net/http.rs::tests > adds', { state: 'passed', messages: [] }],
			['cargo:crates/demo/src/net/http.rs::tests > subs', { state: 'failed', messages: [{ message: 'x' }] }],
			['go:pkg/math/math_test.go::TestAdd', { state: 'skipped', messages: [] }]
		]);
		expect(stateOf(at('cargo:project:crates/demo'), results)).toBe('failed');
		expect(stateOf(at(go.id), results)).toBe('skipped');
		expect(stateOf(at(bun.id), results)).toBe('unset');
		expect(testAt(tree, 'crates/demo/src/net/http.rs', 14)?.label).toBe('adds');
		expect(testAt(tree, 'crates/demo/src/net/http.rs', 11)?.label).toBe('tests');
		expect(testAt(tree, 'crates/demo/src/net/http.rs', 1)).toBeUndefined();
		expect(countBadge(results, 'failed')).toBe(1);
		expect(countBadge(results, 'passed')).toBe(1);
		expect(countBadge(results, 'off')).toBe(0);
		expect(summary(results)).toEqual({ passed: 1, failed: 1, skipped: 1, total: 3 });
		expect(leaves(at('cargo:project:crates/demo')).map((t: TestItem) => t.label)).toEqual(['adds', 'subs']);
	});
});
