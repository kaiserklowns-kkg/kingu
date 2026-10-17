import { describe, expect, test } from 'bun:test';
import { affectedBy, baseName, dirsToRefresh, isUnder, joinRel, parentOf, recentLabel, remapPath, stemLength, validateName, workspaceFiles } from './fileTree';

describe('paths', () => {
	test('parent, base and join', () => {
		expect(parentOf('a/b/c.ts')).toBe('a/b');
		expect(parentOf('c.ts')).toBe('');
		expect(baseName('a/b/c.ts')).toBe('c.ts');
		expect(joinRel('', 'x')).toBe('x');
		expect(joinRel('a/b', 'x')).toBe('a/b/x');
	});

	test('isUnder matches whole segments', () => {
		expect(isUnder('src/a.ts', 'src')).toBe(true);
		expect(isUnder('src', 'src')).toBe(true);
		expect(isUnder('srcs/a.ts', 'src')).toBe(false);
		expect(isUnder('anything', '')).toBe(true);
	});
});

describe('validateName', () => {
	test('accepts names and nested paths', () => {
		expect(validateName('a.ts')).toBeNull();
		expect(validateName('lib/util/a.ts')).toBeNull();
		expect(validateName('.gitignore')).toBeNull();
		expect(validateName('ไฟล์ไทย.md')).toBeNull();
	});

	test('rejects empty, dot segments and absolute paths', () => {
		for (const bad of ['', '   ', ' a', 'a ', '/abs', 'a//b', 'a/', '..', '../x', 'a/./b', 'a\\b']) {
			expect(validateName(bad)).not.toBeNull();
		}
	});
});

describe('remapPath', () => {
	test('moves files and diff tabs under a renamed folder', () => {
		expect(remapPath('src/a.ts', 'src/a.ts', 'src/b.ts')).toBe('src/b.ts');
		expect(remapPath('src/lib/a.ts', 'src', 'app')).toBe('app/lib/a.ts');
		expect(remapPath('diff:src/a.ts', 'src', 'app')).toBe('diff:app/a.ts');
		expect(remapPath('srcs/a.ts', 'src', 'app')).toBeNull();
		expect(remapPath('a.ts', '', 'x')).toBeNull();
	});

	test('affectedBy finds tabs under a deleted path', () => {
		expect(affectedBy(['src/a.ts', 'diff:src/b.ts', 'srcs/c.ts', 'README.md'], 'src')).toEqual(['src/a.ts', 'diff:src/b.ts']);
		expect(affectedBy(['a'], '')).toEqual([]);
	});
});

describe('watcher batches', () => {
	test('refreshes loaded parents and changed loaded folders only', () => {
		const loaded = ['', 'src', 'src/lib'];
		expect(dirsToRefresh(['src/a.ts', 'src/lib/b.ts', 'docs/x.md'], loaded)).toEqual(['src', 'src/lib']);
		expect(dirsToRefresh(['README.md'], loaded)).toEqual(['']);
		expect(dirsToRefresh(['src/lib'], loaded)).toEqual(['src', 'src/lib']);
		expect(dirsToRefresh([''], loaded)).toEqual(['', 'src', 'src/lib']);
		expect(dirsToRefresh(['other/deep/file'], loaded)).toEqual([]);
	});

	test('git internals only matter to Source Control', () => {
		expect(workspaceFiles(['.git/index', '.git', 'src/a.ts', '.github/ci.yml'])).toEqual(['src/a.ts', '.github/ci.yml']);
	});
});

describe('labels', () => {
	test('recent folders show the parent with ~', () => {
		expect(recentLabel('/Users/me/code/kingu', '/Users/me')).toEqual({ label: 'kingu', detail: '~/code' });
		expect(recentLabel('/srv/app', '/Users/me')).toEqual({ label: 'app', detail: '/srv' });
		expect(recentLabel('/top')).toEqual({ label: 'top', detail: '/' });
	});

	test('rename preselects the stem', () => {
		expect(stemLength('main.test.ts', false)).toBe(9);
		expect(stemLength('.gitignore', false)).toBe(10);
		expect(stemLength('Makefile', false)).toBe(8);
		expect(stemLength('src.v2', true)).toBe(6);
	});
});
