// The close guard's live side: asks the PTY host what each terminal runs in front of its shell
// and, when terminal.integrated.confirmOnKill covers that location, asks before killing it.

import { ask } from '#lib/workbench/messageBox.ts';
import { KNOWN_BINS } from '#lib/ade/agentProfiles.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { asksOnKill, closePrompt, confirmsOnExit, runningJobs, type TerminalLocation } from './closeGuard.ts';
import { foregroundJobs, listPtys } from './pty.ts';
import { t } from '#lib/i18n/index.ts';

/** terminal.integrated.ignoreProcessNames: foreground jobs that do not count as running. */
const ignored = () => settings.get<string[]>('terminal.integrated.ignoreProcessNames');

/** True when the terminals of `keys` may be killed: nothing runs in them, the setting does not ask here, or the user said so. */
export async function confirmKill(keys: string[], location: TerminalLocation, label: string): Promise<boolean> {
	if (!keys.length || !asksOnKill(settings.get('terminal.integrated.confirmOnKill'), location)) return true;
	const running = runningJobs(await foregroundJobs(keys), ignored());
	if (!running.length) return true;
	const p = closePrompt(location, running.map((r) => r.name), KNOWN_BINS, label);
	return ask(p.message, { title: p.title, kind: 'warning', okLabel: p.ok, cancelLabel: t('common.cancel') });
}

/**
 * terminal.integrated.confirmOnExit when the window closes: `always` asks while any terminal
 * session is live, `hasChildProcesses` only while one runs a command. True when closing may go on.
 */
export async function confirmTerminalExit(): Promise<boolean> {
	const setting = settings.get<string>('terminal.integrated.confirmOnExit');
	if (setting === 'never') return true;
	const keys = (await listPtys()).filter((s) => s.alive).map((s) => s.key);
	const running = setting === 'hasChildProcesses' && keys.length ? runningJobs(await foregroundJobs(keys), ignored()).length : 0;
	if (!confirmsOnExit(setting, keys.length, running)) return true;
	const n = setting === 'always' ? keys.length : running;
	return ask(t('tools.terminal.exit.message', { count: n }), {
		title: 'Kingu',
		kind: 'warning',
		okLabel: t('tools.terminal.kill.terminate'),
		cancelLabel: t('common.cancel')
	});
}
