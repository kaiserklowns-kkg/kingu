// Asking before a close kills a running command (pure, so `bun test` covers it). VS Code's
// terminal.integrated.confirmOnKill decides where it asks: 'editor' (its default) for terminals in
// the editor area, which the ADE's center tabs are, 'panel' for the IDE panel, 'always' or 'never'.
// "Running" is the PTY's foreground job (tcgetpgrp) when it is not the shell, like Orca's guard;
// VS Code's terminal.integrated.ignoreProcessNames defaults are not counted.

import { t } from '#lib/i18n/index.ts';

export type ConfirmOnKill = 'never' | 'editor' | 'panel' | 'always';
export type TerminalLocation = 'editor' | 'panel';
export type ForegroundJob = { pid: number; name: string };

export const CONFIRM_ON_KILL: readonly ConfirmOnKill[] = ['never', 'editor', 'panel', 'always'];
/** VS Code's terminal.integrated.ignoreProcessNames default. */
export const IGNORED_PROCESS_NAMES: readonly string[] = ['starship', 'oh-my-posh', 'bash', 'zsh'];

export function asksOnKill(setting: unknown, location: TerminalLocation): boolean {
	const value: ConfirmOnKill = CONFIRM_ON_KILL.includes(setting as ConfirmOnKill) ? (setting as ConfirmOnKill) : 'editor';
	return value === 'always' || value === location;
}

/** The terminals among `jobs` (by PTY key) running something other than an idle shell. */
export function runningJobs(jobs: Record<string, ForegroundJob>, ignore: readonly string[] = IGNORED_PROCESS_NAMES): { key: string; name: string }[] {
	return Object.entries(jobs)
		.filter(([, j]) => !ignore.includes(j.name.replace(/^-/, '')))
		.map(([key, j]) => ({ key, name: j.name }));
}

/** The IDE panel asks like VS Code ("terminate the active terminal session(s)?"); ADE tabs like
 *  Orca's dialog: an agent CLI gets "Stop this agent?", any other job "Stop running command?". */
export function closePrompt(location: TerminalLocation, names: string[], agentBins: readonly string[], label: string): { title: string; message: string; ok: string } {
	const list = [...new Set(names.filter(Boolean))].join(', ');
	if (location === 'panel') {
		const message = names.length > 1 ? t('tools.terminal.kill.panelMany', { count: names.length }) : t('tools.terminal.kill.panelOne');
		return { title: t('tools.terminal.kill.panelTitle'), message: `${message}${list ? `\n\n${list}` : ''}`, ok: t('tools.terminal.kill.terminate') };
	}
	const agent = names.some((n) => agentBins.includes(n));
	return agent
		? { title: t('tools.terminal.kill.agentTitle'), message: t('tools.terminal.kill.agentMessage', { list, label }), ok: t('tools.terminal.kill.agentOk') }
		: { title: t('tools.terminal.kill.commandTitle'), message: t('tools.terminal.kill.commandMessage', { list: list ? ` (${list})` : '', label }), ok: t('tools.terminal.kill.commandOk') };
}

/** terminal.integrated.confirmOnExit: whether closing the window asks, given the live sessions and how many run a command. */
export function confirmsOnExit(setting: string, sessions: number, running: number): boolean {
	if (setting === 'always') return sessions > 0;
	if (setting === 'hasChildProcesses') return running > 0;
	return false;
}
