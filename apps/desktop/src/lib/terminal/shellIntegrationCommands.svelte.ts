// VS Code's shell integration commands (Go to Previous/Next Command, Select To Previous/Next
// Command, Run Recent Command, Go to Recent Directory, Copy Last Command…) and the terminal
// extras (New Terminal With Profile, Select Default Profile, Run Selected Text / Active File,
// Change Icon / Color, terminals in the editor area). Keys act in a focused panel terminal,
// like VS Code's `terminalFocus`.

import { invoke } from '@tauri-apps/api/core';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { absolutePath } from '#lib/workbench/workspaceFolders.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { profileNames, shellPlatform } from '#lib/settings/mappings.ts';
import { t } from '#lib/i18n/index.ts';
import { focusedTerminal, focusTerminal, lastTerminal, terminalHandle, type TerminalHandle } from './registry.ts';
import { terminals } from './terminals.svelte.ts';
import { pickTerminalFolder } from './newTerminal.ts';
import { cdCommand, commandInput, recentCommandItems, recentDirectoryItems, shellQuote, TerminalHistory } from './commandHistory.ts';
import { activeEditorTerminal, createTerminalInEditor, installTerminalEditors, moveTerminalToEditor, moveTerminalToPanel } from './terminalEditor.svelte.ts';
import { TAB_COLORS, TAB_ICONS } from './tabAppearance.ts';

const history = () => new TerminalHistory(typeof localStorage === 'undefined' ? undefined : localStorage);

/** A panel terminal has focus (VS Code's `terminalFocus`; the editor area's terminals count too). */
const panelTerminalFocus = () => !appMode.isAgents && focusedTerminal('ide') !== null;

/** The terminal a command acts on: the focused one, else the last used, else the panel's active one. */
function target(): TerminalHandle | null {
	return focusedTerminal() ?? lastTerminal() ?? (terminals.tag ? terminalHandle(terminals.key(terminals.active)) : null);
}

/** Watches Alt while a picker is open: VS Code types a picked entry without running it when Alt is held. */
function watchAlt(): { held: () => boolean; stop: () => void } {
	let held = false;
	const on = (e: KeyboardEvent) => {
		held = e.altKey;
	};
	window.addEventListener('keydown', on, true);
	window.addEventListener('keyup', on, true);
	return {
		held: () => held,
		stop: () => {
			window.removeEventListener('keydown', on, true);
			window.removeEventListener('keyup', on, true);
		}
	};
}

async function runRecentCommand() {
	const h = target();
	if (!h) return status.flash(t('terminal.noTerminal'));
	const shell = h.shell?.() ?? '';
	const session = h.integration?.tracker.commands.filter((c) => c.kind === 'command' && c.command).map((c) => c.command) ?? [];
	const shellFile = await invoke<string[]>('terminal_shell_history', { shell, limit: null }).catch(() => [] as string[]);
	const { items, entries } = recentCommandItems(
		{ session, previous: history().commands(shell), shellFile },
		{ session: t('terminal.recent.session'), previous: t('terminal.recent.previous'), shellFile: t('terminal.recent.shellFile') }
	);
	if (!items.length) return status.flash(t('terminal.recent.none'));
	const alt = watchAlt();
	const picked = await quick.choose({ placeholder: t('terminal.recent.placeholder'), items });
	alt.stop();
	const text = picked && entries.get(picked.id);
	if (!text) return;
	h.write(commandInput(text, !alt.held(), h.bracketedPaste?.() ?? false));
	h.focus();
}

async function goToRecentDirectory() {
	const h = target();
	if (!h) return status.flash(t('terminal.noTerminal'));
	const shell = h.shell?.() ?? '';
	const items = recentDirectoryItems(h.integration?.tracker.directories ?? [], history().directories(shell), { session: t('terminal.dirs.session'), previous: t('terminal.dirs.previous') }, workspace.home || undefined);
	if (!items.length) return status.flash(t('terminal.dirs.none'));
	const alt = watchAlt();
	const picked = await quick.choose({ placeholder: t('terminal.dirs.placeholder'), items });
	alt.stop();
	if (!picked) return;
	h.write(commandInput(cdCommand(picked.id, shell), !alt.held(), false));
	h.focus();
}

function navigate(direction: -1 | 1, select: boolean) {
	const h = focusedTerminal() ?? target();
	if (!h) return;
	const done = select ? h.integration?.selectToCommand(direction) : h.integration?.scrollToCommand(direction);
	// No commands detected: scroll by a page, like a terminal without shell integration.
	if (!done && !select) h.scrollPage?.(direction);
}

function copyLast(what: 'command' | 'output' | 'both') {
	const h = target();
	const last = h?.integration?.last();
	if (!h || !last) return status.flash(t('terminal.noCommands'));
	const output = h.integration!.output(last);
	if (what !== 'command' && !output && what === 'output') return status.flash(t('terminal.noOutput'));
	const text = what === 'command' ? last.command : what === 'output' ? output : `${last.command}\n${output}`;
	void navigator.clipboard?.writeText(text).then(() => status.flash(t('terminal.copied')), () => {});
}

