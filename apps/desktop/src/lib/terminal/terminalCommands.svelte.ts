// VS Code's terminal commands for the IDE panel (terminalActions.ts, macOS keys), plus Find, which
// the ADE's terminals share. Keys act only while a terminal has focus (VS Code's terminalFocus).

import { commands } from '#lib/workbench/commands.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { focusTerminal, focusedTerminal, lastAdeTerminal, terminalHandle } from './registry.ts';
import { terminals } from './terminals.svelte.ts';
import { codeTerminalFolder, createTerminal, createTerminalInActiveFolder } from './newTerminal.ts';
import { quickCommandInput, quickCommands } from './adeTerminalOptions.ts';
import { t } from '#lib/i18n/index.ts';
import { installShellIntegrationCommands } from './shellIntegrationCommands.svelte.ts';

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

const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
/** Resize Pane Left / Right: VS Code's keys exist on macOS and Linux only. */
const resizeKeys = () => !isWindows && panelTerminalFocus();

export function installTerminalCommands(): () => void {
	// Terminals opened by code start in the active editor's folder (VS Code's last active workspace root).
	terminals.defaultFolder = codeTerminalFolder;
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
		// Between terminal groups (VS Code: ⇧⌘] / ⇧⌘[ on macOS, Ctrl+PageDown / PageUp elsewhere), wrapping.
		commands.register({
			id: 'workbench.action.terminal.focusNext',
			title: 'Focus Next Terminal Group',
			category: 'Terminal',
			key: 'ctrl+pagedown',
			mac: 'cmd+shift+]',
			when: panelShown,
			keyWhen: panelTerminalFocus,
			run: () => (layout.showPanel('terminal'), terminals.focusGroup(1))
		}),
		commands.register({
			id: 'workbench.action.terminal.focusPrevious',
			title: 'Focus Previous Terminal Group',
			category: 'Terminal',
			key: 'ctrl+pageup',
			mac: 'cmd+shift+[',
			when: panelShown,
			keyWhen: panelTerminalFocus,
			run: () => (layout.showPanel('terminal'), terminals.focusGroup(-1))
		}),
		// ⌃⌘← → ↑ ↓ on macOS; Ctrl+Shift+← / → on Linux (VS Code binds no key on Windows, where the keys stay with the shell).
		commands.register({ id: 'workbench.action.terminal.resizePaneLeft', title: 'Resize Terminal Left', category: 'Terminal', key: 'ctrl+shift+left', mac: 'cmd+ctrl+left', when: panelShown, keyWhen: resizeKeys, run: () => terminals.resizePane('left') }),
		commands.register({ id: 'workbench.action.terminal.resizePaneRight', title: 'Resize Terminal Right', category: 'Terminal', key: 'ctrl+shift+right', mac: 'cmd+ctrl+right', when: panelShown, keyWhen: resizeKeys, run: () => terminals.resizePane('right') }),
		commands.register({ id: 'workbench.action.terminal.resizePaneUp', title: 'Resize Terminal Up', category: 'Terminal', mac: 'cmd+ctrl+up', when: panelShown, keyWhen: panelTerminalFocus, run: () => terminals.resizePane('up') }),
		commands.register({ id: 'workbench.action.terminal.resizePaneDown', title: 'Resize Terminal Down', category: 'Terminal', mac: 'cmd+ctrl+down', when: panelShown, keyWhen: panelTerminalFocus, run: () => terminals.resizePane('down') }),
		commands.register({
			id: 'workbench.action.terminal.focus',
			title: 'Focus Terminal',
			category: 'Terminal',
			when: () => !appMode.isAgents && terminals.tag !== null,
			run: () => {
				// Showing an empty terminal view starts a terminal (terminals.svelte.ts).
				layout.showPanel('terminal');
				queueMicrotask(() => focusTerminal(terminals.key(terminals.active)));
			}
		}),
		commands.register({ id: 'workbench.action.quickOpenTerm', title: 'Switch Active Terminal', category: 'Terminal', when: () => !appMode.isAgents, run: () => quick.show('term ') }),
		commands.register({ id: 'workbench.action.terminal.rename', title: 'Rename...', category: 'Terminal', when: panelShown, run: () => terminals.rename() }),
		commands.register({ id: 'workbench.action.terminal.kill', title: 'Kill the Active Terminal Instance', category: 'Terminal', when: panelShown, run: () => terminals.kill(terminals.active) }),
		commands.register({ id: 'kingu.terminal.runQuickCommand', title: 'Run Quick Command…', category: 'Terminal', run: () => void runQuickCommand() }),
		installShellIntegrationCommands()
	];
	return () => unregister.forEach((u) => u());
}
