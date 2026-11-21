// Orca's tab and pane shortcuts (adeShortcuts.ts) as commands. Scoped to the Agents layout: there
// they win over the IDE's commands on the same keys (⌘T, ⌘⇧T, ⌘D…), which keep them in the IDE.

import { commands } from '#lib/workbench/commands.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { systemSettings } from '#lib/settings/systemSettings.svelte.ts';
import { focusedTerminal } from '#lib/terminal/registry.ts';
import { ADE_SHORTCUTS as K, selectTabShortcut, type Shortcut } from './adeShortcuts.ts';
import { adeLayout, browserLabel } from './adeLayout.svelte';
import { browserAction } from '#lib/workbench/floating.ts';
import { tabPanes } from './adeTabs.ts';
import { cliName, parseCliCommand } from './agentCli';
import { isMarkdownEditor } from './adeMarkdown.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { workspaceSpace } from './workspaceSpace.svelte';

/** The Agents layout is what the window shows. */
export const adeInFront = () => appMode.isAgents && !systemSettings.visible;

export function installAdeCommands(): () => void {
	const front = () => adeInFront() && workspace.root !== null;
	const terminal = () => (front() ? adeLayout.activeTerminal() : null);
	const split = () => {
		const t = terminal();
		return !!t && tabPanes(t.tab).length > 1;
	};
	const cmd = (s: Shortcut, run: () => unknown, when: () => boolean = front) => commands.register({ ...s, category: 'Agents', scope: 'agents', when, run });
	const unregister = [
		cmd(K.newTerminal, () => adeLayout.newTerminal(adeLayout.key)),
		cmd(K.newBrowser, () => adeLayout.newBrowser(adeLayout.key)),
		cmd(K.newMarkdown, () => adeLayout.newMarkdown(adeLayout.key)),
		cmd(K.openMarkdown, () => void adeLayout.openMarkdown(adeLayout.key)),
		cmd(K.newAgent, () => {
			const argv = parseCliCommand(settings.get<string>('kingu.agent.cli') ?? '') ?? ['claude'];
			adeLayout.newTerminal(adeLayout.key, { title: cliName(argv), run: argv });
		}),
		cmd(K.markdownPreview, () => adeLayout.toggleMarkdownPreview(adeLayout.key), () => {
			const file = front() ? adeLayout.activeFile() : null;
			return !!file && isMarkdownEditor(file);
		}),
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
		cmd(K.quickCommands, () => adeLayout.quickMenuRequest++),
		cmd(K.equalizePanes, () => {
			const t = terminal();
			if (t) adeLayout.equalize(t.key, t.tab.id);
		}, split),
		cmd(K.closePane, () => {
			const t = terminal();
			if (t) void adeLayout.closePane(t.key, t.tab.id);
		}, split),
		commands.register({ ...K.clear, category: 'Terminal', scope: 'agents', when: () => front() && focusedTerminal('ade') !== null, run: () => focusedTerminal('ade')?.clear() }),
		// Orca's Workspace Space: disk used by each task's worktree (IDE and Agents layout alike).
		// Orca's browser tools while a browser tab is shown (zoom stays on the toolbar: ⌘= ⌘- ⌘0 zoom Kingu).
		// Back / Forward (⌘[ / ⌘] on macOS) and Focus Address Bar (⌘L): Orca's browser chords
		// (definitions-core-2/3.ts). Like find, they act while Kingu's own UI has the focus; keys typed
		// into the page stay with the page. Orca's Alt+← / Alt+→ off macOS are left out: a key scoped
		// to the Agents layout would take them from the quick input's Back there. ⌘[ / ⌘] are the
		// pane-focus keys too (a terminal tab is never the browser tab in front), and ⌘L (Toggle Right
		// Side Bar) gives way while a browser tab is in front, as Orca's browser scope does.
		...(
			[
				{ action: 'find', title: 'Browser: Find in Page', key: 'cmd+f' },
				{ action: 'devtools', title: 'Browser: Toggle Developer Tools', key: 'alt+cmd+i' },
				{ action: 'back', title: 'Browser: Go Back', mac: 'cmd+[' },
				{ action: 'forward', title: 'Browser: Go Forward', mac: 'cmd+]' },
				{ action: 'address', title: 'Browser: Focus Address Bar', key: 'cmd+l', weight: 1 },
				// Orca's browser.hardReload (Mod+Shift+R). It takes ⇧⌘R in the Agents layout only, where the
				// IDE's Search Again (a Search Editor) and Rerun Task (a task terminal) do not act.
				{ action: 'hardReload', title: 'Browser: Hard Reload', key: 'cmd+shift+r' }
			] as const
		).map(({ action, title, ...keys }) =>
			commands.register({
				id: `kingu.browser.${action}`,
				title,
				category: 'Browser',
				...keys,
				scope: 'agents',
				when: () => front() && adeLayout.activeBrowser() !== null,
				run: () => {
					const b = adeLayout.activeBrowser();
					if (b) browserAction(browserLabel(b.key, b.tab.id, b.tab.profile), action);
				}
			})
		),
		commands.register({ id: 'kingu.agents.workspaceSpace', title: 'Workspace Space…', category: 'Agents', when: () => workspace.root !== null, run: () => workspaceSpace.show() })
	];
	return () => unregister.forEach((u) => u());
}
