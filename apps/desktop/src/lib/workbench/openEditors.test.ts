/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { openEditorsState, parseOpenEditors, readmeOf } from './openEditors';

describe('open editors per folder', () => {
	test('keeps workspace files only, deduplicated across groups', () => {
		const tabs = [{ path: 'src/a.ts' }, { path: 'diff:src/a.ts' }, { path: 'settings://' }, { path: 'task://fix' }, { path: 'src/a.ts' }, { path: 'README.md' }];
		expect(openEditorsState(tabs, 'src/a.ts')).toEqual({ paths: ['src/a.ts', 'README.md'], active: 'src/a.ts' });
		expect(openEditorsState(tabs, 'diff:src/a.ts').active).toBe('README.md');
		expect(openEditorsState([], null)).toEqual({ paths: [], active: null });
	});

	test('parsing vets what came from storage', () => {
		expect(parseOpenEditors({ paths: ['a.ts', 'settings://user/settings.json'], active: 'a.ts' })).toEqual({ paths: ['a.ts'], active: 'a.ts' });
		expect(parseOpenEditors({ paths: ['a.ts'], active: 'gone.ts' })).toEqual({ paths: ['a.ts'], active: 'a.ts' });
		expect(parseOpenEditors({ paths: [1] })).toBeNull();
		expect(parseOpenEditors('x')).toBeNull();
	});

	test('workbench.startupEditor readme', () => {
		expect(readmeOf(['package.json', 'README.md', 'readme.txt'])).toBe('README.md');
		expect(readmeOf(['Readme'])).toBe('Readme');
		expect(readmeOf(['index.ts'])).toBeNull();
	});
});
