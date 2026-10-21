/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { activeFolder, asksForFolder, folderChoices, folderCwd, terminalFolderName } from './folders.ts';

const app = { path: '/w/app', name: 'app' };
const lib = { path: '/elsewhere/lib', name: 'Library' };
const nested = { path: '/w/app/pkg', name: 'pkg' };

describe('terminal folders', () => {
	test('terminal.integrated.cwd resolves per folder', () => {
		expect(folderCwd(app, '')).toEqual({ folder: app, cwd: '/w/app', overridden: false });
		expect(folderCwd(app, undefined).cwd).toBe('/w/app');
		expect(folderCwd(app, 'src/')).toEqual({ folder: app, cwd: '/w/app/src', overridden: true });
		expect(folderCwd(app, './src').cwd).toBe('/w/app/src');
		expect(folderCwd(app, '.').cwd).toBe('/w/app');
		expect(folderCwd(lib, '/tmp/x/').cwd).toBe('/tmp/x');
	});

	test('the pick only asks when the folders start in different places', () => {
		expect(asksForFolder([app], '')).toBe(false);
		expect(asksForFolder([], '')).toBe(false);
		expect(asksForFolder([app, lib], '')).toBe(true);
		expect(folderChoices([app, lib], 'src').map((c) => c.cwd)).toEqual(['/w/app/src', '/elsewhere/lib/src']);
		// An absolute cwd is the same for every folder: no question.
		expect(asksForFolder([app, lib], '/tmp')).toBe(false);
		expect(folderChoices([app, lib], '/tmp')).toEqual([{ folder: app, cwd: '/tmp', overridden: true }]);
	});

	test('the active editor picks the folder, else the first one', () => {
		expect(activeFolder('src/a.ts', [app, lib])).toBe(app);
		expect(activeFolder('/elsewhere/lib/x.ts', [app, lib])).toBe(lib);
		expect(activeFolder('/w/app/pkg/i.ts', [app, nested])).toBe(nested);
		expect(activeFolder('untitled:1', [app, lib])).toBe(app);
		expect(activeFolder(null, [app, lib])).toBe(app);
		expect(activeFolder('/outside/x', [app, lib])).toBe(app);
		expect(activeFolder(null, [])).toBeNull();
	});

	test('tabs show the folder only in a multi-root window', () => {
		expect(terminalFolderName('/w/app', [app])).toBeNull();
		expect(terminalFolderName('/elsewhere/lib', [app, lib])).toBe('Library');
		expect(terminalFolderName(undefined, [app, lib])).toBe('app');
		expect(terminalFolderName('/gone', [app, lib])).toBeNull();
	});
});
