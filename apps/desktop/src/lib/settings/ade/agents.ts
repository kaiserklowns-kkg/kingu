// Orca's Agents, Chat and Notifications pages (groups Agent, Agent Chat, Notifications).
// Behaviour: ade/agentCli.ts (launch options), ade/agentPicker.ts (disabled agents),
// ade/promptCache.ts + CacheTimer.svelte (prompt-cache timer), ade/automations.svelte.ts.
import type { SettingSchema } from '../registry';
import { PROFILES } from '../../ade/agentProfiles';

const G = 'Agent';

/** `kingu.agent.env.<profile>` (Orca's agentDefaultEnv): launch environment per known agent CLI. */
function agentEnvSettings(): SettingSchema[] {
	return PROFILES.filter((p) => p.id !== 'custom').map((p) => ({
		id: `kingu.agent.env.${p.id}`,
		group: G,
		type: 'object' as const,
		values: 'string' as const,
		default: {},
		description: `ตัวแปร environment ที่ใส่ให้ ${p.title} เมื่อเริ่มในโหมด terminal เช่น { "DISABLE_AUTOUPDATER": "1" } ชื่อต้องเป็น A-Z 0-9 _ ค่าที่ hook ของ Kingu ตั้งเองชนะเสมอ (Orca: agentDefaultEnv) (Environment variables ${p.title} starts with in terminal mode; Kingu's own hook variables still win.)`,
		// User-only: an env var can change what the CLI may do.
		scope: 'application' as const
	}));
}

export const AGENT_SETTINGS: SettingSchema[] = [
	{
		id: 'kingu.agent.cmdOverrides',
		group: G,
		type: 'object',
		values: 'string',
		default: {},
		description:
			'โปรแกรมที่รันแทนของแต่ละ agent: id ของ profile → คำสั่งหรือ path เช่น { "claude": "/opt/claude-beta/claude" } ห้ามมีอักขระของ shell อาร์กิวเมนต์อื่นยังมาจาก kingu.agent.args.* (Orca: agentCmdOverrides) (The binary to run per agent profile instead of its default; a plain command or path.)',
		// User-only: it is a program Kingu runs.
		scope: 'application'
	},
	...agentEnvSettings(),
	{
		id: 'kingu.agent.disabled',
		group: G,
		type: 'array',
		items: 'string',
		default: [],
		description:
			'agent ที่ซ่อนจากตัวเลือก agent CLI ใส่ id ของ profile เช่น ["gemini", "aider"] agent ที่ใช้อยู่ตอนนี้ยังแสดงเสมอ (Orca: disabledTuiAgents) (Agent profiles hidden from the agent CLI picker; the current one always stays.)'
	},
	{
		id: 'kingu.agent.claudeAgentTeams',
		group: G,
		type: 'string',
		default: 'off',
		enum: ['off', 'in-process'],
		enumDescriptions: [
			'ปิด (Off.)',
			'เปิด Agent Teams ของ Claude Code (ทดลอง) teammate ทำงานใน terminal เดียวกัน: --teammate-mode in-process และ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 (Experimental Claude Code agent teams, teammates in the same terminal.)'
		],
		description:
			'Agent Teams ของ Claude Code เมื่อ kingu.agent.cli เป็น claude ในโหมด terminal (Orca: claudeAgentTeamsMode; แบบแยก pane ยังไม่รองรับ) (Claude Code agent teams for terminal-mode claude; Orca\'s native-panes mode is not supported.)',
		// User-only: it sets agent flags.
		scope: 'application'
	},
	{
		id: 'kingu.agent.promptCacheTimer',
		group: G,
		type: 'boolean',
		default: false,
		description:
			'แสดงเวลาที่เหลือก่อน prompt cache ของ Claude หมดอายุบนการ์ดและหน้างานเมื่อ agent ทำงานเสร็จแล้วรอคุณ หลังหมดอายุ ข้อความถัดไปจะส่งบทสนทนาทั้งหมดใหม่ (Orca: promptCacheTimerEnabled) (Count down to an idle Claude task\'s prompt-cache expiry on its card and page.)'
	},
	{
		id: 'kingu.agent.promptCacheTtl',
		group: G,
		type: 'string',
		default: '5m',
		enum: ['5m', '1h'],
		enumDescriptions: ['cache มาตรฐาน 5 นาที (The standard 5-minute cache.)', 'cache แบบขยาย 1 ชั่วโมง (The extended 1-hour cache.)'],
		description: 'อายุของ prompt cache ที่ kingu.agent.promptCacheTimer นับถอยหลัง (Orca: promptCacheTtlMs) (Prompt-cache lifetime the timer counts down.)'
	},
	{
		id: 'kingu.automations.confirmDelete',
		group: G,
		type: 'boolean',
		default: true,
		description: 'ถามก่อนลบ automation (Orca: skipDeleteAutomationConfirm กลับค่า) (Ask before deleting an automation.)'
	}
];
