// The team Snap catalog, pure parts (testable with `bun test`): what the Team section of the
// Snaps view shows for each approved snap against what is installed here.

import { originLabel, permissionLines, type SnapInfo, type SnapOrigin, type SnapPermissions } from './snapModel.ts';
import { t as tr } from '#lib/i18n/index.ts';

/** Mirrors `team::snaps::TeamSnap` in Rust (snake_case, like the server). */
export type TeamSnap = {
	snap_id: string;
	name: string;
	version: string;
	git_url: string;
	git_ref: string | null;
	commit_sha: string;
	manifest_sha256: string;
	permissions: SnapPermissions;
	approved_by: string;
	approved_at: string;
	required: boolean;
	note: string | null;
};

/** `team_snap_catalog`. */
export type TeamCatalog = { server: string; user_id: string; role: string; items: TeamSnap[] };

export type TeamSnapState = 'match' | 'different' | 'missing';
export type TeamSnapStatus = { key: TeamSnapState; label: string; tone: 'ok' | 'warn' | 'muted'; detail: string };

/** The installed user snap with the catalog entry's id, if any (repo snaps are the repo's business). */
export const installedFor = (t: TeamSnap, list: readonly SnapInfo[]) => list.find((s) => s.source === 'user' && s.id === t.snap_id);

/** Installed at exactly the approved commit with the approved hash, installed otherwise, or not installed. */
export function teamSnapStatus(t: TeamSnap, list: readonly SnapInfo[]): TeamSnapStatus {
	const s = installedFor(t, list);
	if (!s) return { key: 'missing', label: tr('tools.teamSnaps.notInstalled'), tone: 'muted', detail: tr('tools.teamSnaps.teamApprovedAt', { version: t.version, commit: t.commit_sha.slice(0, 7) }) };
	if (!s.error && s.hash === t.manifest_sha256 && s.origin?.commit === t.commit_sha) return { key: 'match', label: tr('tools.teamSnaps.matches'), tone: 'ok', detail: `v${t.version} @ ${t.commit_sha.slice(0, 7)}` };
	const here = `${s.version ? `v${s.version}` : '?'}${s.origin?.commit ? ` @ ${s.origin.commit.slice(0, 7)}` : ''}`;
	return { key: 'different', label: tr('tools.teamSnaps.differs'), tone: 'warn', detail: tr('tools.teamSnaps.differsDetail', { here, version: t.version, commit: t.commit_sha.slice(0, 7) }) };
}

/** Required snaps that are not installed here (installed-but-different still counts as present). */
export const missingRequired = (items: readonly TeamSnap[], list: readonly SnapInfo[]) => items.filter((t) => t.required && !installedFor(t, list));

export const canApprove = (role: string | null | undefined) => role === 'owner' || role === 'lead';

/** A user snap the team can reproduce: installed from a remote git URL at a known commit. */
export function isApprovable(s: SnapInfo): boolean {
	const url = s.origin?.url;
	if (s.source !== 'user' || s.error || !url || !s.origin?.commit || !/^[0-9a-f]{40}$/.test(s.origin.commit)) return false;
	return !url.startsWith('/') && !/^file:/i.test(url);
}

/** The installed snap's approval state in the catalog, for its row: null when the team has no entry. */
export function approvalNote(s: SnapInfo, items: readonly TeamSnap[]): string | null {
	const t = items.find((i) => i.snap_id === s.id);
	if (!t || s.source !== 'user') return null;
	return teamSnapStatus(t, [s]).key === 'match' ? tr('tools.teamSnaps.approved') : tr('tools.teamSnaps.approvedOther');
}

/** The native confirm before approving: exactly what the team will be pinned to. */
export function approveSummary(s: SnapInfo, required: boolean): string {
	const origin = s.origin as SnapOrigin;
	return [
		`${s.name} (${s.id}) v${s.version}`,
		tr('tools.snaps.from', { origin: originLabel(origin) }),
		`SHA-256: ${s.hash}`,
		'',
		tr('tools.snaps.declaredPermissions'),
		...permissionLines(s.permissions).map((l) => `• ${l}`),
		'',
		required ? tr('tools.teamSnaps.requiredNote') : tr('tools.teamSnaps.optionalNote'),
		tr('tools.teamSnaps.sentNote')
	].join('\n');
}
