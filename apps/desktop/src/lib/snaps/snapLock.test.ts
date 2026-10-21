/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { lockNote, lockReportText, permissionDiff, permissionLines, permissionsGrew, trustSummary, type LockReport, type SnapInfo, type SnapPermissions } from './snapModel';

beforeAll(() => setLocale('en'));
afterAll(() => setLocale('en'));

const base: SnapPermissions = { network: false, fs: 'worktree', secrets: [] };

function snap(over: Partial<SnapInfo> = {}): SnapInfo {
	return {
		id: 'ci',
		name: 'CI',
		version: '1',
		description: '',
		source: 'repo',
		dir: '/r/.kingu/snaps/ci',
		trusted: false,
		error: null,
		overridden: false,
		hash: 'h',
		permissions: base,
		tasks: [{ id: 't', title: 'Test', command: ['bash', 'scripts/ci.sh'] }],
		settings: [],
		mcp: [],
		skills: [],
		scripts: [{ path: 'scripts/ci.sh', sha256: 'a'.repeat(64) }],
		origin: null,
		lock: null,
		approved_permissions: null,
		...over
	};
}

describe('permission scopes', () => {
	test('lines name each narrowing list', () => {
		const lines = permissionLines({ ...base, network: true, hosts: ['api.github.com'], read: ['~/.cargo'], write: ['~/.cache/go'], processes: ['go'], env: ['GOPATH'] });
		expect(lines).toContain('Network: only api.github.com');
		expect(lines).toContain('Reads in the home folder: only ~/.cargo');
		expect(lines).toContain('Also writes: ~/.cache/go');
		expect(lines).toContain('Programs it may start: go');
		expect(lines).toContain('Environment variables: GOPATH');
	});

	test('dropping an allow-list widens, adding to it widens, narrowing does not', () => {
		const narrow: SnapPermissions = { ...base, network: true, hosts: ['a.com'], processes: ['go'] };
		expect(permissionDiff(narrow, { ...narrow, hosts: [] }).added).toEqual(['Reaches any host (the host list is gone)']);
		expect(permissionDiff(narrow, { ...narrow, hosts: ['a.com', 'b.com'] }).added).toEqual(['Reaches b.com']);
		expect(permissionDiff(narrow, { ...narrow, processes: [] }).added).toEqual(['Starts any program (the program list is gone)']);
		expect(permissionDiff({ ...base, network: true }, narrow).added).toEqual([]);
		expect(permissionDiff(base, { ...base, write: ['/opt/x'] }).added).toEqual(['Writes /opt/x']);
		expect(permissionsGrew(narrow, { ...narrow, env: [] })).toBe(false);
		expect(permissionsGrew(null, { ...base, network: true })).toBe(false);
		expect(permissionsGrew(base, { ...base, network: true })).toBe(true);
	});
});

describe('trust and the lock', () => {
	test('the trust prompt calls out a lock mismatch, grown permissions and pinned scripts', () => {
		const text = trustSummary(snap({ lock: 'changed', approved_permissions: base, permissions: { ...base, network: true } }));
		expect(text).toContain('differs from the version pinned in .kingu/snaps.lock');
		expect(text).toContain('It asks for more than you approved last time:\n• Uses the network');
		expect(text).toContain('pinned too: scripts/ci.sh');
		expect(trustSummary(snap())).not.toContain('more than you approved');
	});

	test('lock notes', () => {
		expect(lockNote(snap({ lock: 'changed' }))).toBe('differs from snaps.lock — approve again');
		expect(lockNote(snap({ source: 'user', lock: 'changed' }))).toBe('not the team version snaps.lock pins');
		expect(lockNote(snap({ lock: 'locked' }))).toBeNull();
	});

	test('verify report text', () => {
		const rows: LockReport[] = [
			{ id: 'ci', source: 'repo', status: 'changed', lockedVersion: '1', version: '2', files: ['snap.toml'], scripts: ['scripts/ci.sh'], lockedPermissions: base, permissions: { ...base, network: true } },
			{ id: 'go', source: 'team', status: 'missing', lockedVersion: '3', version: null, files: [], scripts: [], lockedPermissions: null, permissions: null },
			{ id: 'ok', source: 'repo', status: 'locked', lockedVersion: '1', version: '1', files: [], scripts: [], lockedPermissions: base, permissions: base }
		];
		expect(lockReportText(rows).split('\n')).toEqual([
			'✗ ci v1 → v2: differs',
			'    snap.toml',
			'    repo file scripts/ci.sh',
			'    + Uses the network',
			'✗ go (team library) v3: pinned but not here',
			'✓ ok v1: matches'
		]);
		expect(lockReportText([])).toBe('snaps.lock pins no snaps.');
	});
});
