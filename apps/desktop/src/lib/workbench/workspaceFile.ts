// `.code-workspace` files (VS Code's multi-root workspace file: workspaces/common/workspaces.ts
// IStoredWorkspace): `folders` (a `path` relative to the file, or a `file://` `uri`, with an
// optional `name`) and `settings`. Pure, so bun tests can check it. Kingu opens one folder at a
// time (its Rust workspace has a single root), so the workspace picks one of the folders.

import { parseJsonc } from '#lib/settings/jsonc.ts';

export type WorkspaceFolder = { path: string; name: string };
export type CodeWorkspace = { folders: WorkspaceFolder[]; settings: Record<string, unknown> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `a/../b/./c` → `b/c`, keeping a leading `/`. */
export function normalizePath(path: string): string {
	const absolute = path.startsWith('/');
	const out: string[] = [];
	for (const part of path.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') {
			if (out.length && out[out.length - 1] !== '..') out.pop();
			else if (!absolute) out.push('..');
		} else out.push(part);
	}
	return (absolute ? '/' : '') + out.join('/');
}

const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/';
const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/**
 * Parses a `.code-workspace` file at `file` (absolute). Folders resolve against the file's folder
 * (VS Code's `getStoredWorkspaceFolder`); `uri` folders count only for `file:` (remote ones need
 * a remote connection); the same folder twice is listed once. Throws on text that is not JSON(C)
 * or has no `folders` list.
 */
export function parseCodeWorkspace(text: string, file: string): CodeWorkspace {
	const data = parseJsonc<unknown>(text);
	if (!isRecord(data) || !Array.isArray(data.folders)) throw new Error('not a workspace file: no "folders" list');
	const base = dirname(file);
	const folders: WorkspaceFolder[] = [];
	for (const entry of data.folders) {
		if (!isRecord(entry)) continue;
		let path: string | null = null;
		if (typeof entry.path === 'string' && entry.path.trim()) {
			const p = entry.path.trim().replace(/\\/g, '/');
			path = normalizePath(p.startsWith('/') ? p : `${base}/${p}`);
		} else if (typeof entry.uri === 'string' && entry.uri.startsWith('file://')) {
			try {
				path = normalizePath(decodeURIComponent(new URL(entry.uri).pathname));
			} catch {
				path = null;
			}
		}
		if (!path || folders.some((f) => f.path === path)) continue;
		folders.push({ path, name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : basename(path) });
	}
	return { folders, settings: isRecord(data.settings) ? data.settings : {} };
}

/** The workspace's name in pickers: the file name without `.code-workspace` (VS Code's label). */
export const workspaceName = (file: string) => basename(file).replace(/\.code-workspace$/i, '');
export const isWorkspaceFile = (path: string) => /\.code-workspace$/i.test(path);
