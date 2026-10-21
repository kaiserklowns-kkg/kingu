// VS Code settings: chat.* that Kingu's agent chat applies. Key, type, default and English
// description are VS Code's; the Thai text is Kingu's. The file locations and the instructions
// switches are read by Rust (agent/customizations.rs, agent/rules.rs) from the user's settings.json
// only, so they are user settings here (a repository cannot point the chat at other files);
// `chat.tools.global.autoApprove` is VS Code's APPLICATION_MACHINE setting. The tool approval
// rules (`chat.tools.terminal/edits/urls.*`) are read by Rust (agent/tool_rules) from the user's
// settings.json only too, merged over VS Code's defaults in chatToolRules.json (Rust reads the
// same file), so they are user settings here.
import type { SettingSchema } from '../registry';
import TOOL_RULES from './chatToolRules.json';

const bool = { type: 'boolean' } as const;

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
		id: 'chat.tools.autoExpandFailures',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description: 'เปิดแถวของ tool ที่ล้มเหลวให้เองในแชต เพื่อให้เห็นรายละเอียดของข้อผิดพลาด (When enabled, terminal tool failures are automatically expanded in the chat UI to show error details.)'
	},
	{
		id: 'chat.tools.edits.autoApprove',
		group: 'Agent Chat',
		type: 'object',
		values: 'boolean',
		default: TOOL_RULES.edits,
		description:
			'ไฟล์ที่ agent แก้ได้โดยไม่ถาม (glob → true) และไฟล์ที่ต้องถามก่อนแก้ทุกครั้ง (glob → false) pattern ที่ตรงตัวสุดท้ายเป็นตัวตัดสิน ไฟล์ที่ถามก่อนจะถามในทุกโหมดยกเว้น Allow all ส่วนไฟล์อื่นถามหรือไม่ตามโหมดของแชต (Controls whether edits made by the agent are automatically approved. The default is to approve all edits except those made to certain files which have the potential to cause immediate unintended side-effects, such as `**/.vscode/*.json`. Set to `true` to automatically approve edits to matching files, `false` to always require explicit approval. The last pattern matching a given file will determine whether the edit is automatically approved.)',
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
		id: 'chat.tools.terminal.autoApprove',
		group: 'Agent Chat',
		type: 'json',
		schema: {
			type: 'object',
			additionalProperties: { anyOf: [bool, { type: 'object', properties: { approve: bool, matchCommandLine: bool } }, { type: 'null' }] }
		},
		default: TOOL_RULES.terminal,
		description:
			'คำสั่ง shell ที่ agent รันได้โดยไม่ถาม (true) หรือต้องถามก่อนเสมอ (false) จับคู่กับต้นคำสั่ง หรือใช้ regex ใน /…/ ทุกคำสั่งย่อยของ `a && b`, `a | b`, `$(…)` ต้องได้ true และไม่มีอันไหนได้ false ใช้ { approve, matchCommandLine: true } เพื่อจับทั้งบรรทัด และ null เพื่อปิดกฎเริ่มต้น regex ที่ใช้ look-around หรือ back-reference ไม่ทำงาน (กฎ false แบบนั้นจะถามทุกคำสั่งที่ขึ้นต้นเหมือนกัน) (A list of commands or regular expressions that control whether the run in terminal tool commands require explicit approval. These will be matched against the start of a command. A regular expression can be provided by wrapping the string in `/` characters followed by optional flags such as `i` for case-insensitivity. Set to `true` to automatically approve commands, `false` to always require explicit approval or `null` to unset the value.)',
		scope: 'application'
	},
	{
		id: 'chat.tools.terminal.enableAutoApprove',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description: 'ใช้กฎของ chat.tools.terminal.autoApprove อนุมัติคำสั่ง shell ให้เอง ปิดแล้วทุกคำสั่งจะถามก่อน (Controls whether to allow auto approval in the run in terminal tool.)',
		scope: 'application'
	},
	{
		id: 'chat.tools.terminal.ignoreDefaultAutoApproveRules',
		group: 'Agent Chat',
		type: 'boolean',
		default: false,
		description:
			'ไม่ใช้กฎเริ่มต้นของ chat.tools.terminal.autoApprove ใช้เฉพาะกฎที่ตั้งเอง กฎ false เริ่มต้นมีไว้กันคำสั่งอันตราย ใช้ด้วยความระวัง (Whether to ignore the built-in default auto-approve rules used by the run in terminal tool as defined in `#chat.tools.terminal.autoApprove#`. Use this setting at your own risk; the default auto-approve rules are designed to protect you against running dangerous commands.)',
		scope: 'application',
		tags: ['experimental']
	},
	{
		id: 'chat.tools.urls.autoApprove',
		group: 'Agent Chat',
		type: 'json',
		schema: {
			type: 'object',
			additionalProperties: { oneOf: [bool, { type: 'object', properties: { approveRequest: bool, approveResponse: bool } }] }
		},
		default: TOOL_RULES.urls,
		description:
			'URL ที่ tool อย่าง WebFetch ดึงได้โดยไม่ถาม key เป็น pattern ของ URL (https://*.example.com/*) ค่า true อนุมัติ false ถามก่อน Kingu ยังไม่มีขั้นตรวจผลลัพธ์แยก จึงใช้แค่ approveRequest (Controls which URLs are automatically approved when requested by chat tools. Keys are URL patterns and values can be `true` to approve both requests and responses, `false` to deny, or an object with `approveRequest` and `approveResponse` properties for granular control.)',
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
