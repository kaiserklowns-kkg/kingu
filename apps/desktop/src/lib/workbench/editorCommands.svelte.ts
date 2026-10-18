// Editor commands (VS Code: browser/parts/editor/editorCommands.ts, editorActions.ts and the
// file commands of contrib/files): close variants, reopen closed, next/previous and ⌃Tab MRU,
// pin, split in four directions, Save As, Revert, New Untitled File, copy path and reveal. The
// tab context menu (EditorGroupView) runs the same functions on the tab that was right-clicked.

import { textFiles } from './textFileService.svelte';
import { invoke } from '@tauri-apps/api/core';
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { editorLabel } from './editorLabel';
import { revertFile, saveAs } from './editorModels';
import { explorer } from './explorer.svelte';
import { layout } from './layout.svelte';
import { notifications } from './notifications.svelte';
import { quick } from './quick.svelte';
import { fileOf, isDiffKey } from './scm';
import { status } from './status.svelte';
import { isUntitled, nextUntitledKey } from './untitled';
import { workspace } from './workspace.svelte';
import type { SplitDirection } from './editorGroups';
import { isNonTextEditor } from '#lib/settings/resources.ts';


/** A tab that is a workspace file (or a diff of one), so it has a path to copy or reveal. */
export const isFileEditor = (key: string) => !isUntitled(key) && !isNonTextEditor(key) && !key.includes('://');

const absPath = (rel: string) => `${workspace.root}/${rel}`;

async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text);
	} catch (e) {
		notifications.error(`คัดลอกไม่ได้ (Copy failed): ${e}`);
	}
}

// Saved editors close at once; the dirty ones left get VS Code's Save / Don't Save / Cancel.
const confirmKept = (kept: string[], group: number) => (kept.length ? textFiles.closeEditors(kept, group) : Promise.resolve([]));

export function closeEditor(group: number, path: string) {
	void textFiles.closeEditors([path], group);
}
export const closeOthers = (group: number, path: string) => confirmKept(editors.closeOthers(path, group), group);
export const closeToRight = (group: number, path: string) => confirmKept(editors.closeToRight(path, group), group);
export const closeSaved = (group: number) => editors.closeSaved(group);
export const closeAllInGroup = (group: number) => confirmKept(editors.closeAllInGroup(group), group);
/** Close All Editors: group by group, so each group's dirty editors are asked about in place. */
export async function closeAllEditors() {
	for (const g of [...editors.groups]) await confirmKept(editors.closeAllInGroup(g.id), g.id);
}
export const copyPath = (path: string) => copyText(absPath(fileOf(path)));
export const copyRelativePath = (path: string) => copyText(fileOf(path));
export function revealInOS(path: string) {
	invoke('fs_reveal', { rel: fileOf(path) }).catch((e) => notifications.error(String(e)));
}
export function revealInExplorer(path: string) {
	layout.showView('explorer');
	layout.sidebarVisible = true;
	void explorer.reveal(fileOf(path)).then(() => explorer.focusRow(fileOf(path)));
}
export function togglePinned(group: number, path: string) {
	if (editors.isSticky(path, group)) editors.unstick(path, group);
	else editors.stick(path, group);
}
/** Split Up/Down/Left/Right from a tab: a new group beside `group` showing `path`. */
export function splitFrom(group: number, path: string, direction: SplitDirection) {
	editors.activateGroup(group);
	editors.open(path, { preview: false, group });
	editors.split(direction);
}

/** New Untitled File (⌘N): an empty in-memory editor, saved with Save As. */
export function newUntitled() {
	const key = nextUntitledKey(editors.allTabs().map((t) => t.path));
	editors.open(key, { preview: false });
	editors.focusRequest = editors.activeGroupId;
}

/** ⌃Tab: the active group's editors by most recent use; held Ctrl and Tab again moves down, releasing Ctrl opens. */
function showMru(delta: 1 | -1) {
	if (quick.visible && quick.picker?.id === 'editorMru') return quick.moveSelection(delta);
	const group = editors.activeGroupId;
	const mru = editors.mru(group);
	if (!mru.length) return;
	const start = mru[(delta > 0 ? 1 : mru.length - 1) % mru.length];
	quick.pick({
		id: 'editorMru',
		quickNavigate: true,
		placeholder: 'เลือกแท็บที่จะเปิด (Select an editor to open)',
		items: mru.map((path) => ({ id: path, label: editorLabel(path), description: isFileEditor(path) ? fileOf(path) : undefined })),
		activeId: start,
		onAccept: (item) => editors.open(item.id, { group })
	});
}

