// The terminal's right-click menu (pure, so `bun test` covers it). The IDE panel follows VS Code's
// terminal context menu (Copy, Paste, Select All | Clear | Kill) with its tab menu's Split and
// Rename; ADE terminals follow Orca's TerminalContextMenu (Copy, Select All, Paste | Split Right,
// Split Down, Equalize, Expand | Set Title… | Close Pane | Clear Screen, Reset Terminal).

import type { MenuNode } from '#lib/workbench/menus.ts';

export type TerminalFlavor = 'ide' | 'ade';
export type MenuState = {
	hasSelection: boolean;
	/** ADE: the tab has more than one pane. */
	split?: boolean;
	/** ADE: a pane is expanded over the others. */
	expanded?: boolean;
	/** ADE: false for an agent CLI's own terminal, which cannot be split, retitled or closed from here. */
	panes?: boolean;
};

/** Ids the terminal runs itself; the rest go to its owner (`onaction`). */
export const BUILTIN = ['copy', 'paste', 'selectAll', 'clear', 'reset'] as const;
export type BuiltinAction = (typeof BUILTIN)[number];
export const isBuiltin = (id: string): id is BuiltinAction => (BUILTIN as readonly string[]).includes(id);

const item = (id: string, text: string, keyLabel?: string, enabled = true): MenuNode => ({ type: 'item', id, text, enabled, ...(keyLabel ? { keyLabel } : {}) });
const sep: MenuNode = { type: 'separator' };

export function terminalMenu(flavor: TerminalFlavor, s: MenuState, keyLabel: (id: string) => string | undefined = () => undefined): MenuNode[] {
	if (flavor === 'ide') {
		return [
			item('copy', 'Copy', keyLabel('copy'), s.hasSelection),
			item('paste', 'Paste', keyLabel('paste')),
			item('selectAll', 'Select All', keyLabel('selectAll')),
			sep,
			item('clear', 'Clear', keyLabel('clear')),
			sep,
			item('split', 'Split Terminal', keyLabel('split')),
			item('rename', 'Rename…', keyLabel('rename')),
			sep,
			item('kill', 'Kill Terminal', keyLabel('kill'))
		];
	}
	const edit = [item('copy', 'Copy', keyLabel('copy'), s.hasSelection), item('selectAll', 'Select All', keyLabel('selectAll')), item('paste', 'Paste', keyLabel('paste'))];
	const clear = [item('clear', 'Clear Screen', keyLabel('clear')), item('reset', 'Reset Terminal', keyLabel('reset'))];
	if (s.panes === false) return [...edit, sep, ...clear];
	return [
		...edit,
		sep,
		item('splitRight', 'Split Terminal Right', keyLabel('splitRight')),
		item('splitDown', 'Split Terminal Down', keyLabel('splitDown')),
		...(s.split ? [item('equalize', 'Equalize Pane Sizes', keyLabel('equalize')), item('expand', s.expanded ? 'Collapse Pane' : 'Expand Pane', keyLabel('expand'))] : []),
		sep,
		item('rename', 'Set Title…', keyLabel('rename')),
		...(s.split ? [sep, item('closePane', 'Close Pane', keyLabel('closePane'))] : []),
		sep,
		...clear
	];
}
