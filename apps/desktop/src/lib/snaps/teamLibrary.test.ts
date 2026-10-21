/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { isPublishable, libraryStatus, libraryUpdates, librarySnaps, publishSummary, versionRow, type LibraryVersion } from './teamLibrary';
import type { SnapInfo } from './snapModel';

beforeAll(() => setLocale('en'));
afterAll(() => setLocale('en'));

const SERVER = 'https://team.example';

function v(version: string, over: Partial<LibraryVersion> = {}): LibraryVersion {
	return {
		snap_id: 'go',
		version,
		name: 'Go',
		description: '',
		sha256: 'a'.repeat(64),
		package_sha256: 'b'.repeat(64),
		package_size: 10,
		permissions: {},
		published_by: 'olive',
		published_at: '2026-10-20T10:00:00Z',
		yanked: false,
		yank_reason: null,
		...over
	};
}

function installed(version: string, server: string | null = SERVER): SnapInfo {
	return {
		id: 'go',
		name: 'Go',
		version,
		description: '',
		source: 'user',
		dir: '/c/snaps/go',
		trusted: true,
		error: null,
		overridden: false,
		hash: 'h',
		permissions: { network: false, fs: 'worktree', secrets: ['GO_TOKEN'] },
		tasks: [],
		settings: [],
		mcp: [],
		skills: [],
		scripts: [],
		origin: server ? { url: null, ref: null, commit: null, path: null, team: { server, version }, installed_at: 1 } : null,
		lock: null,
		approved_permissions: null
	};
}

describe('team library', () => {
	const items = [v('2.0.0', { yanked: true, yank_reason: 'broken' }), v('1.1.0'), v('1.0.0'), v('0.1.0', { snap_id: 'alpha', name: 'Alpha' })];

	test('groups by snap; the newest version that is not yanked is the one to install', () => {
		const snaps = librarySnaps(items);
		expect(snaps.map((s) => [s.id, s.latest?.version, s.versions.length])).toEqual([
			['alpha', '0.1.0', 1],
			['go', '1.1.0', 3]
		]);
		expect(librarySnaps([v('1', { yanked: true })])[0].latest).toBeNull();
	});

	test('status against what is installed here', () => {
		const go = librarySnaps(items)[1];
		expect(libraryStatus(go, [], SERVER).key).toBe('missing');
		expect(libraryStatus(go, [installed('1.1.0')], SERVER).key).toBe('current');
		expect(libraryStatus(go, [installed('1.0.0')], SERVER)).toEqual({ key: 'update', label: 'Update to v1.1.0', tone: 'warn' });
		expect(libraryStatus(go, [installed('2.0.0')], SERVER).key).toBe('yanked');
		expect(libraryStatus(go, [installed('1.0.0', null)], SERVER).key).toBe('other');
		expect(libraryStatus(go, [installed('1.0.0', 'https://other')], SERVER).key).toBe('other');
		expect(libraryUpdates(librarySnaps(items), [installed('1.0.0')], SERVER).map((s) => s.id)).toEqual(['go']);
	});

	test('publishing: versions the server accepts, not already published', () => {
		expect(isPublishable(installed('1.2.0'), items)).toBe(true);
		expect(isPublishable(installed('1.1.0'), items)).toBe(false);
		expect(isPublishable(installed('1 beta'), items)).toBe(false);
		expect(isPublishable({ ...installed('3'), error: 'bad' }, items)).toBe(false);
		const text = publishSummary({ ...installed('1.2.0'), scripts: [{ path: 'scripts/ci.sh', sha256: 'x' }] });
		expect(text).toContain('Go (go) v1.2.0');
		expect(text).toContain('Secrets: GO_TOKEN');
		expect(text).toContain('no secret values');
		expect(text).toContain('not in it: scripts/ci.sh');
	});

	test('version rows', () => {
		expect(versionRow(items[0])).toEqual({ id: '2.0.0', label: 'v2.0.0', description: 'yanked: broken' });
		expect(versionRow(items[1]).description).toBe('by olive, 2026-10-20');
	});
});
