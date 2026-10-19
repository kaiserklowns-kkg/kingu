import type { chatRuntime as en } from '../en/chatRuntime';

export const chatRuntime = {
	'chatRuntime.label': 'เอเจนต์',
	'chatRuntime.hint': 'เอเจนต์ที่ทำงานในแชตนี้ (เฉพาะที่พบใน PATH เพิ่มเอเจนต์ ACP ได้ที่ kingu.agent.acpAgents)',
	'chatRuntime.current': 'แชตนี้ใช้ {name}',
	'chatRuntime.missing': '{name} (ไม่พบในเครื่อง)'
} satisfies Record<keyof typeof en, string>;
