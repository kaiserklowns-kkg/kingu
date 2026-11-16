// Keyboard navigation between editors and editor groups, with VS Code's ids and default keys
// (browser/parts/editor/editorCommands.ts and editorActions.ts; files/browser/fileCommands.ts and
// files/electron-browser/fileActions.contribution.ts for the active file's ⌘K P / ⌘K R):
// open the Nth editor (⌃1…⌃9, ⌃0 last), focus a group by number (⌘4…⌘8) or direction
// (⌘K ⌘←/→/↑/↓), move the active editor within its group (⌘K ⇧⌘←/→) or to another group
// (⌃⌘←/→, ⌃⌘1 / ⌃⌘9), and move the whole group (⌘K ←/→/↑/↓). Off macOS the keys are VS Code's Windows/Linux ones.

import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import * as G from './editorGroups';
import { appMode } from './mode.svelte';
import { settings } from '#lib/settings/settings.svelte.ts';
import { copyPath, isFileEditor, revealInOS } from './editorCommands.svelte';
import { navigation } from './navigation.svelte';
import { saveFile } from './editorModels';
import { isDiffKey } from './scm';
import { panelTerminalFocus } from '#lib/terminal/terminalCommands.svelte.ts';

const sideDirection = () => (settings.get<'right' | 'down'>('workbench.editor.openSideBySideDirection') === 'down' ? 'down' : 'right');

/** Opens the editor at `index` of the active group (VS Code's openEditorAtIndex: nothing past the end). */
export function openEditorAtIndex(index: number) {
	const tab = editors.tabs[index];
	if (!tab) return;
	editors.active = tab.path;
	editors.focusGroup(editors.activeGroupId);
}

function focusGroup(id: number | null) {
	if (id !== null) editors.focusGroup(id);
}

function moveInGroup(to: 'left' | 'right' | 'first' | 'last') {
	const path = editors.active;
	if (path && G.moveEditorInGroup(editors.model, editors.activeGroupId, path, to)) editors.focusGroup(editors.activeGroupId);
}

function moveToGroup(to: 'previous' | 'next' | 'first' | 'last') {
	const target = G.moveActiveEditorToGroup(editors.model, to, sideDirection());
	if (target !== null) editors.focusRequest = target;
}

function moveGroup(direction: G.SplitDirection) {
	const id = G.moveGroup(editors.model, editors.activeGroupId, direction);
	if (id !== null) editors.focusGroup(id);
}

