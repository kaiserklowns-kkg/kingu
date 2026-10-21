// VS Code's terminal commands for the IDE panel (terminalActions.ts, macOS keys), plus Find, which
// the ADE's terminals share. Keys act only while a terminal has focus (VS Code's terminalFocus).

import { commands } from '#lib/workbench/commands.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { focusedTerminal, lastAdeTerminal, terminalHandle } from './registry.ts';
import { terminals } from './terminals.svelte.ts';
import { createTerminal, createTerminalInActiveFolder } from './newTerminal.ts';
import { quickCommandInput, quickCommands } from './adeTerminalOptions.ts';
import { t } from '#lib/i18n/index.ts';

/** Orca's quick commands (`kingu.terminal.quickCommands`): pick one, typed into the last used ADE terminal. */
async function runQuickCommand() {
	const list = quickCommands(settings.get<Record<string, unknown>>('kingu.terminal.quickCommands'));
	const target = focusedTerminal('ade') ?? lastAdeTerminal();
	if (!list.length) return status.flash(t('tools.terminal.quick.none'));
	if (!target) return status.flash(t('tools.terminal.quick.openTerminal'));
	const picked = await quick.choose({ placeholder: t('tools.terminal.quick.pick'), items: list.map((q, i) => ({ id: String(i), label: q.label, description: q.command.split('\n')[0] })) });
	if (!picked) return;
	target.write(quickCommandInput(list[Number(picked.id)].command));
	target.focus();
}

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
		// A multi-root window asks which folder the terminal starts in (newTerminal.ts).
		commands.register({ id: 'workbench.action.terminal.new', title: 'Create New Terminal', category: 'Terminal', key: 'ctrl+shift+`', run: () => void createTerminal() }),
		commands.register({ id: 'workbench.action.terminal.newInActiveWorkspace', title: 'Create New Terminal (In Active Workspace)', category: 'Terminal', run: () => void createTerminalInActiveFolder() }),
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
		commands.register({ id: 'workbench.action.terminal.kill', title: 'Kill the Active Terminal Instance', category: 'Terminal', when: panelShown, run: () => terminals.kill(terminals.active) }),
		commands.register({ id: 'kingu.terminal.runQuickCommand', title: 'Run Quick Command…', category: 'Terminal', run: () => void runQuickCommand() })
	];
	return () => unregister.forEach((u) => u());
}
