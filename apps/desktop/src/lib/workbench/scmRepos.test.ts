/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { detectOptions, entryKey, keyedStatus, relInRepo, repoLabel, repositoryOf, sortRepositories, visibleRepositories, type RepoInfo } from './scmRepos';
import type { GitStatus } from './scm';

const folders = [
	{ path: '/w/app', name: 'app' },
	{ path: '/w/lib', name: 'Library' }
];
const info = (dir: string, folder: string, kind: RepoInfo['kind'] = 'folder', toplevel = dir): RepoInfo => ({ dir, folder, toplevel, kind });

describe('repository paths', () => {
	test('status paths become workspace paths and back', () => {
		expect(entryKey('/w/app', 'src/a.ts', folders)).toBe('src/a.ts');
		expect(entryKey('/w/app/packages/ui', 'b.ts', folders)).toBe('packages/ui/b.ts');
		expect(entryKey('/w/lib', 'c.ts', folders)).toBe('/w/lib/c.ts');
		// A parent repository's file outside every folder keeps its absolute path.
		expect(entryKey('/w', 'README.md', folders)).toBe('/w/README.md');
		expect(relInRepo('/w/app', 'src/a.ts', folders)).toBe('src/a.ts');
		expect(relInRepo('/w/app/packages/ui', 'packages/ui/b.ts', folders)).toBe('b.ts');
		expect(relInRepo('/w/lib', '/w/lib/c.ts', folders)).toBe('c.ts');
		expect(relInRepo('/w/lib', 'src/a.ts', folders)).toBeNull();
		expect(relInRepo('/w/app', '/w/application/x.ts', folders)).toBeNull();
	});

	test('a status read is keyed with its rename sources', () => {
		const read: GitStatus = {
			branch: 'main',
			head: 'abc',
			upstream: null,
			ahead: 0,
			behind: 0,
			detached: false,
			upstream_gone: false,
			remotes: [],
			entries: [{ path: 'new.ts', orig_path: 'old.ts', index: 'R', worktree: null, conflict: false }]
		};
		const keyed = keyedStatus(read, '/w/lib', folders);
		expect(keyed.entries[0]).toMatchObject({ path: '/w/lib/new.ts', orig_path: '/w/lib/old.ts' });
		expect(keyed.branch).toBe('main');
		expect(read.entries[0].path).toBe('new.ts');
	});

	test('a file belongs to the innermost repository', () => {
		const repos = [info('/w/app', '/w/app'), info('/w/app/packages/ui', '/w/app', 'nested'), info('/w/lib', '/w/lib')];
		expect(repositoryOf('src/a.ts', repos, folders)?.dir).toBe('/w/app');
		expect(repositoryOf('packages/ui/x.ts', repos, folders)?.dir).toBe('/w/app/packages/ui');
		expect(repositoryOf('/w/lib/x.ts', repos, folders)?.dir).toBe('/w/lib');
		expect(repositoryOf('/elsewhere/x.ts', repos, folders)).toBeNull();
		expect(repositoryOf('a.ts', repos, [])).toBeNull();
	});
});

describe('Repositories view', () => {
	test('labels name the repository and where it is', () => {
		expect(repoLabel(info('/w/lib', '/w/lib'), folders)).toEqual({ name: 'Library', description: '' });
		expect(repoLabel(info('/w/app/packages/ui', '/w/app', 'nested'), folders)).toEqual({ name: 'ui', description: 'app/packages' });
		expect(repoLabel(info('/w/app/ui', '/w/app', 'nested'), [folders[0]])).toEqual({ name: 'ui', description: '' });
		expect(repoLabel(info('/w/app', '/w/app', 'parent', '/w'), folders)).toEqual({ name: 'app', description: 'w' });
	});

	test('scm.repositories.sortOrder', () => {
		const repos = [
			{ info: info('/w/b', '/w/b'), label: { name: 'zeta' } },
			{ info: info('/w/a', '/w/a'), label: { name: 'alpha' } }
		];
		expect(sortRepositories(repos, 'discovery time').map((r) => r.label.name)).toEqual(['zeta', 'alpha']);
		expect(sortRepositories(repos, 'name').map((r) => r.label.name)).toEqual(['alpha', 'zeta']);
		expect(sortRepositories(repos, 'path').map((r) => r.info.dir)).toEqual(['/w/a', '/w/b']);
	});

	test('which repositories the Source Control view shows', () => {
		const repos = ['/a', '/b', '/c'].map((d) => ({ info: info(d, d) }));
		const dirs = (list: { info: RepoInfo }[]) => list.map((r) => r.info.dir);
		expect(dirs(visibleRepositories(repos, [], 'multiple', 10))).toEqual(['/a', '/b', '/c']);
		expect(dirs(visibleRepositories(repos, [], 'multiple', 2))).toEqual(['/a', '/b']);
		expect(dirs(visibleRepositories(repos, ['/c', '/a'], 'multiple', 10))).toEqual(['/a', '/c']);
		expect(dirs(visibleRepositories(repos, ['/c', '/b'], 'single', 10))).toEqual(['/b']);
		expect(dirs(visibleRepositories(repos, [], 'single', 10))).toEqual(['/a']);
		// A picked repository that went away falls back to the default.
		expect(dirs(visibleRepositories(repos, ['/gone'], 'multiple', 1))).toEqual(['/a']);
	});

	test('detection options carry the git.* settings', () => {
		const values: Record<string, unknown> = {
			'git.autoRepositoryDetection': 'subFolders',
			'git.repositoryScanMaxDepth': 2,
			'git.repositoryScanIgnoredFolders': ['node_modules'],
			'git.scanRepositories': ['vendor'],
			'git.ignoredRepositories': [],
			'git.openRepositoryInParentFolders': 'never'
		};
		const get = <T>(id: string) => values[id] as T;
		expect(detectOptions(get, { allowedParents: ['/w'], openEditors: ['a.ts'] })).toEqual({
			autoRepositoryDetection: 'subFolders',
			repositoryScanMaxDepth: 2,
			repositoryScanIgnoredFolders: ['node_modules'],
			scanRepositories: ['vendor'],
			ignoredRepositories: [],
			openRepositoryInParentFolders: 'never',
			allowedParents: ['/w'],
			openEditors: ['a.ts']
		});
	});
});
