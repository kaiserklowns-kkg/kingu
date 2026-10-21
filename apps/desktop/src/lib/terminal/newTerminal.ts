// Create New Terminal in a multi-root window (VS Code's workbench.action.terminal.new): asks which
// root folder to start in when the folders start in different places (folders.ts), and does
// nothing when the pick is dismissed. A single folder never asks.

import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { activeFolder, folderChoices } from './folders.ts';
import { terminals } from './terminals.svelte.ts';
import { t } from '#lib/i18n/index.ts';

/** `~/…` for a path under the home folder, like VS Code's label service. */
const tildify = (p: string) => (workspace.home && (p === workspace.home || p.startsWith(workspace.home + '/')) ? '~' + p.slice(workspace.home.length) : p);

/** The root folder for a new terminal: the only one, the picked one, or undefined when the pick was dismissed. */
export async function pickTerminalFolder(): Promise<string | null | undefined> {
	const folders = workspace.folders;
	if (folders.length < 2) return null;
	const choices = folderChoices(folders, settings.get<string>('terminal.integrated.cwd'));
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

/** Create New Terminal (In Active Workspace): the active editor's folder, without asking. */
export function createTerminalInActiveFolder(): number {
	const folder = workspace.isMultiRoot ? activeFolder(editors.active, workspace.folders)?.path : undefined;
	layout.showPanel('terminal');
	return terminals.open(folder ? { folder } : {});
}
