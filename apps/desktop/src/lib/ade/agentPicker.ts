// "Agent: Choose CLI…": the known agent CLIs found on the login-shell PATH, plus a custom command;
// the choice goes to `kingu.agent.cli` (user settings).

import { invoke } from '@tauri-apps/api/core';
import { settings } from '#lib/settings/settings.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { parseCliCommand } from '#lib/ade/agentCli.ts';
import { CUSTOM_PICK, KNOWN_BINS, pickerItems, profileOf } from '#lib/ade/agentProfiles.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';

export async function chooseAgentCli() {
	const current = (settings.get<string>('kingu.agent.cli') ?? '').trim();
	const found = await invoke<string[]>('agent_cli_found', { names: KNOWN_BINS }).catch(() => [] as string[]);
	const currentArgv = parseCliCommand(current);
	const currentProfile = currentArgv ? profileOf(currentArgv) : null;
	const picked = await quick.choose({
		placeholder: found.length ? 'เลือก agent CLI สำหรับโหมด terminal' : 'ไม่พบ agent CLI ที่รู้จักใน PATH ใช้คำสั่งเองได้',
		items: pickerItems(found, current),
		activeId: currentProfile?.bins.find((b) => found.includes(b))
	});
	if (!picked) return;
	let value: string | undefined;
	if (picked.id === CUSTOM_PICK) {
		value = await quick.input({
			placeholder: 'คำสั่ง agent CLI เช่น claude --model opus',
			hint: (v) => (!v.trim() ? 'พิมพ์คำสั่งแล้วกด Enter' : parseCliCommand(v) ? `ใช้ "${v.trim()}" (${profileOf(parseCliCommand(v) ?? []).title})` : 'ห้ามมีอักขระของ shell')
		});
		if (!value?.trim()) return;
		if (!parseCliCommand(value)) {
			status.flash('คำสั่ง agent CLI ต้องเป็นคำสั่งธรรมดา (ไม่มีอักขระของ shell)', 8000);
			return;
		}
		value = value.trim();
	} else {
		// The same CLI keeps the flags already set (e.g. `claude --model opus`).
		value = currentProfile && currentProfile.bins.includes(picked.id) ? current : picked.id;
	}
	try {
		await settings.set('kingu.agent.cli', value, 'user');
		status.flash(`งานใหม่โหมด terminal จะใช้ ${value}`);
	} catch (e) {
		notifications.error(`ตั้งค่า agent CLI ไม่ได้: ${e}`);
	}
}
