// Orca's default keys for tabs and terminal panes of the Agents layout (its
// shared/keybindings/definitions-core-*.ts), as Kingu chords: `key` off macOS, `mac` on macOS
// (`cmd` is Ctrl off macOS). They act only while the Agents layout is in front, so the IDE keeps
// its own keys. Close Tab (⌘W) is the IDE's Close Editor command, extended to ADE tabs.

export type Shortcut = { id: string; title: string; key?: string; mac?: string };

export const ADE_SHORTCUTS = {
	newTerminal: { id: 'kingu.ade.tab.newTerminal', title: 'New Terminal Tab', key: 'cmd+t' },
	newBrowser: { id: 'kingu.ade.tab.newBrowser', title: 'New Browser Tab', key: 'cmd+shift+b' },
	reopenClosed: { id: 'kingu.ade.tab.reopenClosed', title: 'Reopen Closed Tab', key: 'cmd+shift+t' },
	// Off macOS Ctrl+R stays the shell's reverse search (Orca leaves it unbound there).
	rename: { id: 'kingu.ade.tab.rename', title: 'Rename Tab…', mac: 'cmd+r' },
	recentNext: { id: 'kingu.ade.tab.previousRecent', title: 'Switch to Recent Tab', key: 'ctrl+tab' },
	recentPrevious: { id: 'kingu.ade.tab.nextRecent', title: 'Switch to Recent Tab (Reverse)', key: 'ctrl+shift+tab' },
	next: { id: 'kingu.ade.tab.next', title: 'Next Tab', key: 'cmd+shift+]' },
	previous: { id: 'kingu.ade.tab.previous', title: 'Previous Tab', key: 'cmd+shift+[' },
	nextSameType: { id: 'kingu.ade.tab.nextSameType', title: 'Next Tab of the Same Type', key: 'cmd+alt+]' },
	previousSameType: { id: 'kingu.ade.tab.previousSameType', title: 'Previous Tab of the Same Type', key: 'cmd+alt+[' },
	nextTerminal: { id: 'kingu.ade.tab.nextTerminal', title: 'Next Terminal Tab', key: 'ctrl+pagedown' },
	previousTerminal: { id: 'kingu.ade.tab.previousTerminal', title: 'Previous Terminal Tab', key: 'ctrl+pageup' },
	splitRight: { id: 'kingu.ade.terminal.splitRight', title: 'Split Terminal Right', key: 'cmd+shift+d', mac: 'cmd+d' },
	splitDown: { id: 'kingu.ade.terminal.splitDown', title: 'Split Terminal Down', key: 'alt+shift+d', mac: 'cmd+shift+d' },
	focusNextPane: { id: 'kingu.ade.terminal.focusNextPane', title: 'Focus Next Pane', key: 'cmd+]' },
	focusPreviousPane: { id: 'kingu.ade.terminal.focusPreviousPane', title: 'Focus Previous Pane', key: 'cmd+[' },
	expandPane: { id: 'kingu.ade.terminal.expandPane', title: 'Expand / Collapse Pane', key: 'cmd+shift+enter' },
	equalizePanes: { id: 'kingu.ade.terminal.equalizePaneSizes', title: 'Equalize Pane Sizes' },
	closePane: { id: 'kingu.ade.terminal.closePane', title: 'Close Pane' },
	// Find (⌘F) is shared with the IDE panel: workbench.action.terminal.focusFind.
	clear: { id: 'kingu.ade.terminal.clear', title: 'Clear Terminal', key: 'cmd+k' }
} satisfies Record<string, Shortcut>;

/** Orca's Select Tab 1–9: Ctrl+n on macOS, Alt+n elsewhere. */
export const selectTabShortcut = (n: number): Shortcut => ({ id: `kingu.ade.tab.select${n}`, title: `Select Tab ${n}`, key: `alt+${n}`, mac: `ctrl+${n}` });

export const ALL_ADE_SHORTCUTS: Shortcut[] = [...Object.values(ADE_SHORTCUTS), ...Array.from({ length: 9 }, (_, i) => selectTabShortcut(i + 1))];
