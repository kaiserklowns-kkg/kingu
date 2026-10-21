/// <reference types="bun" />
// Test discovery from source text and from the runners' listings.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	cargoPackageName,
	goModule,
	goTests,
	isJsTestFile,
	isPythonTestFile,
	jsRunnerFor,
	jsTests,
	maskCode,
	parseCargoList,
	parseGoList,
	parsePytestCollect,
	pytestDeclared,
	pythonTests,
	rustTarget,
	rustTests
} from './discover.ts';
import type { Declared } from './model.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'testdata', name), 'utf8');
const shape = (ds: Declared[]): unknown[] => ds.map((d) => (d.children.length ? [d.name, d.line, shape(d.children)] : [d.name, d.line]));

describe('JavaScript / TypeScript', () => {
	test('describe/test/it nesting with lines; modifiers and each; strings and comments are not code', () => {
		const text = `import { describe, expect, test } from 'bun:test';
describe('math', () => {
  test('adds', () => {});
  it.skip("skips", () => {});
  describe.only(\`inner\`, () => {
    test.each([[1, 2]])('pairs %d', () => {});
  });
  // test('commented out', () => {})
  const s = "test('in a string', () => {})";
});
test('top (with parens) and "quotes"', async () => { expect(f('x')).toBe(1); });
test(name, () => {});
test(\`dynamic \${x}\`, () => {});
`;
		expect(shape(jsTests(text))).toEqual([
			['math', 2, [['adds', 3], ['skips', 4], ['inner', 5, [['pairs %d', 6]]]]],
			['top (with parens) and "quotes"', 11]
		]);
	});

	test('test files and which runner runs them', () => {
		expect(['src/a.test.ts', 'a.spec.jsx', 'lib/x_test.mjs', '__tests__/y.js', 'src/a.ts', 'node_modules/p/a.test.js'].map(isJsTestFile)).toEqual([true, true, true, true, false, false]);
		expect(jsRunnerFor("import { test } from 'bun:test'", '{"devDependencies":{"vitest":"1"}}', false)).toBe('bun');
		expect(jsRunnerFor("import { it } from 'vitest'", null, true)).toBe('vitest');
		expect(jsRunnerFor('test("a", () => {})', '{"devDependencies":{"jest":"29"}}', false)).toBe('jest');
		expect(jsRunnerFor('test("a", () => {})', '{"scripts":{"test":"vitest run"}}', false)).toBe('vitest');
		expect(jsRunnerFor('test("a", () => {})', '{}', true)).toBe('bun');
		expect(jsRunnerFor('test("a", () => {})', 'not json', false)).toBeNull();
	});
});

describe('Rust', () => {
	test('#[test] functions with their module path; #[cfg(test)], strings, raw strings and lifetimes are not tests', () => {
		const text = `fn helper<'a>(s: &'a str) -> char { 'x' }
#[cfg(test)]
mod tests {
    use super::*;
    const S: &str = "#[test] fn fake() {}";
    const R: &str = r#"mod nope { #[test] fn raw() {} }"#;

    #[test]
    fn adds() { assert_eq!(1, 1); }

    #[test]
    #[ignore = "slow"]
    fn slow() {}

    mod nested {
        #[tokio::test(flavor = "multi_thread")]
        async fn async_one() {}
    }

    fn not_a_test() {}
}

#[rstest]
fn top() {}
`;
		expect(rustTests(text)).toEqual([
			{ path: ['tests', 'adds'], line: 9, ignored: false },
			{ path: ['tests', 'slow'], line: 13, ignored: true },
			{ path: ['tests', 'nested', 'async_one'], line: 17, ignored: false },
			{ path: ['top'], line: 24, ignored: false }
		]);
	});

	test('targets and module paths inside the crate', () => {
		expect(rustTarget('src/lib.rs', true, 'app')).toEqual({ target: 'lib', prefix: [] });
		expect(rustTarget('src/main.rs', true, 'app')).toEqual({ target: 'bin:app', prefix: [] });
		expect(rustTarget('src/net/http.rs', true, 'app')).toEqual({ target: 'lib', prefix: ['net', 'http'] });
		expect(rustTarget('src/net/mod.rs', false, 'app')).toEqual({ target: 'bin:app', prefix: ['net'] });
		expect(rustTarget('src/bin/tool.rs', true, 'app')).toEqual({ target: 'bin:tool', prefix: [] });
		expect(rustTarget('tests/api.rs', true, 'app')).toEqual({ target: 'test:api', prefix: [] });
		expect(rustTarget('tests/common/mod.rs', true, 'app')).toBeNull();
		expect(rustTarget('benches/b.rs', true, 'app')).toBeNull();
		expect(cargoPackageName('[workspace]\nmembers = ["a"]\n')).toBeNull();
		expect(cargoPackageName('[package]\nname = "kingu-desktop"\n[lib]\nname = "kingu_lib"\n')).toBe('kingu-desktop');
	});

	test('cargo test -- --list', () => {
		expect(parseCargoList(fixture('cargo-list.txt'))).toEqual([{ crate: 'demo_crate', source: 'src/lib.rs', tests: ['tests::adds', 'tests::fails', 'tests::panics', 'tests::slow'] }]);
	});
});

