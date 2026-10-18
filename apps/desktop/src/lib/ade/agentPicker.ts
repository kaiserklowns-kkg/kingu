// "Agent: Choose CLI…": the known agent CLIs found on the login-shell PATH, plus a custom command;
// the choice goes to `kingu.agent.cli` (user settings).

import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { enabledBins, parseCliCommand } from '#lib/ade/agentCli.ts';
import { CUSTOM_PICK, KNOWN_BINS, pickerItems, profileOf } from '#lib/ade/agentProfiles.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';

export async function chooseAgentCli() {
	const current = (settings.get<string>('kingu.agent.cli') ?? '').trim();
	const currentArgv = parseCliCommand(current);
	const currentProfile = currentArgv ? profileOf(currentArgv) : null;
	// kingu.agent.disabled (Orca's disabledTuiAgents) hides agents; detection itself stays a PATH scan.
	const found = enabledBins(
		await invoke<string[]>('agent_cli_found', { names: KNOWN_BINS }).catch(() => [] as string[]),
		settings.get<string[]>('kingu.agent.disabled'),
		currentProfile?.id ?? null
	);
	const picked = await quick.choose({
		placeholder: found.length ? t('ade.agentPicker.placeholder') : t('ade.agentPicker.placeholderNone'),
		items: pickerItems(found, current),
		activeId: currentProfile?.bins.find((b) => found.includes(b))
	});
	if (!picked) return;
	let value: string | undefined;
	if (picked.id === CUSTOM_PICK) {
		value = await quick.input({
			placeholder: t('ade.agentPicker.inputPlaceholder'),
			hint: (v) => (!v.trim() ? t('ade.agentPicker.hintEmpty') : parseCliCommand(v) ? t('ade.agentPicker.hintUse', { command: v.trim(), agent: profileOf(parseCliCommand(v) ?? []).title }) : t('ade.agentPicker.hintShell'))
		});
		if (!value?.trim()) return;
		if (!parseCliCommand(value)) {
			status.flash(t('ade.agentPicker.plainCommand'), 8000);
			return;
		}
		value = value.trim();
	} else {
		// The same CLI keeps the flags already set (e.g. `claude --model opus`).
		value = currentProfile && currentProfile.bins.includes(picked.id) ? current : picked.id;
	}
	try {
		await settings.set('kingu.agent.cli', value, 'user');
		status.flash(t('ade.agentPicker.set', { command: value }));
	} catch (e) {
		notifications.error(t('ade.agentPicker.setFailed', { error: String(e) }));
	}
}
