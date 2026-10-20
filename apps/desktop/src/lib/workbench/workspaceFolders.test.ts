import { describe, expect, test } from 'bun:test';
import { absolutePath, folderNamed, folderOf, keyForPath, relativeInFolder, relativePath, watcherPaths, within, workspaceFileText, workspaceLabel, type WorkspaceFolder } from './workspaceFolders.ts';
import { parseCodeWorkspace } from './workspaceFile.ts';

const app: WorkspaceFolder = { path: '/w/app', name: 'app' };
const lib: WorkspaceFolder = { path: '/w/lib', name: 'Library' };
const nested: WorkspaceFolder = { path: '/w/app/packages/ui', name: 'ui' };
const folders = [app, lib];

describe('workbench paths in a multi-root workspace', () => {
	test('relative paths are the first folder’s, absolute ones the folder holding them', () => {
		expect(folderOf('src/a.ts', folders)).toBe(app);
		expect(folderOf('/w/lib/src/b.ts', folders)).toBe(lib);
		expect(folderOf('/w/lib', folders)).toBe(lib);
		expect(folderOf('/w/library/x', folders)).toBeNull();
		expect(folderOf('a', [])).toBeNull();
		// A root folder nested in another: the innermost holds the file.
		expect(folderOf('/w/app/packages/ui/x.ts', [app, nested])).toBe(nested);
	});

	test('keys for absolute paths, and back', () => {
		expect(keyForPath('/w/app/src/a.ts', folders)).toBe('src/a.ts');
		expect(keyForPath('/w/app', folders)).toBe('');
		expect(keyForPath('/w/lib/src/b.ts', folders)).toBe('/w/lib/src/b.ts');
		expect(keyForPath('/elsewhere/c.ts', folders)).toBeNull();
		expect(absolutePath('src/a.ts', folders)).toBe('/w/app/src/a.ts');
		expect(absolutePath('', folders)).toBe('/w/app');
		expect(absolutePath('/w/lib/b.ts', folders)).toBe('/w/lib/b.ts');
		expect(absolutePath('a', [])).toBeNull();
		expect(relativeInFolder('/w/lib/src/b.ts', folders)).toBe('src/b.ts');
		expect(relativeInFolder('src/a.ts', folders)).toBe('src/a.ts');
		expect(relativeInFolder('/w/lib', folders)).toBe('');
		expect(within('/w/lib/x', '/w/lib/')).toBe(true);
		expect(within('/w/libx', '/w/lib')).toBe(false);
	});

	test('watcher batches become workbench paths', () => {
		expect(watcherPaths('/w/app', ['src/a.ts', ''], folders)).toEqual(['src/a.ts', '']);
		expect(watcherPaths('/w/lib', ['src/b.ts', ''], folders)).toEqual(['/w/lib/src/b.ts', '/w/lib']);
		// An old batch of a folder no longer in the workspace.
		expect(watcherPaths('/w/gone', ['x'], folders)).toBeNull();
	});

	test('${workspaceFolder:name} finds a folder by its name or folder name', () => {
		expect(folderNamed('Library', folders)).toBe(lib);
		expect(folderNamed('lib', folders)).toBe(lib);
		expect(folderNamed('app', folders)).toBe(app);
		expect(folderNamed('nope', folders)).toBeNull();
	});
});

describe('.code-workspace files', () => {
	test('folders are written relative to the file, names only when they differ', () => {
		expect(relativePath('/w/app', '/w')).toBe('app');
		expect(relativePath('/w/lib', '/w/app')).toBe('../lib');
		expect(relativePath('/w', '/w')).toBe('.');
		expect(relativePath('/other/x', '/w')).toBe('/other/x');
		const text = workspaceFileText(folders, { 'editor.tabSize': 2 }, '/w/team.code-workspace');
		expect(JSON.parse(text)).toEqual({ folders: [{ path: 'app' }, { name: 'Library', path: 'lib' }], settings: { 'editor.tabSize': 2 } });
		expect(JSON.parse(workspaceFileText(folders, {}, null)).folders).toEqual([{ path: '/w/app' }, { name: 'Library', path: '/w/lib' }]);
		// What is written reads back as the same folders.
		expect(parseCodeWorkspace(text, '/w/team.code-workspace').folders).toEqual(folders);
	});

	test('the title names the folder, the workspace file, or an untitled workspace', () => {
		const suffix = (n: string) => `${n} (Workspace)`;
		expect(workspaceLabel([app], null, false, suffix, 'Untitled (Workspace)')).toBe('app');
		expect(workspaceLabel(folders, null, true, suffix, 'Untitled (Workspace)')).toBe('Untitled (Workspace)');
		expect(workspaceLabel(folders, '/w/team.code-workspace', false, suffix, 'Untitled (Workspace)')).toBe('team (Workspace)');
		expect(workspaceLabel([], null, false, suffix, 'U')).toBe('');
	});
});
