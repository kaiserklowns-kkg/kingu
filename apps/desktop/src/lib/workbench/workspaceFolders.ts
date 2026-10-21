// The root folders of a window's workspace (VS Code: IWorkspaceContextService's folders), as
// pure helpers so bun tests cover them. A path the workbench passes around is relative to the
// first folder (a single-folder window never sees anything else), or absolute inside another
// root folder; Rust's workspace.rs `locate` reads them the same way.

/** One root folder: its absolute path and the name the Explorer shows (a `.code-workspace` `name`, else the folder's). */
export type WorkspaceFolder = { path: string; name: string };

const trim = (p: string) => p.replace(/\/+$/, '') || '/';

/** Whether `path` is `root` or inside it. */
export function within(path: string, root: string): boolean {
	const r = trim(root);
	return path === r || path.startsWith(r === '/' ? '/' : r + '/');
}

/** The root folder holding `key` (relative: the first one; absolute: the innermost holding it), or null. */
export function folderOf(key: string, folders: readonly WorkspaceFolder[]): WorkspaceFolder | null {
	if (!folders.length) return null;
	if (!key.startsWith('/')) return folders[0];
	let best: WorkspaceFolder | null = null;
	for (const f of folders) if (within(key, f.path) && (!best || f.path.length > best.path.length)) best = f;
	return best;
}

/** The workbench path of an absolute file: relative in the first folder, absolute in another, null outside every folder. */
export function keyForPath(absolute: string, folders: readonly WorkspaceFolder[]): string | null {
	const f = folderOf(absolute, folders);
	if (!f) return null;
	if (f !== folders[0]) return absolute;
	const r = trim(f.path);
	if (absolute === r) return '';
	return absolute.slice(r.length + 1);
}

/** The absolute path of a workbench path. */
export function absolutePath(key: string, folders: readonly WorkspaceFolder[]): string | null {
	if (key.startsWith('/')) return key;
	const first = folders[0];
	if (!first) return null;
	return key ? `${trim(first.path)}/${key}` : trim(first.path);
}

/** A key relative to its own root folder (`src/a.ts` for `/other/src/a.ts`), for labels. */
export function relativeInFolder(key: string, folders: readonly WorkspaceFolder[]): string {
	if (!key.startsWith('/')) return key;
	const f = folderOf(key, folders);
	if (!f) return key;
	const r = trim(f.path);
	return key === r ? '' : key.slice(r.length + 1);
}

/**
 * A watcher batch of root folder `root` (paths relative to it, `''` = rescan) as workbench paths:
 * unchanged for the first folder, absolute for another; null when `root` is not a folder of the
 * workspace (an old batch after a switch).
 */
export function watcherPaths(root: string, paths: readonly string[], folders: readonly WorkspaceFolder[]): string[] | null {
	const i = folders.findIndex((f) => trim(f.path) === trim(root));
	if (i < 0) return null;
	if (i === 0) return [...paths];
	const r = trim(folders[i].path);
	return paths.map((p) => (p ? `${r}/${p}` : r));
}

/** `${workspaceFolder:name}`: the folder whose name (or folder name) is `name`. */
export function folderNamed(name: string, folders: readonly WorkspaceFolder[]): WorkspaceFolder | null {
	return folders.find((f) => f.name === name) ?? folders.find((f) => f.path.slice(f.path.lastIndexOf('/') + 1) === name) ?? null;
}

/** `path` relative to the folder `dir` when it is inside it or a sibling tree, like VS Code writes `.code-workspace` folders. */
export function relativePath(path: string, dir: string): string {
	const from = trim(dir).split('/').filter(Boolean);
	const to = trim(path).split('/').filter(Boolean);
	let i = 0;
	while (i < from.length && i < to.length && from[i] === to[i]) i++;
	// Nothing shared but `/`: an absolute path reads better.
	if (i === 0) return path;
	const up = from.slice(i).map(() => '..');
	return [...up, ...to.slice(i)].join('/') || '.';
}

/** The text of a `.code-workspace` file for `folders` saved as `file` (paths relative to it; names only where they differ from the folder's). */
export function workspaceFileText(folders: readonly WorkspaceFolder[], settings: Record<string, unknown>, file: string | null): string {
	const dir = file ? file.slice(0, Math.max(1, file.lastIndexOf('/'))) : null;
	const entries = folders.map((f) => {
		const base = f.path.slice(f.path.lastIndexOf('/') + 1);
		const path = dir ? relativePath(f.path, dir) : f.path;
		return f.name && f.name !== base ? { name: f.name, path } : { path };
	});
	return JSON.stringify({ folders: entries, settings }, null, '\t') + '\n';
}

/** The window title's workspace part: the folder, `name (Workspace)` for a workspace file, or untitled. */
export function workspaceLabel(folders: readonly WorkspaceFolder[], file: string | null, untitled: boolean, suffix: (name: string) => string, untitledLabel: string): string {
	if (file) return suffix(file.slice(file.lastIndexOf('/') + 1).replace(/\.code-workspace$/, ''));
	if (untitled || folders.length > 1) return untitledLabel;
	return folders[0]?.name ?? '';
}

/**
 * The folder part a file row shows beside its name (Quick Open, VS Code's label service): its
 * directory, led by the root folder's name in a multi-root workspace (`Library • src`).
 */
export function fileDetail(key: string, folders: readonly WorkspaceFolder[]): string {
	const f = folderOf(key, folders);
	const parent = (p: string) => (p.includes('/') ? p.slice(0, Math.max(1, p.lastIndexOf('/'))) : '');
	if (!f) return parent(key);
	const dir = parent(relativeInFolder(key, folders));
	if (folders.length < 2) return dir;
	return dir ? `${f.name} • ${dir}` : f.name;
}