/** Registers the commands; returns the unregister function. */
export function installEditorNavCommands(): () => void {
	const ide = () => !appMode.isAgents;
	const hasEditor = () => ide() && editors.active !== null;
	const several = () => ide() && editors.groups.length > 1;
	const from = () => editors.activeGroupId;
	const unregister = [
		// ⌃1 … ⌃9 on macOS, ⌥1 … ⌥9 elsewhere; ⌃0 / ⌥0 the last editor. Written out one by one so the keymap audit sees every key.
		commands.register({ id: 'workbench.action.openEditorAtIndex1', title: 'Open Editor at Index 1', category: 'View', key: 'alt+1', mac: 'ctrl+1', palette: false, when: hasEditor, run: () => openEditorAtIndex(0) }),
		commands.register({ id: 'workbench.action.openEditorAtIndex2', title: 'Open Editor at Index 2', category: 'View', key: 'alt+2', mac: 'ctrl+2', palette: false, when: hasEditor, run: () => openEditorAtIndex(1) }),
		commands.register({ id: 'workbench.action.openEditorAtIndex3', title: 'Open Editor at Index 3', category: 'View', key: 'alt+3', mac: 'ctrl+3', palette: false, when: hasEditor, run: () => openEditorAtIndex(2) }),
		commands.register({ id: 'workbench.action.openEditorAtIndex4', title: 'Open Editor at Index 4', category: 'View', key: 'alt+4', mac: 'ctrl+4', palette: false, when: hasEditor, run: () => openEditorAtIndex(3) }),
		commands.register({ id: 'workbench.action.openEditorAtIndex5', title: 'Open Editor at Index 5', category: 'View', key: 'alt+5', mac: 'ctrl+5', palette: false, when: hasEditor, run: () => openEditorAtIndex(4) }),
		commands.register({ id: 'workbench.action.openEditorAtIndex6', title: 'Open Editor at Index 6', category: 'View', key: 'alt+6', mac: 'ctrl+6', palette: false, when: hasEditor, run: () => openEditorAtIndex(5) }),
		commands.register({ id: 'workbench.action.openEditorAtIndex7', title: 'Open Editor at Index 7', category: 'View', key: 'alt+7', mac: 'ctrl+7', palette: false, when: hasEditor, run: () => openEditorAtIndex(6) }),
		commands.register({ id: 'workbench.action.openEditorAtIndex8', title: 'Open Editor at Index 8', category: 'View', key: 'alt+8', mac: 'ctrl+8', palette: false, when: hasEditor, run: () => openEditorAtIndex(7) }),
		commands.register({ id: 'workbench.action.openEditorAtIndex9', title: 'Open Editor at Index 9', category: 'View', key: 'alt+9', mac: 'ctrl+9', palette: false, when: hasEditor, run: () => openEditorAtIndex(8) }),
		commands.register({ id: 'workbench.action.lastEditorInGroup', title: 'Open Last Editor in Group', category: 'View', key: 'alt+0', mac: 'ctrl+0', when: hasEditor, run: () => openEditorAtIndex(editors.tabs.length - 1) }),
		commands.register({ id: 'workbench.action.firstEditorInGroup', title: 'Open First Editor in Group', category: 'View', when: hasEditor, run: () => openEditorAtIndex(0) }),
		// ⌘4 … ⌘8: like ⌘2 / ⌘3, one past the last group creates it to the right.
		commands.register({ id: 'workbench.action.focusFourthEditorGroup', title: 'Focus Fourth Editor Group', category: 'View', key: 'cmd+4', when: ide, run: () => editors.focusGroupAt(3) }),
		commands.register({ id: 'workbench.action.focusFifthEditorGroup', title: 'Focus Fifth Editor Group', category: 'View', key: 'cmd+5', when: ide, run: () => editors.focusGroupAt(4) }),
		commands.register({ id: 'workbench.action.focusSixthEditorGroup', title: 'Focus Sixth Editor Group', category: 'View', key: 'cmd+6', when: ide, run: () => editors.focusGroupAt(5) }),
		commands.register({ id: 'workbench.action.focusSeventhEditorGroup', title: 'Focus Seventh Editor Group', category: 'View', key: 'cmd+7', when: ide, run: () => editors.focusGroupAt(6) }),
		commands.register({ id: 'workbench.action.focusEighthEditorGroup', title: 'Focus Eighth Editor Group', category: 'View', key: 'cmd+8', when: ide, run: () => editors.focusGroupAt(7) }),
		// ⌘K ⌘← / → / ↑ / ↓, wrapping round at the edge of the grid.
		commands.register({ id: 'workbench.action.focusLeftGroup', title: 'Focus Left Editor Group', category: 'View', key: 'cmd+k cmd+left', when: several, run: () => focusGroup(G.groupInDirection(editors.model, from(), 'left')) }),
		commands.register({ id: 'workbench.action.focusRightGroup', title: 'Focus Right Editor Group', category: 'View', key: 'cmd+k cmd+right', when: several, run: () => focusGroup(G.groupInDirection(editors.model, from(), 'right')) }),
		commands.register({ id: 'workbench.action.focusAboveGroup', title: 'Focus Editor Group Above', category: 'View', key: 'cmd+k cmd+up', when: several, run: () => focusGroup(G.groupInDirection(editors.model, from(), 'up')) }),
		commands.register({ id: 'workbench.action.focusBelowGroup', title: 'Focus Editor Group Below', category: 'View', key: 'cmd+k cmd+down', when: several, run: () => focusGroup(G.groupInDirection(editors.model, from(), 'down')) }),
		// ⌘K ← / → / ↑ / ↓: the whole group moves past its neighbour (no wrap).
		commands.register({ id: 'workbench.action.moveActiveEditorGroupLeft', title: 'Move Editor Group Left', category: 'View', key: 'cmd+k left', when: several, run: () => moveGroup('left') }),
		commands.register({ id: 'workbench.action.moveActiveEditorGroupRight', title: 'Move Editor Group Right', category: 'View', key: 'cmd+k right', when: several, run: () => moveGroup('right') }),
		commands.register({ id: 'workbench.action.moveActiveEditorGroupUp', title: 'Move Editor Group Up', category: 'View', key: 'cmd+k up', when: several, run: () => moveGroup('up') }),
		commands.register({ id: 'workbench.action.moveActiveEditorGroupDown', title: 'Move Editor Group Down', category: 'View', key: 'cmd+k down', when: several, run: () => moveGroup('down') }),
		commands.register({ id: 'workbench.action.focusNextGroup', title: 'Focus Next Editor Group', category: 'View', when: several, run: () => focusGroup(G.groupAtLocation(editors.model, from(), 'next')) }),
		commands.register({ id: 'workbench.action.focusPreviousGroup', title: 'Focus Previous Editor Group', category: 'View', when: several, run: () => focusGroup(G.groupAtLocation(editors.model, from(), 'previous')) }),
		commands.register({ id: 'workbench.action.focusLastEditorGroup', title: 'Focus Last Editor Group', category: 'View', when: several, run: () => focusGroup(G.groupAtLocation(editors.model, from(), 'last')) }),
		commands.register({ id: 'workbench.action.focusActiveEditorGroup', title: 'Focus Active Editor Group', category: 'View', when: ide, run: () => editors.focusGroup(from()) }),
		commands.register({
			id: 'workbench.action.moveEditorLeftInGroup',
			title: 'Move Editor Left',
			category: 'View',
			key: 'cmd+shift+pageup',
			mac: 'cmd+k cmd+shift+left',
			when: hasEditor,
			run: () => moveInGroup('left')
		}),
		commands.register({
			id: 'workbench.action.moveEditorRightInGroup',
			title: 'Move Editor Right',
			category: 'View',
			key: 'cmd+shift+pagedown',
			mac: 'cmd+k cmd+shift+right',
			when: hasEditor,
			run: () => moveInGroup('right')
		}),
		commands.register({ id: 'workbench.action.moveEditorToStart', title: 'Move Editor to Start', category: 'View', when: hasEditor, run: () => moveInGroup('first') }),
		commands.register({ id: 'workbench.action.moveEditorToEnd', title: 'Move Editor to End', category: 'View', when: hasEditor, run: () => moveInGroup('last') }),
		commands.register({
			id: 'workbench.action.moveEditorToPreviousGroup',
			title: 'Move Editor into Previous Group',
			category: 'View',
			key: 'cmd+alt+left',
			mac: 'cmd+ctrl+left',
			when: hasEditor,
			// ⌃⌘← resizes a focused terminal instead (VS Code's terminalFocus binding).
			keyWhen: () => !panelTerminalFocus(),
			run: () => moveToGroup('previous')
		}),
		commands.register({
			id: 'workbench.action.moveEditorToFirstGroup',
			title: 'Move Editor into First Group',
			category: 'View',
			key: 'shift+alt+1',
			mac: 'cmd+ctrl+1',
			when: hasEditor,
			run: () => moveToGroup('first')
		}),
		commands.register({
			id: 'workbench.action.moveEditorToLastGroup',
			title: 'Move Editor into Last Group',
			category: 'View',
			key: 'shift+alt+9',
			mac: 'cmd+ctrl+9',
			when: hasEditor,
			run: () => moveToGroup('last')
		}),
		commands.register({
			id: 'workbench.action.navigateToLastEditLocation',
			title: 'Go to Last Edit Location',
			category: 'View',
			key: 'cmd+k cmd+q',
			when: () => ide() && navigation.canGoToLastEdit,
			run: () => navigation.toLastEdit()
		}),
		commands.register({
			id: 'workbench.action.files.saveWithoutFormatting',
			title: 'Save without Formatting',
			category: 'File',
			// VS Code: ⌘K S (Ctrl+K Ctrl+Shift+S on Windows).
			key: 'cmd+k s',
			when: () => editors.focusedFile !== null && !isDiffKey(editors.focusedFile),
			run: () => {
				const path = editors.focusedFile;
				if (path) void saveFile(path, { reason: 'explicit', skipSaveParticipants: true });
			}
		}),
		commands.register({
			id: 'workbench.action.files.copyPathOfActiveFile',
			title: 'Copy Path of Active File',
			category: 'File',
			key: 'cmd+k p',
			when: () => editors.active !== null && isFileEditor(editors.active),
			run: () => copyPath(editors.active!)
		}),
		commands.register({
			id: 'workbench.action.files.revealActiveFileInWindows',
			title: 'Reveal Active File in Finder',
			category: 'File',
			key: 'cmd+k r',
			when: () => editors.active !== null && isFileEditor(editors.active),
			run: () => revealInOS(editors.active!)
		})
	];
	return () => unregister.forEach((u) => u());
}
