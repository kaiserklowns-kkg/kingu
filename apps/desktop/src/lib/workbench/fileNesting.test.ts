import { describe, expect, test } from 'bun:test';
import { nestFiles } from './fileNesting';

// VS Code's explorer.fileNesting.patterns default.
const DEFAULTS = {
	'*.ts': '${capture}.js',
	'*.js': '${capture}.js.map, ${capture}.min.js, ${capture}.d.ts',
	'*.jsx': '${capture}.js',
	'*.tsx': '${capture}.ts',
	'tsconfig.json': 'tsconfig.*.json',
	'package.json': 'package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb, bun.lock'
};

const nest = (names: string[], patterns: Record<string, string> = DEFAULTS, caseSensitive = true) =>
	Object.fromEntries([...nestFiles(names, 'src', patterns, caseSensitive)].map(([k, v]) => [k, [...v].sort()]));

describe('explorer.fileNesting', () => {
	test('VS Code defaults: flattened to the root parent', () => {
		expect(nest(['a.ts', 'a.js', 'a.js.map', 'a.d.ts', 'b.ts', 'package.json', 'bun.lock', 'tsconfig.json', 'tsconfig.app.json', 'README.md'])).toEqual({
			'a.ts': ['a.d.ts', 'a.js', 'a.js.map'],
			'package.json': ['bun.lock'],
			'tsconfig.json': ['tsconfig.app.json']
		});
	});

	test('VS Code trie example', () => {
		const patterns = { '*.ts': '${capture}.*.ts, ${capture}.js', '*.js': '${capture}.min.js' };
		expect(nest(['a.ts', 'a.d.ts', 'a.js', 'a.min.js', 'b.ts', 'b.min.js'], patterns)).toEqual({ 'a.ts': ['a.d.ts', 'a.js', 'a.min.js'] });
	});

	test('basename, extname and dirname substitutions; a file never nests under itself', () => {
		expect(nest(['index.ts', 'index.test.ts', 'src.md'], { '*.ts': '${basename}.*.${extname}', '*.md': '${dirname}.md' })).toEqual({ 'index.ts': ['index.test.ts'] });
	});

	test('case-insensitive on case-insensitive file systems', () => {
		expect(nest(['A.ts', 'a.JS'], DEFAULTS, false)).toEqual({ 'A.ts': ['a.JS'] });
		expect(nest(['A.ts', 'a.JS'], DEFAULTS, true)).toEqual({});
	});

	test('empty and non-string patterns are ignored', () => {
		expect(nest(['a.ts', 'a.js'], { '*.ts': '', '': 'x', '*.js': 1 } as unknown as Record<string, string>)).toEqual({});
	});
});
