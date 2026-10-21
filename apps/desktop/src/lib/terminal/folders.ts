// Which root folder a panel terminal starts in, in a multi-root window (pure, so `bun test`
// covers it). VS Code's Create New Terminal asks for the folder when there are several
// (terminalActions.ts pickTerminalCwd), unless `terminal.integrated.cwd` makes every folder start
// in the same place; Create New Terminal (In Active Workspace) takes the active editor's folder.

import { folderOf, type WorkspaceFolder } from '#lib/workbench/workspaceFolders.ts';
import { collectVariables, substitute, type VariableContext } from '#lib/tasks/variables.ts';

/** One choice of the folder pick: the folder and where its terminal starts. */
export type FolderCwd = { folder: WorkspaceFolder; cwd: string; overridden: boolean };

const trim = (p: string) => p.replace(/\/+$/, '') || '/';

/** Where a terminal of `folder` starts with `terminal.integrated.cwd` = `setting` (absolute, or relative to the folder). */
export function folderCwd(folder: WorkspaceFolder, setting: string | null | undefined): FolderCwd {
	const raw = setting?.trim();
	if (!raw) return { folder, cwd: trim(folder.path), overridden: false };
	if (raw.startsWith('/')) return { folder, cwd: trim(raw), overridden: true };
	const rel = raw.replace(/^\.\/+/, '').replace(/\/+$/, '');
	return { folder, cwd: rel && rel !== '.' ? `${trim(folder.path)}/${rel}` : trim(folder.path), overridden: true };
}

/** The folder pick's choices: one per folder, folders that start in the same directory once
 * (VS Code's shrinkWorkspaceFolderCwdPairs). `setting`: the value, or the value with its
 * variables resolved for each folder (`cwdSetting`). */
export function folderChoices(folders: readonly WorkspaceFolder[], setting: string | null | undefined | ((folder: WorkspaceFolder) => string | null)): FolderCwd[] {
	const seen = new Set<string>();
	const out: FolderCwd[] = [];
	for (const f of folders) {
		const pair = folderCwd(f, typeof setting === 'function' ? setting(f) : setting);
		if (seen.has(pair.cwd)) continue;
		seen.add(pair.cwd);
		out.push(pair);
	}
	return out;
}

/**
 * `terminal.integrated.cwd` with its `${…}` variables resolved (VS Code resolves them for the
 * terminal's root folder: `${workspaceFolder}`, `${env:…}`, `${userHome}`, `${file…}`, …); null
 * when unset, or when a variable cannot be resolved (the terminal then starts where it would by
 * default, as VS Code falls back).
 */
export function cwdSetting(raw: string | null | undefined, ctx: VariableContext): string | null {
	const value = raw?.trim();
	if (!value) return null;
	if (!value.includes('${')) return value;
	try {
		return substitute(value, ctx).trim() || null;
	} catch {
		return null;
	}
}

/** The `${env:NAME}` names a setting uses (fetched from the app's environment before resolving). */
export function envNames(raw: string | null | undefined): string[] {
	return [...collectVariables(raw ?? '')].filter((v) => v.startsWith('env:')).map((v) => v.slice(4));
}

/** Whether New Terminal asks which folder: only when the folders start in different directories. */
export const asksForFolder = (folders: readonly WorkspaceFolder[], setting: string | null | undefined) => folderChoices(folders, setting).length > 1;

/** The folder of the active editor (Create New Terminal (In Active Workspace)), else the first folder. */
export function activeFolder(activeKey: string | null | undefined, folders: readonly WorkspaceFolder[]): WorkspaceFolder | null {
	return (activeKey && !activeKey.includes(':') ? folderOf(activeKey, folders) : null) ?? folders[0] ?? null;
}

/** The folder name a terminal tab shows in a multi-root window (VS Code's `${workspaceFolderName}`); null otherwise or for an unknown folder. */
export function terminalFolderName(folder: string | undefined, folders: readonly WorkspaceFolder[]): string | null {
	if (folders.length < 2) return null;
	const f = folder ? folderOf(folder, folders) : folders[0];
	return f?.name ?? null;
}
