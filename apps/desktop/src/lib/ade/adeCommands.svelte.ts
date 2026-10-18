// Orca's tab and pane shortcuts (adeShortcuts.ts) as commands. They run only while the Agents
// layout is in front, so the same keys keep their IDE meaning there (⌘D, ⌘⇧D, ⌘T…).

import { commands } from '#lib/workbench/commands.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { focusedTerminal } from '#lib/terminal/registry.ts';
import { ADE_SHORTCUTS as K, selectTabShortcut, type Shortcut } from './adeShortcuts.ts';
import { adeLayout } from './adeLayout.svelte';
import { tabPanes } from './adeTabs.ts';

/** The Agents layout is what the window shows. */
export const adeInFront = () => appMode.isAgents && !systemSettings.visible;

export function installAdeCommands(): () => void {
	const front = () => adeInFront() && workspace.root !== null;
	const terminal = () => (front() ? adeLayout.activeTerminal() : null);
	const split = () => {
		const t = terminal();
		return !!t && tabPanes(t.tab).length > 1;
	};
	const cmd = (s: Shortcut, run: () => unknown, when: () => boolean = front) => commands.register({ ...s, category: 'Agents', when, run });
	const unregister = [
		cmd(K.newTerminal, () => adeLayout.newTerminal(adeLayout.key)),
		cmd(K.reopenClosed, () => adeLayout.reopenClosed(adeLayout.key), () => front() && (adeLayout.closed[adeLayout.key]?.length ?? 0) > 0),
		cmd(K.rename, () => {
			const t = terminal();
			if (t) void adeLayout.rename(t.key, t.tab.id);
		}, () => terminal() !== null),
		cmd(K.recentNext, () => adeLayout.switchRecent(1)),
		cmd(K.recentPrevious, () => adeLayout.switchRecent(-1)),
		cmd(K.next, () => adeLayout.cycle(adeLayout.key, 1)),
		cmd(K.previous, () => adeLayout.cycle(adeLayout.key, -1)),
		cmd(K.nextSameType, () => adeLayout.cycle(adeLayout.key, 1, 'same')),
		cmd(K.previousSameType, () => adeLayout.cycle(adeLayout.key, -1, 'same')),
		cmd(K.nextTerminal, () => adeLayout.cycle(adeLayout.key, 1, 'terminal')),
		cmd(K.previousTerminal, () => adeLayout.cycle(adeLayout.key, -1, 'terminal')),
		...Array.from({ length: 9 }, (_, i) => cmd({ ...selectTabShortcut(i + 1) }, () => adeLayout.selectIndex(adeLayout.key, i + 1))),
		cmd(K.splitRight, () => {
			const t = terminal();
			if (t) adeLayout.split(t.key, t.tab.id, 'vertical');
		}, () => terminal() !== null),
		cmd(K.splitDown, () => {
			const t = terminal();
			if (t) adeLayout.split(t.key, t.tab.id, 'horizontal');
		}, () => terminal() !== null),
		cmd(K.focusNextPane, () => {
			const t = terminal();
			if (t) adeLayout.focusPane(t.key, t.tab.id, 1);
		}, split),
		cmd(K.focusPreviousPane, () => {
			const t = terminal();
			if (t) adeLayout.focusPane(t.key, t.tab.id, -1);
		}, split),
		cmd(K.expandPane, () => {
			const t = terminal();
			if (t) adeLayout.toggleExpand(t.key, t.tab.id);
		}, split),
		cmd(K.equalizePanes, () => {
			const t = terminal();
			if (t) adeLayout.equalize(t.key, t.tab.id);
		}, split),
		cmd(K.closePane, () => {
			const t = terminal();
			if (t) void adeLayout.closePane(t.key, t.tab.id);
		}, split),
		commands.register({ ...K.clear, category: 'Terminal', when: () => front() && focusedTerminal('ade') !== null, run: () => focusedTerminal('ade')?.clear() })
	];
	return () => unregister.forEach((u) => u());
}
