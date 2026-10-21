// VS Code settings: chat.* that Kingu's agent chat applies. Key, type, default and English
// description are VS Code's; the Thai text is Kingu's. The file locations and the instructions
// switches are read by Rust (agent/customizations.rs, agent/rules.rs) from the user's settings.json
// only, so they are user settings here (a repository cannot point the chat at other files);
// `chat.tools.global.autoApprove` is VS Code's APPLICATION_MACHINE setting.
import type { SettingSchema } from '../registry';

export const CHAT_SETTINGS: SettingSchema[] = [
	{
		id: 'chat.agentFilesLocations',
		group: 'Agent Chat',
		type: 'object',
		values: 'boolean',
		default: { '.github/agents': true, '.claude/agents': true, '~/.copilot/agents': true },
		description:
			'โฟลเดอร์ของไฟล์ custom agent (*.agent.md) ที่แสดงในตัวเลือกโหมดของแชต path สัมพัทธ์นับจากโฟลเดอร์ของแชต หรือขึ้นต้นด้วย ~/ (Specify location(s) of custom agent files (`*.agent.md`). Relative paths are resolved from the root folder(s) of your workspace.)',
		scope: 'application'
	},
	{
		id: 'chat.includeApplyingInstructions',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description:
			"แนบไฟล์คำสั่ง (*.instructions.md) ที่ applyTo ตรงกับไฟล์ที่แนบไว้ และกฎ .cursor/rules ที่ globs ตรงกัน ให้คำขอแชตเอง (Controls whether instructions with a matching 'applyTo' attribute are automatically included in chat requests.)",
		scope: 'application'
	},
	{
		id: 'chat.instructionsFilesLocations',
		group: 'Agent Chat',
		type: 'object',
		values: 'boolean',
		default: { '.github/instructions': true, '.claude/rules': true, '~/.copilot/instructions': true, '~/.claude/rules': true },
		description:
			'โฟลเดอร์ของไฟล์คำสั่ง (*.instructions.md) ที่แนบให้แชตได้ .claude/rules นั้น Claude Code อ่านเองอยู่แล้ว (Specify location(s) of instructions files (`*.instructions.md`) that can be attached in Chat sessions. Relative paths are resolved from the root folder(s) of your workspace.)',
		scope: 'application'
	},
	{
		id: 'chat.mcp.serverSampling',
		group: 'Agent Chat',
		type: 'json',
		schema: {
			type: 'object',
			additionalProperties: {
				type: 'object',
				properties: {
					allowedDuringChat: { type: 'boolean' },
					allowedOutsideChat: { type: 'boolean' },
					allowedModels: { type: 'array', items: { type: 'string' } }
				}
			}
		},
		default: {},
		description:
			'MCP server ใดเรียกโมเดลของแชตได้ (sampling) โดยไม่ต้องถาม คีย์คือชื่อ server (หรือ "<collection>: <server>" แบบ VS Code) allowedDuringChat: true อนุญาต false ไม่อนุญาต ไม่ระบุ: ถามทุกครั้งในแชต ปุ่ม Always / Never บนการ์ดในแชตเขียนค่านี้ ใช้กับ Arkai ซึ่งส่งคำขอไปยังโมเดลของแชตนั้น (Configures which models are exposed to MCP servers for sampling (making model requests in the background).)',
		scope: 'application'
	},
	{
		id: 'chat.promptFilesLocations',
		group: 'Agent Chat',
		type: 'object',
		values: 'boolean',
		default: { '.github/prompts': true },
		description:
			'โฟลเดอร์ของ prompt file (*.prompt.md) ที่รันในแชตได้ด้วย /ชื่อ (Specify location(s) of reusable prompt files (`*.prompt.md`) that can be run in Chat sessions. Relative paths are resolved from the root folder(s) of your workspace.)',
		scope: 'application'
	},
	{
		id: 'chat.tools.global.autoApprove',
		group: 'Agent Chat',
		type: 'boolean',
		default: false,
		description:
			'อนุมัติทุก tool ของแชตเองโดยไม่ถาม ("YOLO mode") อันตรายมาก ไม่แนะนำ การตรวจความปลอดภัยของ Kingu (เขียนนอกโฟลเดอร์ ลบไฟล์ path ที่ป้องกัน) ยังถามเหมือนเดิม (Global auto approve also known as "YOLO mode" disables manual approval completely for all tools in all workspaces, allowing the agent to act fully autonomously. This is extremely dangerous and is *never* recommended.)',
		scope: 'application'
	},
	{
		id: 'chat.useAgentsMdFile',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description: 'แนบคำสั่งจากไฟล์ AGENTS.md ของโฟลเดอร์ให้ทุกคำขอแชต (Controls whether instructions from `AGENTS.md` file found in a workspace roots are attached to all chat requests.)',
		scope: 'application'
	}
];