/** The panel terminal to change (the active one), or the editor terminal in front. */
function activeTerminalId(): number | null {
	const inEditor = activeEditorTerminal();
	if (inEditor !== null && focusedTerminal()?.key === terminals.key(inEditor)) return inEditor;
	return terminals.get(terminals.active) ? terminals.active : inEditor;
}

/** A profile name: `args.profileName` (a keybinding's), else picked. Undefined when dismissed or unknown. */
async function pickProfile(args: unknown, placeholder: string): Promise<string | undefined> {
	const platform = shellPlatform();
	const names = profileNames((id) => settings.get(id), platform);
	const given = args && typeof args === 'object' && typeof (args as { profileName?: unknown }).profileName === 'string' ? (args as { profileName: string }).profileName : undefined;
	if (given !== undefined) {
		if (names.includes(given)) return given;
		status.flash(t('terminal.profile.unknown', { name: given }));
		return undefined;
	}
	const current = settings.get<string | null>(`terminal.integrated.defaultProfile.${platform}`);
	const picked = await quick.choose({ placeholder, items: names.map((n) => ({ id: n, label: n, ...(n === current ? { description: t('terminal.profile.isDefault') } : {}) })) });
	return picked?.id;
}

async function newWithProfile(args: unknown) {
	const profile = await pickProfile(args, t('terminal.profile.pick'));
	if (!profile) return;
	const folder = await pickTerminalFolder();
	if (folder === undefined) return;
	const location = args && typeof args === 'object' ? (args as { location?: unknown }).location : undefined;
	if (location === 'editor' || (location && typeof location === 'object' && 'viewColumn' in location)) {
		createTerminalInEditor({ profile, ...(folder ? { folder } : {}) });
		return;
	}
	layout.showPanel('terminal');
	const id = terminals.open({ profile, ...(folder ? { folder } : {}) });
	focusTerminal(terminals.key(id));
}

async function selectDefaultProfile() {
	const profile = await pickProfile(undefined, t('terminal.profile.pickDefault'));
	if (!profile) return;
	await settings.set(`terminal.integrated.defaultProfile.${shellPlatform()}`, profile, 'user').catch(() => {});
	status.flash(t('terminal.profile.defaultSet', { name: profile }));
}

/** The panel's active terminal, opening one when there is none; waits until it is mounted. */
async function panelTerminal(): Promise<TerminalHandle | null> {
	layout.showPanel('terminal');
	if (!terminals.groups.length) terminals.open();
	for (let i = 0; i < 40; i++) {
		const h = terminalHandle(terminals.key(terminals.active));
		if (h) return h;
		await new Promise((r) => setTimeout(r, 50));
	}
	return null;
}

/** Run Selected Text In Active Terminal: the selection, else the cursor's line. */
async function runSelectedText() {
	const path = editors.active;
	const selection = editors.selectionText();
	const text = selection || (path ? (editors.textModel(path)?.getLineContent(editors.cursor.line) ?? '') : '');
	if (!text.trim()) return status.flash(t('terminal.run.nothing'));
	const h = focusedTerminal() ?? (await panelTerminal());
	if (!h) return;
	h.write(commandInput(text.replace(/\r?\n$/, ''), true, h.bracketedPaste?.() ?? false));
}

/** Run Active File In Active Terminal: the active file's path, quoted for the shell. */
async function runActiveFile() {
	const path = editors.active;
	const file = path && !path.includes(':') ? absolutePath(path, workspace.folders) : null;
	if (!file) return status.flash(t('terminal.run.noFile'));
	const h = await panelTerminal();
	if (!h) return;
	h.write(commandInput(shellQuote(file, h.shell?.()), true, false));
}

async function changeIcon() {
	const id = activeTerminalId();
	if (id === null) return status.flash(t('terminal.noTerminal'));
	const current = terminals.get(id)?.icon ?? 'terminal';
	const picked = await quick.choose({ placeholder: t('terminal.icon.pick'), activeId: current, items: TAB_ICONS.map((i) => ({ id: i.icon, label: i.codicon })) });
	if (picked) terminals.update(id, { icon: picked.id });
}

async function changeColor() {
	const id = activeTerminalId();
	if (id === null) return status.flash(t('terminal.noTerminal'));
	const items = [...TAB_COLORS.map((c) => ({ id: c, label: t(`terminal.color.${c.slice('terminal.'.length) as 'ansiRed'}`), description: c })), { id: '', label: t('terminal.color.reset') }];
	const picked = await quick.choose({ placeholder: t('terminal.color.pick'), activeId: terminals.get(id)?.color, items });
	if (picked) terminals.update(id, { color: picked.id || undefined });
}

