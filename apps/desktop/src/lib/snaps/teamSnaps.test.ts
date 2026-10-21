/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import type { SnapInfo } from './snapModel';
import { approvalNote, approveSummary, canApprove, isApprovable, missingRequired, teamSnapStatus, type TeamSnap } from './teamSnaps';

// These tests check the Thai wording.
beforeAll(() => setLocale('th'));
afterAll(() => setLocale('en'));

const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

function snap(over: Partial<SnapInfo> = {}): SnapInfo {
	return {
		id: 'go',
		name: 'Go',
		version: '1.0.0',
		description: '',
		source: 'user',
		dir: '/x/snaps/go',
		trusted: true,
		error: null,
		overridden: false,
		hash: H1,
		permissions: { network: false, fs: 'worktree', secrets: [] },
		tasks: [],
		settings: [],
		mcp: [],
		skills: [],
		hooks: [],
		requires: [],
		services: [],
		readme: null,
		runFiles: [],
		scripts: [],
		approvedPermissions: null,
		origin: { url: 'https://github.com/acme/go.git', ref: 'main', commit: C1, path: null, installed_at: 1 },
		lock: null,
		...over
	};
}

function entry(over: Partial<TeamSnap> = {}): TeamSnap {
	return {
		snap_id: 'go',
		name: 'Go',
		version: '1.0.0',
		git_url: 'https://github.com/acme/go.git',
		git_ref: 'main',
		commit_sha: C1,
		manifest_sha256: H1,
		permissions: { network: false, fs: 'worktree', secrets: [] },
		approved_by: 'olive',
		approved_at: '2026-10-18T09:00:00Z',
		required: false,
		note: null,
		...over
	};
}

describe('teamSnapStatus', () => {
	test('installed at the approved commit with the approved hash matches', () => {
		const st = teamSnapStatus(entry(), [snap()]);
		expect(st.key).toBe('match');
		expect(st.tone).toBe('ok');
	});

	test('a different commit, hash or version is different', () => {
		expect(teamSnapStatus(entry({ commit_sha: C2, version: '1.1.0' }), [snap()]).key).toBe('different');
		expect(teamSnapStatus(entry({ manifest_sha256: H2 }), [snap()]).key).toBe('different');
		// Edited locally after install: same commit, other hash.
		expect(teamSnapStatus(entry(), [snap({ hash: H2 })]).key).toBe('different');
		expect(teamSnapStatus(entry(), [snap({ origin: null })]).key).toBe('different');
		expect(teamSnapStatus(entry(), [snap({ error: 'bad' })]).key).toBe('different');
		const st = teamSnapStatus(entry({ commit_sha: C2, version: '2.0.0' }), [snap()]);
		expect(st.detail).toBe('เครื่องนี้ v1.0.0 @ aaaaaaa · ทีม v2.0.0 @ bbbbbbb');
	});

	test('not installed, or only as a repo snap, is missing', () => {
		expect(teamSnapStatus(entry(), []).key).toBe('missing');
		expect(teamSnapStatus(entry(), [snap({ source: 'repo' })]).key).toBe('missing');
		expect(teamSnapStatus(entry(), [snap({ id: 'rust' })]).key).toBe('missing');
	});
});

test('missingRequired lists required snaps that are not installed', () => {
	const items = [entry({ required: true }), entry({ snap_id: 'rust', name: 'Rust', required: true }), entry({ snap_id: 'py', required: false })];
	expect(missingRequired(items, [snap()]).map((t) => t.snap_id)).toEqual(['rust']);
	// Installed but different still counts as present (the row says so).
	expect(missingRequired(items, [snap({ hash: H2 }), snap({ id: 'rust' })])).toEqual([]);
});

test('canApprove: owners and leads only', () => {
	expect(['owner', 'lead', 'dev', 'viewer', '', undefined, null].map(canApprove)).toEqual([true, true, false, false, false, false, false]);
});

test('isApprovable: user snaps from a remote git at a known commit', () => {
	expect(isApprovable(snap())).toBe(true);
	expect(isApprovable(snap({ origin: { url: 'git@github.com:a/b.git', ref: null, commit: C1, path: null, installed_at: 1 } }))).toBe(true);
	expect(isApprovable(snap({ source: 'repo' }))).toBe(false);
	expect(isApprovable(snap({ error: 'x' }))).toBe(false);
	expect(isApprovable(snap({ origin: null }))).toBe(false);
	expect(isApprovable(snap({ origin: { url: null, ref: null, commit: null, path: '/x', installed_at: 1 } }))).toBe(false);
	expect(isApprovable(snap({ origin: { url: '/tmp/r.git', ref: null, commit: C1, path: null, installed_at: 1 } }))).toBe(false);
	expect(isApprovable(snap({ origin: { url: 'file:///tmp/r.git', ref: null, commit: C1, path: null, installed_at: 1 } }))).toBe(false);
	expect(isApprovable(snap({ origin: { url: 'https://x/y.git', ref: null, commit: 'abc', path: null, installed_at: 1 } }))).toBe(false);
});

test('approvalNote marks installed snaps the team approved', () => {
	expect(approvalNote(snap(), [entry()])).toBe('ทีมอนุมัติ');
	expect(approvalNote(snap(), [entry({ commit_sha: C2 })])).toBe('ทีมอนุมัติเวอร์ชันอื่น');
	expect(approvalNote(snap(), [])).toBeNull();
	expect(approvalNote(snap({ source: 'repo' }), [entry()])).toBeNull();
});

test('approveSummary shows the pin and permissions', () => {
	const text = approveSummary(snap({ permissions: { network: true, fs: 'home', secrets: ['T'] } }), true);
	expect(text).toContain('https://github.com/acme/go.git#main @ aaaaaaa');
	expect(text).toContain(`SHA-256: ${H1}`);
	expect(text).toContain('network): ใช้');
	expect(text).toContain('required');
});
