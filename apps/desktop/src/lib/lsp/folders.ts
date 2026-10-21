// Language servers per root folder of a multi-root window, as pure helpers bun tests cover.
//
// VS Code's language clients start one server for the whole workspace and tell it every folder
// (`workspaceFolders`); a server that cannot take several folders gets one instance per folder
// (the lsp-multi-server-sample pattern), each rooted at its folder. Kingu does the same: a
// session is the server key (one for every folder) or the key and a folder path.

import { folderOf, relativeInFolder, within, type WorkspaceFolder } from '#lib/workbench/workspaceFolders.ts';
import { uriToPath } from './convert';

const SEP = '\u0000';

/** The session id of server `key` for every folder (`folder` null) or for root folder `folder` alone. */
export function sessionId(key: string, folder: string | null): string {
	return folder ? `${key}${SEP}${folder}` : key;
}

/** The server key and folder of a session id. */
export function parseSessionId(sid: string): { key: string; folder: string | null } {
	const i = sid.indexOf(SEP);
	return i < 0 ? { key: sid, folder: null } : { key: sid.slice(0, i), folder: sid.slice(i + 1) };
}

/**
 * Which session serves a file of root folder `folder` (null: outside every folder) once the
 * shared server is up: the shared one when it takes several folders (`workspaceFolders.supported`),
 * when the server finds projects per file anyway (`oneServer`), when the window has one folder,
 * or for the first folder (the shared server's root); else that folder's own server.
 */
export function sessionFolder(folder: string | null, folders: readonly WorkspaceFolder[], sharedTakesFolders: boolean, oneServer = false): string | null {
	if (!folder || sharedTakesFolders || oneServer || folders.length < 2) return null;
	return folder === folders[0].path ? null : folder;
}

/** The root folder path of a workbench key (relative: the first folder), null outside every folder. */
export function folderPathOf(key: string, folders: readonly WorkspaceFolder[]): string | null {
	return folderOf(key, folders)?.path ?? null;
}

/** The root folder of an LSP URI (a `workspace/configuration` item's `scopeUri`), null outside every folder. */
export function folderOfUri(uri: string | undefined, folders: readonly WorkspaceFolder[]): WorkspaceFolder | null {
	const path = uri ? uriToPath(uri) : null;
	if (!path) return null;
	let best: WorkspaceFolder | null = null;
	for (const f of folders) if (within(path, f.path) && (!best || f.path.length > best.path.length)) best = f;
	return best;
}

/**
 * How the Problems panel names a file (VS Code's label service): `label` the path relative to its
 * root folder, `detail` its directory, led by the folder's name in a multi-root window
 * (`Lib • src`); a file outside every folder shows its absolute path.
 */
export function problemLabel(rel: string | null, absolute: string, folders: readonly WorkspaceFolder[]): { label: string; detail: string } {
	const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
	if (rel === null) return { label: absolute, detail: dirOf(absolute) };
	const label = relativeInFolder(rel, folders);
	const dir = dirOf(label);
	const f = folderOf(rel, folders);
	if (folders.length < 2 || !f) return { label, detail: dir };
	return { label, detail: dir ? `${f.name} • ${dir}` : f.name };
}
