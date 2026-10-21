// Create New Terminal in a multi-root window (VS Code's workbench.action.terminal.new): asks which
// root folder to start in when the folders start in different places (folders.ts), and does
// nothing when the pick is dismissed. A single folder never asks.

import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { invoke } from '@tauri-apps/api/core';
import { absolutePath } from '#lib/workbench/workspaceFolders.ts';
import type { VariableContext } from '#lib/tasks/variables.ts';
import { activeFolder, cwdSetting, envNames, folderChoices } from './folders.ts';
import { terminals } from './terminals.svelte.ts';
import { t } from '#lib/i18n/index.ts';

/** `~/…` for a path under the home folder, like VS Code's label service. */
const tildify = (p: string) => (workspace.home && (p === workspace.home || p.startsWith(workspace.home + '/')) ? '~' + p.slice(workspace.home.length) : p);

/** What `terminal.integrated.cwd`'s variables resolve against for a terminal of root folder `folder`. */
async function cwdContext(raw: string, folder: string | undefined): Promise<VariableContext> {
	const active = editors.active;
	const file = active && !active.includes(':') ? (absolutePath(active, workspace.folders) ?? undefined) : undefined;
	const names = envNames(raw);
	return {
		workspaceFolder: folder,
		folders: workspace.folders,
		file,
		lineNumber: file ? editors.cursor.line : undefined,
		columnNumber: file ? editors.cursor.column : undefined,
		userHome: workspace.home || undefined,
		env: names.length ? await invoke<Record<string, string>>('debug_env', { names }).catch(() => ({})) : {},
		config: (key) => settings.get(key)
	};
}

/** `terminal.integrated.cwd` for a new terminal of root folder `folder` (absent: the first), its `${…}` variables resolved there. */
export async function terminalCwdSetting(folder: string | null | undefined): Promise<string | null> {
	const raw = settings.get<string>('terminal.integrated.cwd');
	if (!raw?.includes('${')) return raw?.trim() || null;
	return cwdSetting(raw, await cwdContext(raw, folder ?? workspace.folders[0]?.path));
}

/** The root folder for a new terminal: the only one, the picked one, or undefined when the pick was dismissed. */
export async function pickTerminalFolder(): Promise<string | null | undefined> {
	const folders = workspace.folders;
	if (folders.length < 2) return null;
	// Resolved per folder (VS Code's pickTerminalCwd): `${workspaceFolder}/src` differs between them.
	const raw = settings.get<string>('terminal.integrated.cwd');
	const resolved = new Map<string, string | null>();
	for (const f of folders) resolved.set(f.path, raw?.includes('${') ? cwdSetting(raw, await cwdContext(raw, f.path)) : raw);
	const choices = folderChoices(folders, (f) => resolved.get(f.path) ?? null);
	if (choices.length < 2) return choices[0]?.folder.path ?? null;
	const picked = await quick.choose({
		placeholder: t('tools.terminal.pickFolder'),
		items: choices.map((c, i) => ({
			id: String(i),
			label: c.folder.name,
			description: c.overridden ? t('tools.terminal.overriddenCwd', { cwd: tildify(c.cwd) }) : tildify(c.folder.path.slice(0, Math.max(1, c.folder.path.lastIndexOf('/'))))
		}))
	});
	return picked ? choices[Number(picked.id)].folder.path : undefined;
}

/** Create New Terminal: in the folder the user picks (multi-root), shown and active. Null when dismissed. */
export async function createTerminal(): Promise<number | null> {
	const folder = await pickTerminalFolder();
	if (folder === undefined) return null;
	layout.showPanel('terminal');
	return terminals.open(folder ? { folder } : {});
}

/** The folder of a terminal opened by code (terminals.defaultFolder): the active editor's in a multi-root window. */
export function codeTerminalFolder(): string | null {
	return workspace.isMultiRoot ? (activeFolder(editors.active, workspace.folders)?.path ?? null) : null;
}

/** Create New Terminal (In Active Workspace): the active editor's folder, without asking. */
export function createTerminalInActiveFolder(): number {
	const folder = workspace.isMultiRoot ? activeFolder(editors.active, workspace.folders)?.path : undefined;
	layout.showPanel('terminal');
	return terminals.open(folder ? { folder } : {});
}
