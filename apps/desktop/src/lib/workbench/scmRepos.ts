// The repositories of a multi-root workspace (VS Code's git Model + the SCM Repositories view),
// as pure helpers so bun tests cover them. Rust's git_repos.rs finds them; each is named by the
// directory git runs in (`dir`, absolute), and its status paths are relative to that directory.
// The workbench names files by workspace path (workspaceFolders.ts): relative in the first
// folder, absolute in another. These helpers move paths between the two.

import { absolutePath, keyForPath, within, type WorkspaceFolder } from '#lib/workbench/workspaceFolders.ts';
import type { GitStatus, StatusEntry } from './scm';

export type RepoKind = 'folder' | 'nested' | 'parent' | 'editor';

/** One repository as `git_repositories` reports it. */
export type RepoInfo = { dir: string; folder: string; toplevel: string; kind: RepoKind };

/** A folder inside a repository above it, waiting for `git.openRepositoryInParentFolders: prompt`. */
export type ParentRepo = { folder: string; toplevel: string };

export type Detection = { repositories: RepoInfo[]; parents: ParentRepo[] };

const trim = (p: string) => p.replace(/\/+$/, '') || '/';
const base = (p: string) => trim(p).slice(trim(p).lastIndexOf('/') + 1);

/** The workspace path of `rel` inside repository `dir`; a path outside every folder stays absolute. */
export function entryKey(dir: string, rel: string, folders: readonly WorkspaceFolder[]): string {
	const abs = rel ? `${trim(dir)}/${rel}` : trim(dir);
	return keyForPath(abs, folders) ?? abs;
}

/** `key` (a workspace path) relative to repository `dir`, null when it is not inside it. */
export function relInRepo(dir: string, key: string, folders: readonly WorkspaceFolder[]): string | null {
	const abs = absolutePath(key, folders);
	if (!abs || !within(abs, dir)) return null;
	const d = trim(dir);
	return abs === d ? '' : abs.slice(d.length + 1);
}

/** A status read with every path (and rename source) turned into a workspace path. */
export function keyedStatus(read: GitStatus, dir: string, folders: readonly WorkspaceFolder[]): GitStatus {
	const key = (rel: string) => entryKey(dir, rel, folders);
	const entries: StatusEntry[] = read.entries.map((e) => ({ ...e, path: key(e.path), orig_path: e.orig_path === null ? null : key(e.orig_path) }));
	return { ...read, entries };
}

/** The repository holding workspace path `key`: the innermost one by directory. */
export function repositoryOf<R extends { dir: string }>(key: string, repos: readonly R[], folders: readonly WorkspaceFolder[]): R | null {
	const abs = absolutePath(key, folders);
	if (!abs) return null;
	let best: R | null = null;
	for (const r of repos) if (within(abs, r.dir) && (!best || trim(r.dir).length > trim(best.dir).length)) best = r;
	return best;
}

/**
 * The name the Repositories view shows (VS Code: the repository folder's name), and where it is:
 * the workspace folder's name for a nested repository, the parent repository's folder for a
 * folder inside one.
 */
export function repoLabel(info: RepoInfo, folders: readonly WorkspaceFolder[]): { name: string; description: string } {
	const folder = folders.find((f) => trim(f.path) === trim(info.folder));
	if (info.kind === 'folder') return { name: folder?.name || base(info.dir), description: '' };
	// The whole repository above the folder: its own name, and the folder it was found from.
	if (info.kind === 'parent') return { name: base(info.toplevel), description: folders.length > 1 ? (folder?.name ?? base(info.folder)) : '' };
	const inFolder = trim(info.dir).slice(trim(info.folder).length + 1);
	const parent = inFolder.includes('/') ? inFolder.slice(0, inFolder.lastIndexOf('/')) : '';
	const where = [folders.length > 1 ? (folder?.name ?? base(info.folder)) : '', parent].filter(Boolean).join('/');
	return { name: base(info.dir), description: where };
}

export type SortOrder = 'discovery time' | 'name' | 'path';

/** `scm.repositories.sortOrder`. */
export function sortRepositories<R extends { info: RepoInfo; label: { name: string } }>(repos: readonly R[], order: SortOrder): R[] {
	if (order === 'name') return [...repos].sort((a, b) => a.label.name.localeCompare(b.label.name));
	if (order === 'path') return [...repos].sort((a, b) => a.info.dir.localeCompare(b.info.dir));
	return [...repos];
}

/** The git.* settings `git_repositories` reads (git_repos.rs DetectOptions). */
export function detectOptions(get: <T>(id: string) => T, extra: { allowedParents: string[]; openEditors: string[] }) {
	return {
		autoRepositoryDetection: get<boolean | string>('git.autoRepositoryDetection'),
		repositoryScanMaxDepth: get<number>('git.repositoryScanMaxDepth'),
		repositoryScanIgnoredFolders: get<string[]>('git.repositoryScanIgnoredFolders'),
		scanRepositories: get<string[]>('git.scanRepositories'),
		ignoredRepositories: get<string[]>('git.ignoredRepositories'),
		openRepositoryInParentFolders: get<string>('git.openRepositoryInParentFolders'),
		allowedParents: extra.allowedParents,
		openEditors: extra.openEditors
	};
}

/**
 * Which repositories the Source Control view shows (VS Code: `scm.repositories.selectionMode`,
 * `scm.repositories.visible`): every selected one in `multiple` mode, the last selected in
 * `single` mode; all of them (up to `visible`) until the user picks.
 */
export function visibleRepositories<R extends { info: RepoInfo }>(repos: readonly R[], selected: readonly string[], mode: string, visible: number): R[] {
	const picked = repos.filter((r) => selected.includes(r.info.dir));
	if (mode === 'single') {
		const last = selected.length ? repos.find((r) => r.info.dir === selected[selected.length - 1]) : undefined;
		return last ? [last] : repos.slice(0, 1);
	}
	return picked.length ? picked : repos.slice(0, Math.max(1, visible));
}