export function installShellIntegrationCommands(): () => void {
	// Split Terminal starts where the source's shell said it is (terminals.svelte.ts).
	terminals.reportedCwd = (key) => terminalHandle(key)?.integration?.tracker.cwd;
	const panelShown = () => !appMode.isAgents && terminals.tag !== null;
	const hasTerminal = () => focusedTerminal() !== null || panelShown();
	const unregister = [
		commands.register({ id: 'workbench.action.terminal.scrollToPreviousCommand', title: 'Scroll To Previous Command', category: 'Terminal', key: 'ctrl+up', mac: 'cmd+up', when: hasTerminal, keyWhen: panelTerminalFocus, run: () => navigate(-1, false) }),
		commands.register({ id: 'workbench.action.terminal.scrollToNextCommand', title: 'Scroll To Next Command', category: 'Terminal', key: 'ctrl+down', mac: 'cmd+down', when: hasTerminal, keyWhen: panelTerminalFocus, run: () => navigate(1, false) }),
		commands.register({ id: 'workbench.action.terminal.selectToPreviousCommand', title: 'Select To Previous Command', category: 'Terminal', key: 'ctrl+shift+up', mac: 'cmd+shift+up', when: hasTerminal, keyWhen: panelTerminalFocus, run: () => navigate(-1, true) }),
		commands.register({ id: 'workbench.action.terminal.selectToNextCommand', title: 'Select To Next Command', category: 'Terminal', key: 'ctrl+shift+down', mac: 'cmd+shift+down', when: hasTerminal, keyWhen: panelTerminalFocus, run: () => navigate(1, true) }),
		commands.register({
			id: 'kingu.terminal.selectLastCommandOutput',
			title: 'Select Output of Last Command',
			category: 'Terminal',
			when: hasTerminal,
			run: () => {
				if (!target()?.integration?.selectOutput()) status.flash(t('terminal.noOutput'));
			}
		}),
		commands.register({ id: 'workbench.action.terminal.copyLastCommand', title: 'Copy Last Command', category: 'Terminal', when: hasTerminal, run: () => copyLast('command') }),
		commands.register({ id: 'workbench.action.terminal.copyLastCommandOutput', title: 'Copy Last Command Output', category: 'Terminal', when: hasTerminal, run: () => copyLast('output') }),
		commands.register({ id: 'workbench.action.terminal.copyLastCommandAndLastCommandOutput', title: 'Copy Last Command and its Output', category: 'Terminal', when: hasTerminal, run: () => copyLast('both') }),
		commands.register({ id: 'workbench.action.terminal.runRecentCommand', title: 'Run Recent Command...', category: 'Terminal', key: 'ctrl+alt+r', when: hasTerminal, keyWhen: panelTerminalFocus, run: () => void runRecentCommand() }),
		// ⌘G off macOS is Ctrl+G, Go to Line's key: in a focused terminal this one wins (VS Code's terminalFocus).
		commands.register({ id: 'workbench.action.terminal.goToRecentDirectory', title: 'Go to Recent Directory...', category: 'Terminal', key: 'ctrl+g', mac: 'cmd+g', weight: 1, when: hasTerminal, keyWhen: panelTerminalFocus, run: () => void goToRecentDirectory() }),
		commands.register({ id: 'workbench.action.terminal.newWithProfile', title: 'Create New Terminal (With Profile)', category: 'Terminal', run: (args) => void newWithProfile(args) }),
		commands.register({ id: 'workbench.action.terminal.selectDefaultShell', title: 'Select Default Profile', category: 'Terminal', run: () => void selectDefaultProfile() }),
		commands.register({ id: 'workbench.action.terminal.runSelectedText', title: 'Run Selected Text In Active Terminal', category: 'Terminal', when: () => editors.active !== null, run: () => void runSelectedText() }),
		commands.register({ id: 'workbench.action.terminal.runActiveFile', title: 'Run Active File In Active Terminal', category: 'Terminal', when: () => editors.active !== null, run: () => void runActiveFile() }),
		commands.register({ id: 'workbench.action.terminal.changeIcon', title: 'Change Icon...', category: 'Terminal', when: () => activeTerminalId() !== null, run: () => void changeIcon() }),
		commands.register({ id: 'workbench.action.terminal.changeColor', title: 'Change Color...', category: 'Terminal', when: () => activeTerminalId() !== null, run: () => void changeColor() }),
		commands.register({
			id: 'workbench.action.createTerminalEditor',
			title: 'Create New Terminal in Editor Area',
			category: 'Terminal',
			when: () => terminals.tag !== null,
			run: async () => {
				const folder = await pickTerminalFolder();
				if (folder !== undefined) createTerminalInEditor(folder ? { folder } : {});
			}
		}),
		commands.register({ id: 'workbench.action.terminal.moveToEditor', title: 'Move Terminal into Editor Area', category: 'Terminal', when: () => panelShown() && terminals.groups.length > 0, run: () => moveTerminalToEditor() }),
		commands.register({
			id: 'workbench.action.terminal.moveToTerminalPanel',
			title: 'Move Terminal into Panel',
			category: 'Terminal',
			when: () => activeEditorTerminal() !== null,
			run: () => {
				const id = activeEditorTerminal();
				if (id !== null) moveTerminalToPanel(id);
			}
		}),
		installTerminalEditors()
	];
	return () => unregister.forEach((u) => u());
}