describe('Go', () => {
	test('TestXxx, FuzzXxx and ExampleXxx functions; Testify is not a test', () => {
		const text = 'package demo\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {}\n\nfunc Testify() {}\n\nfunc TestÜber(t *testing.T) {}\n// func TestCommented(t *testing.T) {}\nfunc FuzzParse(f *testing.F) {}\nfunc ExampleHello() {}\nfunc helper() {}\nfunc Test(t *testing.T) {}\n';
		expect(shape(goTests(text))).toEqual([['TestAdd', 5], ['TestÜber', 9], ['FuzzParse', 11], ['ExampleHello', 12], ['Test', 14]]);
		expect(goModule('// x\nmodule example.com/demo\n\ngo 1.22\n')).toBe('example.com/demo');
	});

	test('go test -list . ./...', () => {
		expect([...parseGoList(fixture('go-list.txt'))]).toEqual([['example.com/demo', ['TestAdd', 'TestSub', 'TestSkip', 'TestTable']]]);
	});
});

describe('pytest', () => {
	const text = `import pytest

def test_add():
    assert 1 + 1 == 2

class TestDiv:
    def test_zero(self):
        1 / 0

    def helper(self): pass

@pytest.mark.parametrize("a,b", [(1, 2), (2, 3)])
def test_param(a, b):
    """test_not_this() in a docstring"""
    assert a < b

def helper(): pass
`;
	test('test functions and Test classes from the text', () => {
		expect(shape(pythonTests(text))).toEqual([['test_add', 3], ['TestDiv', 6, [['test_zero', 7]]], ['test_param', 13]]);
		expect(['tests/test_a.py', 'a_test.py', 'tests/conftest.py', 'test.py'].map(isPythonTestFile)).toEqual([true, true, false, false]);
	});

	test('--collect-only -q node ids as a tree, with lines from the text', () => {
		const out = 'tests/test_math.py::test_add\ntests/test_math.py::TestDiv::test_zero\ntests/test_math.py::test_param[1-2]\ntests/test_math.py::test_param[2-3]\n\n4 tests collected in 0.01s\n';
		const ids = parsePytestCollect(out);
		expect(ids).toHaveLength(4);
		expect(shape(pytestDeclared(ids, text))).toEqual([
			['test_add', 3],
			['TestDiv', 6, [['test_zero', 7]]],
			['test_param', 13, [['test_param[1-2]', 13], ['test_param[2-3]', 13]]]
		]);
	});
});

test('masking keeps positions and lines', () => {
	const js = 'a("x(y)") // c(\n/* d( */ b';
	const masked = maskCode(js, 'js');
	expect(masked.length).toBe(js.length);
	expect(masked.split('\n').length).toBe(2);
	expect(masked).toBe('a("xxxx")      \n         b');
	expect(maskCode("let c = '{'; // }", 'rust')).toBe("let c = 'x';     ");
	expect(maskCode('x = "#" # y', 'python')).toBe('x = "x"    ');
});
