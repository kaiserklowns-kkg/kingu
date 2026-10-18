// The close guard's live side: asks the PTY host what each terminal runs in front of its shell
// and, when terminal.integrated.confirmOnKill covers that location, asks before killing it.

import { ask } from '@tauri-apps/plugin-dialog';
import { KNOWN_BINS } from '#lib/ade/agentProfiles.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { asksOnKill, closePrompt, runningJobs, type TerminalLocation } from './closeGuard.ts';
import { foregroundJobs } from './pty.ts';

/** True when the terminals of `keys` may be killed: nothing runs in them, the setting does not ask here, or the user said so. */
export async function confirmKill(keys: string[], location: TerminalLocation, label: string): Promise<boolean> {
	if (!keys.length || !asksOnKill(settings.get('terminal.integrated.confirmOnKill'), location)) return true;
	const running = runningJobs(await foregroundJobs(keys));
	if (!running.length) return true;
	const p = closePrompt(location, running.map((r) => r.name), KNOWN_BINS, label);
	return ask(p.message, { title: p.title, kind: 'warning', okLabel: p.ok, cancelLabel: 'ยกเลิก' });
}
