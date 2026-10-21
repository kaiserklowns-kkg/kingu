/// <reference types="bun" />
// Language servers per root folder: which session serves a file, the folder of a resource
// (`workspace/configuration` scopeUri), and how the Problems panel names files of each folder.
import { describe, expect, test } from 'bun:test';
import { folderOfUri, folderPathOf, parseSessionId, problemLabel, sessionFolder, sessionId } from './folders';

const FOLDERS = [
	{ path: '/w/app', name: 'app' },
	{ path: '/w/my lib', name: 'Lib' },
	{ path: '/w/app/pkg', name: 'pkg' }
];

describe('sessions per folder', () => {
	test('session ids round-trip', () => {
		expect(sessionId('rust', null)).toBe('rust');
		expect(parseSessionId(sessionId('rust', null))).toEqual({ key: 'rust', folder: null });
		expect(parseSessionId(sessionId('go', '/w/my lib'))).toEqual({ key: 'go', folder: '/w/my lib' });
	});

	test('a server that takes several folders serves them all', () => {
		expect(sessionFolder('/w/my lib', FOLDERS, true)).toBeNull();
	});

	test('one that cannot gets a server per folder, except for the first and for per-file servers', () => {
		expect(sessionFolder('/w/my lib', FOLDERS, false)).toBe('/w/my lib');
		expect(sessionFolder('/w/app/pkg', FOLDERS, false)).toBe('/w/app/pkg');
		expect(sessionFolder('/w/app', FOLDERS, false)).toBeNull();
		expect(sessionFolder('/w/my lib', FOLDERS, false, true)).toBeNull();
		// Outside every folder, or a single-folder window: the shared server.
		expect(sessionFolder(null, FOLDERS, false)).toBeNull();
		expect(sessionFolder('/w/app', FOLDERS.slice(0, 1), false)).toBeNull();
	});

	test('the folder of a workbench key', () => {
		expect(folderPathOf('src/a.ts', FOLDERS)).toBe('/w/app');
		expect(folderPathOf('/w/my lib/b.ts', FOLDERS)).toBe('/w/my lib');
		expect(folderPathOf('/w/app/pkg/c.ts', FOLDERS)).toBe('/w/app/pkg');
		expect(folderPathOf('/elsewhere/x.ts', FOLDERS)).toBeNull();
	});
});

describe('the folder of a resource', () => {
	test('the innermost root folder holding the URI', () => {
		expect(folderOfUri('file:///w/my%20lib/src/b.ts', FOLDERS)?.name).toBe('Lib');
		expect(folderOfUri('file:///w/app/pkg/c.ts', FOLDERS)?.name).toBe('pkg');
		expect(folderOfUri('file:///w/app/a.ts', FOLDERS)?.name).toBe('app');
		expect(folderOfUri('file:///w/app', FOLDERS)?.name).toBe('app');
		expect(folderOfUri('file:///elsewhere/x.ts', FOLDERS)).toBeNull();
		expect(folderOfUri(undefined, FOLDERS)).toBeNull();
	});
});

describe('Problems labels', () => {
	test('relative to the file’s own folder, led by its name in a multi-root window', () => {
		expect(problemLabel('src/a.ts', '/w/app/src/a.ts', FOLDERS)).toEqual({ label: 'src/a.ts', detail: 'app • src' });
		expect(problemLabel('/w/my lib/b.ts', '/w/my lib/b.ts', FOLDERS)).toEqual({ label: 'b.ts', detail: 'Lib' });
		expect(problemLabel('/w/app/pkg/x/c.ts', '/w/app/pkg/x/c.ts', FOLDERS)).toEqual({ label: 'x/c.ts', detail: 'pkg • x' });
	});

	test('a single folder shows the directory; a file outside shows its absolute path', () => {
		expect(problemLabel('src/a.ts', '/w/app/src/a.ts', FOLDERS.slice(0, 1))).toEqual({ label: 'src/a.ts', detail: 'src' });
		expect(problemLabel(null, '/tmp/c.ts', FOLDERS)).toEqual({ label: '/tmp/c.ts', detail: '/tmp' });
	});
});
