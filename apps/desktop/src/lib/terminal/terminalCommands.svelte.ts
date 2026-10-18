// VS Code's terminal commands for the IDE panel (terminalActions.ts, macOS keys), plus Find, which
// the ADE's terminals share. Keys act only while a terminal has focus (VS Code's terminalFocus).

import { commands } from '#lib/workbench/commands.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { focusedTerminal, terminalHandle } from './registry.ts';
import { terminals } from './terminals.svelte.ts';

/** A panel terminal has focus (VS Code's `terminalFocus`). */
export const panelTerminalFocus = () => !appMode.isAgents && focusedTerminal('ide') !== null;

export function installTerminalCommands(): () => void {
	const panelShown = () => !appMode.isAgents && terminals.tag !== null;
	const active = () => terminalHandle(terminals.key(terminals.active));
	const unregister = [
		commands.register({
			id: 'workbench.action.terminal.focusFind',
			title: 'Find',
			category: 'Terminal',
			key: 'cmd+f',
			when: () => focusedTerminal() !== null || panelShown(),
			keyWhen: () => focusedTerminal() !== null,
			run: () => {
				const h = focusedTerminal() ?? (layout.showPanel('terminal'), active());
				h?.find();
			}
		}),
		commands.register({
			id: 'workbench.action.terminal.clear',
			title: 'Clear',
			category: 'Terminal',
			// VS Code binds it on macOS only (⌘K); elsewhere Ctrl+K belongs to the shell.
			mac: 'cmd+k',
			when: panelShown,
			keyWhen: panelTerminalFocus,
			run: () => (focusedTerminal('ide') ?? active())?.clear()
		}),
		commands.register({
			id: 'workbench.action.terminal.selectAll',
			title: 'Select All',
			category: 'Terminal',
			mac: 'cmd+a',
			when: () => focusedTerminal() !== null,
			run: () => focusedTerminal()?.selectAll()
		}),
		commands.register({ id: 'workbench.action.terminal.new', title: 'Create New Terminal', category: 'Terminal', key: 'ctrl+shift+`', run: () => (layout.showPanel('terminal'), terminals.open()) }),
		commands.register({
			id: 'workbench.action.terminal.split',
			title: 'Split Terminal',
			category: 'Terminal',
			key: 'ctrl+shift+5',
			mac: 'cmd+\\',
			when: panelShown,
			keyWhen: panelTerminalFocus,
			run: () => (layout.showPanel('terminal'), terminals.split())
		}),
		commands.register({
			id: 'workbench.action.terminal.focusPreviousPane',
			title: 'Focus Previous Terminal in Terminal Group',
			category: 'Terminal',
			key: 'alt+left',
			mac: 'cmd+alt+left',
			when: () => panelShown() && terminals.splitActive,
			keyWhen: panelTerminalFocus,
			run: () => terminals.focusPane(-1)
		}),
		commands.register({
			id: 'workbench.action.terminal.focusNextPane',
			title: 'Focus Next Terminal in Terminal Group',
			category: 'Terminal',
			key: 'alt+right',
			mac: 'cmd+alt+right',
			when: () => panelShown() && terminals.splitActive,
			keyWhen: panelTerminalFocus,
			run: () => terminals.focusPane(1)
		}),
		commands.register({ id: 'workbench.action.terminal.rename', title: 'Rename...', category: 'Terminal', when: panelShown, run: () => terminals.rename() }),
		commands.register({ id: 'workbench.action.terminal.kill', title: 'Kill the Active Terminal Instance', category: 'Terminal', when: panelShown, run: () => terminals.kill(terminals.active) })
	];
	return () => unregister.forEach((u) => u());
}
