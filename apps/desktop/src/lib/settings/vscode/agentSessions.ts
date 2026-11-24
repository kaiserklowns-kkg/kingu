// VS Code settings of the Agents window that Kingu's Agents mode applies. Key, type, default and
// English description are VS Code's; the Thai text is Kingu's.
// - `chat.automations.enabled`: src/vs/sessions/contrib/automations/browser/automations.contribution.ts
//   (MACHINE scope there; user-only here, so a repository cannot turn scheduled runs back on).
//   Read by ade/automations.svelte.ts (`featureEnabled`): off hides Automations and dispatches nothing.
// - `sessions.list.inboxEnabled`: src/vs/workbench/contrib/sessions/browser/sessionsConfiguration.ts
//   (experimental, off by default). Read by ade/sessionInbox.svelte.ts: on shows the Inbox page.
import type { SettingSchema } from '../registry';

export const AGENT_SESSIONS_SETTINGS: SettingSchema[] = [
	{
		id: 'chat.automations.enabled',
		group: 'Agent',
		type: 'boolean',
		default: true,
		description:
			'เปิดใช้ Automations: ให้ agent เริ่มงานตามตารางเวลา ปิดแล้วจะซ่อนหน้า Automations และไม่มี automation ใดเริ่มตามเวลา (Enables the Automations feature: scheduling agent sessions to run on a cadence. When disabled, the Automations entry is hidden, and scheduled automations are not dispatched.)',
		scope: 'application',
		tags: ['experimental']
	},
	{
		id: 'sessions.list.inboxEnabled',
		group: 'Agent',
		type: 'boolean',
		default: false,
		description:
			'แสดงหน้า Inbox ใน Agents: รวม agent ที่รอคุณ (คำถาม การขออนุญาต งานที่ล้มเหลวหรือเสร็จให้ตรวจ) จากทุกโปรเจกต์ แชต และ SSH host พร้อมเอาออก พักไว้ หรือเลื่อนไปก่อน (Shows a toggle on the Sessions list to open Inbox Mode and keeps session attention up to date even outside Inbox Mode. Turning the toggle off restores the previous grouping. Disabling this setting also leaves Inbox Mode.)',
		tags: ['experimental']
	}
];
