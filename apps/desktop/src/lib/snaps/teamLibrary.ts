// The team Snap library (packages owners and leads publish on the team server; team/library.rs),
// pure parts: what the Team section shows for each published snap against what is installed
// here, and the native confirms before publishing and yanking.

import { permissionLines, type SnapInfo, type SnapPermissions } from './snapModel.ts';
import { t } from '#lib/i18n/index.ts';

/** Mirrors `team::library::LibraryVersion` (snake_case, like the server). */
export type LibraryVersion = {
	snap_id: string;
	version: string;
	name: string;
	description: string;
	sha256: string;
	package_sha256: string;
	package_size: number;
	permissions: Partial<SnapPermissions>;
	published_by: string;
	published_at: string;
	yanked: boolean;
	yank_reason: string | null;
};

/** `team_snap_library`. */
export type Library = { server: string; role: string; items: LibraryVersion[] };

/** One snap of the library: the version to install (newest not yanked) and every version. */
export type LibrarySnap = { id: string; latest: LibraryVersion | null; versions: LibraryVersion[] };

/** Groups the list (newest first per snap, as the server orders it) by snap id. */
export function librarySnaps(items: readonly LibraryVersion[]): LibrarySnap[] {
	const by = new Map<string, LibraryVersion[]>();
	for (const v of items) by.set(v.snap_id, [...(by.get(v.snap_id) ?? []), v]);
	return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, versions]) => ({ id, versions, latest: versions.find((v) => !v.yanked) ?? null }));
}

export type LibraryState = 'missing' | 'current' | 'update' | 'yanked' | 'other';
export type LibraryStatus = { key: LibraryState; label: string; tone: 'ok' | 'warn' | 'muted' };

/** The installed user snap with this id, if any. */
export const installedOf = (id: string, list: readonly SnapInfo[]) => list.find((s) => s.source === 'user' && s.id === id);

/**
 * Not installed; installed from this library at the newest version; at an older one (update);
 * at a version since yanked; or installed from somewhere else (git, a folder).
 */
export function libraryStatus(snap: LibrarySnap, list: readonly SnapInfo[], server: string): LibraryStatus {
	const s = installedOf(snap.id, list);
	if (!s) return { key: 'missing', label: t('snapPlatform.library.notInstalled'), tone: 'muted' };
	const team = s.origin?.team;
	if (!team || team.server !== server) return { key: 'other', label: t('snapPlatform.library.installedElsewhere'), tone: 'muted' };
	const here = snap.versions.find((v) => v.version === team.version);
	if (here?.yanked) return { key: 'yanked', label: t('snapPlatform.library.yankedHere', { version: team.version }), tone: 'warn' };
	if (snap.latest && snap.latest.version !== team.version) return { key: 'update', label: t('snapPlatform.library.updateTo', { version: snap.latest.version }), tone: 'warn' };
	return { key: 'current', label: t('snapPlatform.library.current'), tone: 'ok' };
}

/** Installed snaps the library has a newer version of (Snap: Update from Team Library). */
export function libraryUpdates(snaps: readonly LibrarySnap[], list: readonly SnapInfo[], server: string): LibrarySnap[] {
	return snaps.filter((s) => libraryStatus(s, list, server).key === 'update');
}

/** `^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$`, the versions the server accepts. */
export const isPublishableVersion = (v: string) => /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(v);

/** A valid snap whose version the server accepts and which is not published at that version yet. */
export function isPublishable(s: SnapInfo, items: readonly LibraryVersion[]): boolean {
	return !s.error && isPublishableVersion(s.version) && !items.some((v) => v.snap_id === s.id && v.version === s.version);
}

/** The native confirm before publishing: what goes to the server, and what never does. */
export function publishSummary(s: SnapInfo): string {
	return [
		`${s.name} (${s.id}) v${s.version}`,
		'',
		t('tools.snaps.declaredPermissions'),
		...permissionLines(s.permissions).map((l) => `• ${l}`),
		'',
		t('snapPlatform.library.publishSends', { dir: s.dir }),
		...(s.scripts.length ? [t('snapPlatform.library.publishScripts', { list: s.scripts.map((f) => f.path).join(', ') })] : []),
		t('snapPlatform.library.publishNever'),
		t('snapPlatform.library.publishImmutable')
	].join('\n');
}

/** A version row for a quick pick. */
export function versionRow(v: LibraryVersion): { id: string; label: string; description: string } {
	const when = v.published_at.slice(0, 10);
	return { id: v.version, label: `v${v.version}`, description: v.yanked ? t('snapPlatform.library.yankedRow', { reason: v.yank_reason ?? '—' }) : t('snapPlatform.library.publishedRow', { by: v.published_by, when }) };
}