/** Show All Editors (`edt `): every open editor, grouped by editor group. */
export function showAllEditors(byMru = false) {
	const order = editors.order();
	const items = order.flatMap((gid, gi) =>
		(byMru ? editors.mru(gid) : (editors.group(gid)?.tabs.map((t) => t.path) ?? [])).map((path, i) => ({
			id: `${gid}\u0000${path}`,
			label: editorLabel(path),
			description: isFileEditor(path) ? fileOf(path) : undefined,
			separator: i === 0 && order.length > 1 ? `Group ${gi + 1}` : undefined
		}))
	);
	quick.pick({
		placeholder: 'ค้นหาแท็บที่เปิดอยู่ (Search open editors by name)',
		items,
		onAccept: (item) => {
			const [gid, path] = item.id.split('\u0000');
			editors.open(path, { group: Number(gid) });
			editors.focusRequest = Number(gid);
		}
	});
}

/** Registers the editor commands; returns the unregister function. */
export function installEditorCommands(): () => void {
	const hasEditor = () => editors.active !== null;
	const active = () => editors.active;
	const group = () => editors.activeGroupId;
	// ⌥⌘C / ⌥⌘R act on the Explorer's selection there (its own keys) and are Monaco's elsewhere in the editor.
	const notInExplorerOrEditor = () => !document.activeElement?.closest('[data-context="explorer"], .monaco-editor');
	const unregister = [
		commands.register({ id: 'workbench.action.closeOtherEditors', title: 'Close Other Editors in Group', category: 'View', mac: 'cmd+alt+t', when: hasEditor, run: () => closeOthers(group(), active()!) }),
		commands.register({ id: 'workbench.action.closeEditorsToTheRight', title: 'Close Editors to the Right in Group', category: 'View', when: hasEditor, run: () => closeToRight(group(), active()!) }),
		commands.register({ id: 'workbench.action.closeUnmodifiedEditors', title: 'Close Saved Editors in Group', category: 'View', key: 'cmd+k u', when: () => editors.tabs.length > 0, run: () => closeSaved(group()) }),
		commands.register({
			id: 'workbench.action.closeAllEditors',
			title: 'Close All Editors',
			category: 'View',
			key: 'cmd+k cmd+w',
			when: () => editors.allTabs().length > 0 || editors.groups.length > 1,
			run: () => void closeAllEditors()
		}),
		commands.register({
			id: 'workbench.action.closeGroup',
			title: 'Close Editor Group',
			category: 'View',
			when: () => editors.groups.length > 1 || editors.tabs.length > 0,
			run: () => {
				const g = group();
				void confirmKept(editors.closeAllInGroup(g), g).then((left) => left.length === 0 && editors.removeGroup(g));
			}
		}),
		commands.register({
			id: 'workbench.action.reopenClosedEditor',
			title: 'Reopen Closed Editor',
			category: 'View',
			key: 'cmd+shift+t',
			run: () => {
				if (!editors.reopenClosed()) status.flash('ไม่มีแท็บที่ปิดไปให้เปิดคืน (No closed editor to reopen)');
			}
		}),
		commands.register({ id: 'workbench.action.nextEditor', title: 'Open Next Editor', category: 'View', key: 'ctrl+pagedown', mac: 'cmd+alt+right', when: hasEditor, run: () => editors.openNeighbour(1) }),
		commands.register({ id: 'workbench.action.previousEditor', title: 'Open Previous Editor', category: 'View', key: 'ctrl+pageup', mac: 'cmd+alt+left', when: hasEditor, run: () => editors.openNeighbour(-1) }),
		commands.register({ id: 'workbench.action.nextEditorInGroup', title: 'Open Next Editor in Group', category: 'View', when: hasEditor, run: () => editors.openNeighbour(1, true) }),
		commands.register({ id: 'workbench.action.previousEditorInGroup', title: 'Open Previous Editor in Group', category: 'View', when: hasEditor, run: () => editors.openNeighbour(-1, true) }),
		commands.register({
			id: 'workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup',
			title: 'Quick Open Previous Recently Used Editor in Group',
			category: 'View',
			key: 'ctrl+tab',
			palette: false,
			run: () => showMru(1)
		}),
		commands.register({
			id: 'workbench.action.quickOpenLeastRecentlyUsedEditorInGroup',
			title: 'Quick Open Least Recently Used Editor in Group',
			category: 'View',
			key: 'ctrl+shift+tab',
			palette: false,
			run: () => showMru(-1)
		}),
		commands.register({ id: 'workbench.action.showAllEditors', title: 'Show All Editors By Appearance', category: 'View', key: 'cmd+k cmd+p', run: () => showAllEditors(false) }),
		commands.register({ id: 'workbench.action.showAllEditorsByMostRecentlyUsed', title: 'Show All Editors By Most Recently Used', category: 'View', run: () => showAllEditors(true) }),
		commands.register({ id: 'workbench.action.pinEditor', title: 'Pin Editor', category: 'View', key: 'cmd+k shift+enter', when: () => hasEditor() && !editors.isSticky(active()!), run: () => editors.stick(active()!) }),
		commands.register({ id: 'workbench.action.unpinEditor', title: 'Unpin Editor', category: 'View', key: 'cmd+k shift+enter', when: () => hasEditor() && editors.isSticky(active()!), run: () => editors.unstick(active()!) }),
		commands.register({ id: 'workbench.action.splitEditorLeft', title: 'Split Editor Left', category: 'View', run: () => editors.split('left') }),
		commands.register({ id: 'workbench.action.splitEditorRight', title: 'Split Editor Right', category: 'View', run: () => editors.split('right') }),
		commands.register({ id: 'workbench.action.splitEditorUp', title: 'Split Editor Up', category: 'View', run: () => editors.split('up') }),
		commands.register({ id: 'workbench.action.files.newUntitledFile', title: 'New Untitled Text File', category: 'File', key: 'cmd+n', run: newUntitled }),
		commands.register({
			id: 'workbench.action.files.saveAs',
			title: 'Save As...',
			category: 'File',
			key: 'cmd+shift+s',
			when: () => editors.focusedFile !== null && !isDiffKey(editors.focusedFile) && !isNonTextEditor(editors.focusedFile),
			run: () => saveAs(editors.focusedFile!)
		}),
		commands.register({
			id: 'workbench.action.files.revert',
			title: 'Revert File',
			category: 'File',
			when: () => editors.focusedFile !== null && editors.isDirty(editors.focusedFile),
			run: () => revertFile(editors.focusedFile!).catch((e) => notifications.error(`Revert ไม่สำเร็จ: ${e}`))
		}),
		commands.register({ id: 'copyFilePath', title: 'Copy Path of Active File', category: 'File', key: 'alt+ctrl+c', mac: 'alt+cmd+c', keyWhen: notInExplorerOrEditor, when: () => hasEditor() && isFileEditor(active()!), run: () => copyPath(active()!) }),
		commands.register({ id: 'copyRelativeFilePath', title: 'Copy Relative Path of Active File', category: 'File', key: 'ctrl+shift+alt+c', mac: 'alt+shift+cmd+c', keyWhen: notInExplorerOrEditor, when: () => hasEditor() && isFileEditor(active()!), run: () => copyRelativePath(active()!) }),
		commands.register({ id: 'revealFileInOS', title: 'Reveal Active File in Finder', category: 'File', key: 'shift+alt+r', mac: 'alt+cmd+r', keyWhen: notInExplorerOrEditor, when: () => hasEditor() && isFileEditor(active()!), run: () => revealInOS(active()!) }),
		commands.register({ id: 'workbench.files.action.showActiveFileInExplorer', title: 'Reveal Active File in Explorer View', category: 'File', when: () => hasEditor() && isFileEditor(active()!), run: () => revealInExplorer(active()!) })
	];
	return () => unregister.forEach((u) => u());
}
