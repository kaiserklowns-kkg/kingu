// VS Code settings: chat.* that Kingu's agent chat applies. Key, type, default and English
// description are VS Code's; the Thai text is Kingu's. The file locations and the instructions
// switches are read by Rust (agent/customizations.rs, agent/rules.rs) from the user's settings.json
// only, so they are user settings here (a repository cannot point the chat at other files);
// `chat.tools.global.autoApprove` is VS Code's APPLICATION_MACHINE setting. The look, rendering,
// input and notification ones are read by the chat UI: chatLook.ts (fonts), ChatMarkdown.svelte
// (math, mermaid), chatSettings.ts (the rest; AgentPanel, ChatList, chatRewind, agentNotify).
import type { SettingSchema } from '../registry';

export const CHAT_SETTINGS: SettingSchema[] = [
	{
		id: 'chat.agent.thinkingStyle',
		group: 'Agent Chat',
		type: 'string',
		default: 'fixedScrolling',
		enum: ['collapsed', 'collapsedPreview', 'fixedScrolling'],
		enumDescriptions: [
			'ส่วนที่ agent คิดยุบไว้เสมอ คลิกเพื่อเปิด (Thinking parts will be collapsed by default.)',
			'เปิดให้เห็นขณะคิด แล้วยุบเมื่อ agent ทำอย่างอื่นต่อ (Thinking parts will be expanded first, then collapse once we reach a part that is not thinking.)',
			'ขณะคิดแสดงในกรอบสูงคงที่ที่เลื่อนตามเอง เสร็จแล้วยุบ คลิกหัวข้อเพื่อเปิดเต็มความสูง (Show thinking in a fixed-height streaming panel that auto-scrolls; click header to expand to full height.)'
		],
		description: 'วิธีแสดงส่วนที่ agent คิด (thinking) ในแชต (Controls how thinking is rendered. Read-only chats always use the collapsed preview style.)',
		tags: ['experimental']
	},
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
		id: 'chat.contextUsage.enabled',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description: 'แสดงวงแหวนการใช้ context window ในช่องแชต (Show the context window usage indicator in the chat input.)'
	},
	{
		id: 'chat.editing.confirmEditRequestRemoval',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description:
			'ถามก่อนกลับไปจุด checkpoint หรือแก้คำขอ ซึ่งลบคำขอหลังจากนั้นและย้อนการแก้ไฟล์ (แทน kingu.chat.confirmRewind เดิม ซึ่งยังมีผลถ้าตั้งเป็น false ไว้และไม่ได้ตั้งค่านี้) (Whether to show a confirmation before removing a request and its associated edits.)',
		scope: 'application'
	},
	{
		id: 'chat.editing.confirmEditRequestRetry',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description: 'ถามก่อนลองคำขอสุดท้ายใหม่เมื่อจะย้อนการแก้ไฟล์ของมัน (Whether to show a confirmation before retrying a request and its associated edits.)',
		scope: 'application'
	},
	{
		id: 'chat.editor.fontFamily',
		group: 'Agent Chat',
		type: 'string',
		default: 'default',
		description: 'ฟอนต์ของ code block ในแชต default ใช้ฟอนต์ของ editor (Controls the font family in chat codeblocks.)'
	},
	{
		id: 'chat.editor.fontWeight',
		group: 'Agent Chat',
		type: 'string',
		default: 'default',
		description: 'ความหนาของตัวอักษรใน code block ของแชต เช่น normal, bold หรือ 100–900 default ใช้ของ editor (Controls the font weight in chat codeblocks.)'
	},
	{
		id: 'chat.editor.lineHeight',
		group: 'Agent Chat',
		type: 'number',
		default: 0,
		minimum: 0,
		description: 'ความสูงบรรทัดของ code block ในแชตเป็นพิกเซล 0 คำนวณจากขนาดตัวอักษร (Controls the line height in pixels in chat codeblocks. Use 0 to compute the line height from the font size.)'
	},
	{
		id: 'chat.editor.wordWrap',
		group: 'Agent Chat',
		type: 'string',
		default: 'off',
		enum: ['on', 'off'],
		description: 'ตัดบรรทัดยาวใน code block ของแชต (Controls whether lines should wrap in chat codeblocks.)'
	},
	{
		id: 'chat.fontFamily',
		group: 'Agent Chat',
		type: 'string',
		default: 'default',
		description:
			'ฟอนต์ของข้อความในแชต default ใช้ฟอนต์ของ terminal เมื่อเปิด kingu.chat.matchTerminalFont ไม่เช่นนั้นใช้ฟอนต์ของหน้าจอ (Controls the font family in chat messages.)'
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
		id: 'chat.math.enabled',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description: 'แสดงสูตรคณิต $…$ และ $$…$$ ในคำตอบของแชตด้วย KaTeX และแผนภาพใน code block ```mermaid (Enable math rendering in chat responses using KaTeX.)'
	},
	{
		id: 'chat.newSession.defaultMode',
		group: 'Agent Chat',
		type: 'string',
		default: '',
		description:
			"โหมดของแชตใหม่: agent, ask, plan หรือชื่อ custom agent ว่างไว้ใช้ตาม kingu.agent.permissionMode (The default mode for new chat sessions. When empty, the chat view's default mode is used.)"
	},
	{
		id: 'chat.notifyWindowOnConfirmation',
		group: 'Agent Chat',
		type: 'string',
		default: 'windowNotFocused',
		enum: ['off', 'windowNotFocused', 'always'],
		enumDescriptions: [
			'ไม่แจ้งเตือน (Never show OS notifications for confirmations.)',
			'แจ้งเมื่อหน้าต่างไม่ได้โฟกัส (Show OS notifications for confirmations when the window is not focused.)',
			'แจ้งเสมอ แม้หน้าต่างโฟกัสอยู่ (Always show OS notifications for confirmations, even when the window is focused.)'
		],
		description:
			'แจ้งเตือนของระบบและเรียกความสนใจที่ไอคอนใน Dock เมื่อแชตรอให้อนุญาตหรือถามคำถาม ปิดทั้งหมดได้ด้วย kingu.agent.notifications (Controls whether a chat session should present the user with an OS notification when a confirmation or question needs attention. This includes a window badge as well as notification toast.)'
	},
	{
		id: 'chat.notifyWindowOnResponseReceived',
		group: 'Agent Chat',
		type: 'string',
		default: 'windowNotFocused',
		enum: ['off', 'windowNotFocused', 'always'],
		enumDescriptions: [
			'ไม่แจ้งเตือน (Never show OS notifications for responses.)',
			'แจ้งเมื่อหน้าต่างไม่ได้โฟกัส (Show OS notifications for responses when the window is not focused.)',
			'แจ้งเสมอ แม้หน้าต่างโฟกัสอยู่ (Always show OS notifications for responses, even when the window is focused.)'
		],
		description:
			'แจ้งเตือนของระบบและเรียกความสนใจที่ไอคอนใน Dock เมื่อแชตตอบเสร็จหรือล้มเหลว ปิดทั้งหมดได้ด้วย kingu.agent.notifications (Controls whether a chat session should present the user with an OS notification when a response is received. This includes a window badge as well as notification toast.)'
	},
	{
		id: 'chat.pasteAsAttachmentThreshold',
		group: 'Agent Chat',
		type: 'number',
		default: 10000,
		minimum: 0,
		description:
			'ข้อความที่วางในช่องแชตยาวเกินกี่ตัวอักษรจึงแนบเป็น context แทนการใส่ในช่อง ตั้งค่ามาก ๆ เพื่อวางในช่องเสมอ (The number of characters a paste must exceed before it is added to the chat input as an attachment instead of being inserted inline. Set this to a very large number to always paste inline.)'
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
		id: 'chat.restoreLastPanelSession',
		group: 'Agent Chat',
		type: 'boolean',
		default: false,
		description: 'เปิดแชตล่าสุดในแผงแชตอีกครั้งเมื่อเปิดโฟลเดอร์ ปิดไว้จะเริ่มแชตใหม่ (Controls whether the last session is restored in panel after restart.)'
	},
	{
		id: 'chat.saveBeforeSend',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description: 'บันทึกไฟล์ที่แก้ค้างไว้ทุกไฟล์ (ยกเว้นไฟล์ที่ยังไม่มีชื่อ) ก่อนส่งข้อความแชต เพื่อให้ agent อ่านเนื้อหาล่าสุด (Controls whether all dirty editors except untitled editors are saved before sending a chat message.)'
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
		id: 'chat.tools.todos.showWidget',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description: 'แสดงรายการ todo ของ agent เหนือช่องแชต (Controls whether to show the todo list widget above the chat input. When enabled, the widget displays todo items created by the agent and updates as progress is made.)'
	},
	{
		id: 'chat.undoRequests.restoreInput',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description: 'เมื่อกลับไปจุด checkpoint ใส่ข้อความของคำขอนั้นกลับในช่องแชต (Controls whether the input of the chat should be restored when an undo request is made. The input will be filled with the text of the request that was restored.)'
	},
	{
		id: 'chat.useAgentsMdFile',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description: 'แนบคำสั่งจากไฟล์ AGENTS.md ของโฟลเดอร์ให้ทุกคำขอแชต (Controls whether instructions from `AGENTS.md` file found in a workspace roots are attached to all chat requests.)',
		scope: 'application'
	},
	{
		id: 'chat.viewProgressBadge.enabled',
		group: 'Agent Chat',
		type: 'boolean',
		default: false,
		description: 'แสดงจุดบนปุ่มแผงแชตใน title bar ขณะ agent ของแชตกำลังทำงาน (Show a progress badge on the chat view when an agent session is in progress that is opened in that view.)'
	}
];
