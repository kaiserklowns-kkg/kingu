// Asking before a close kills a running command (pure, so `bun test` covers it). VS Code's
// terminal.integrated.confirmOnKill decides where it asks: 'editor' (its default) for terminals in
// the editor area, which the ADE's center tabs are, 'panel' for the IDE panel, 'always' or 'never'.
// "Running" is the PTY's foreground job (tcgetpgrp) when it is not the shell, like Orca's guard;
// VS Code's terminal.integrated.ignoreProcessNames defaults are not counted.

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
		const message = names.length > 1 ? `ต้องการหยุด ${names.length} session ของ terminal ที่ทำงานอยู่?` : 'ต้องการหยุด session ของ terminal ที่ทำงานอยู่?';
		return { title: 'Kill Terminal', message: `${message}${list ? `\n\n${list}` : ''}`, ok: 'หยุด (Terminate)' };
	}
	const agent = names.some((n) => agentBins.includes(n));
	return agent
		? { title: 'หยุด agent นี้?', message: `ปิด terminal นี้จะหยุดงานที่ agent กำลังทำอยู่ (${list})\n\n${label}`, ok: 'หยุด Agent' }
		: { title: 'หยุดคำสั่งที่กำลังรัน?', message: `ปิด terminal นี้จะหยุดคำสั่งที่รันอยู่ในนั้น${list ? ` (${list})` : ''}\n\n${label}`, ok: 'หยุดและปิด' };
}
