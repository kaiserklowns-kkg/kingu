// VS Code settings: chat.* that Kingu's agent chat applies. Key, type, default and English
// description are VS Code's; the Thai text is Kingu's. The file locations and the instructions
// switches are read by Rust (agent/customizations.rs, agent/rules.rs) from the user's settings.json
// only, so they are user settings here (a repository cannot point the chat at other files);
// `chat.tools.global.autoApprove` is VS Code's APPLICATION_MACHINE setting. The look, rendering,
// input and notification ones are read by the chat UI: chatLook.ts (fonts), ChatMarkdown.svelte
// (math, mermaid), chatTips.svelte.ts (the tips card), chatSettings.ts (the rest; AgentPanel,
// ChatList, chatRewind, agentNotify).
// The tool approval rules (`chat.tools.terminal/edits/urls.*`) are read by Rust (agent/tool_rules)
// from the user's settings.json only too, merged over VS Code's defaults in chatToolRules.json
// (Rust reads the same file), so they are user settings here.
import type { SettingSchema } from '../registry';
import TOOL_RULES from './chatToolRules.json';

const bool = { type: 'boolean' } as const;
/**
 * An entry of `chat.mcp.allowedServers` / `deniedServers`. VS Code's schema also requires exactly
 * one of the three (`oneOf` of `required`); Kingu's JSON schema has no `required`, and Rust
 * (mcp_policy.rs `Matcher::parse`) drops an entry that has none or several, as VS Code does.
 */
const MCP_SERVER_MATCHER = {
	type: 'object',
	additionalProperties: false,
	properties: {
		serverName: { type: 'string', minLength: 1 },
		serverUrl: { type: 'string', minLength: 1 },
		serverCommand: { type: 'array', minItems: 1, items: { type: 'string' } }
	}
} as const;

export const CHAT_SETTINGS: SettingSchema[] = [
	// The agent sandbox (VS Code: terminalChatAgentToolsConfiguration.ts, `chat.agent.sandbox.*`).
	// Rust reads these from the user's settings.json only (agent/sandbox.rs) and the agent host
	// checks them (agent-host sandbox/config.ts), so they are user settings here: a repository
	// cannot turn the sandbox off for the agent that works in it. macOS (Seatbelt) and Linux (bubblewrap);
	// on Windows Arkai refuses the command (VS Code's Local harness does not sandbox there).
	{
		id: 'chat.agent.sandbox.allowUnsandboxedCommands',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description:
			'เมื่อคำสั่งล้มเหลวเพราะ sandbox ให้ agent ขอรันคำสั่งนั้นนอก sandbox ได้ โดย Kingu จะถามคุณก่อนทุกครั้ง แม้ในโหมดอนุญาตทั้งหมด ปิดแล้วทุกคำสั่งต้องรันใน sandbox เท่านั้น (Controls whether agent mode terminal commands can run outside the sandbox after user confirmation when a sandboxed command fails or when sandbox restrictions would block the command.)',
		scope: 'application'
	},
	{
		id: 'chat.agent.sandbox.credentials.envVars',
		group: 'Agent Chat',
		type: 'json',
		schema: {
			type: ['object', 'null'],
			patternProperties: { '^[A-Za-z_][A-Za-z0-9_]*$': { type: 'object', properties: { injectHosts: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } },
			additionalProperties: false
		},
		default: null,
		description:
			'ซ่อน environment variable ที่ระบุชื่อไว้จากคำสั่งที่ agent รัน เมื่อเปิด chat.agent.sandbox.enabled ใส่ชื่อตัวแปร ไม่ใช่ค่าความลับ เช่น { "GH_TOKEN": { "injectHosts": [] } } ตัวแปรที่ซ่อนจะไม่ถึงคำสั่งเลย ทั้งใน sandbox และคำสั่งที่คุณอนุญาตให้รันนอก sandbox ถ้าค่านี้เขียนผิดรูปแบบ agent จะไม่เริ่มทำงาน Kingu ไม่ส่งค่ากลับให้ host ใน injectHosts เพราะต้องถอดรหัส HTTPS ด้วย CA ของ Kingu จึงเป็นการซ่อนอย่างเดียว (Mask the named environment variables inside the Copilot Agent Host sandbox. For each variable, list the HTTPS hosts that may receive its value in `injectHosts`. Enter variable names, not secret values.)',
		scope: 'application'
	},
	{
		id: 'chat.agent.sandbox.enabled',
		group: 'Agent Chat',
		type: 'string',
		default: 'off',
		enum: ['off', 'on'],
		enumDescriptions: ['ไม่ใช้ sandbox กับคำสั่งของ agent (Disable sandboxing for agent mode tools.)', 'รันคำสั่งของ agent ใน sandbox (Enable sandboxing for agent mode tools.)'],
		description:
			'รันคำสั่ง shell ของ agent ในแชตใน sandbox ของระบบ (macOS: Seatbelt, Linux: bubblewrap) เขียนไฟล์ได้เฉพาะในโฟลเดอร์ที่ agent ทำงานและ $TMPDIR ใช้กับ Arkai (Kingu รันคำสั่งเอง) และ Claude (sandbox ของ Claude Agent SDK) Codex ใช้ sandbox ของตัวเองตามโหมดการอนุญาต ส่วน agent แบบ ACP และ CLI ในเทอร์มินัลรันคำสั่งเอง Kingu จึงไม่ได้ครอบให้ รองรับ macOS และ Linux (ต้องติดตั้ง bubblewrap และต้องมี socat เมื่อใช้รายการโดเมน) บน Windows เมื่อเปิดไว้ Arkai จะไม่รันคำสั่ง (เว้นแต่คุณอนุญาตให้รันนอก sandbox) แทนที่จะรันโดยไม่มี sandbox (Controls whether agent mode uses sandboxing to restrict what tools can do. When enabled, tools like the terminal are run in a sandboxed environment to limit access to the system. The Local harness supports sandboxing on Linux and macOS only. The Copilot Agent Host harness uses the SDK runtime\'s sandbox, including on supported Windows hosts.)',
		scope: 'application'
	},
	{
		id: 'chat.agent.sandbox.fileSystem.userConfiguredPaths',
		group: 'Agent Chat',
		type: 'json',
		schema: {
			type: 'object',
			properties: { readwritePaths: { type: 'array', items: { type: 'string' } }, readonlyPaths: { type: 'array', items: { type: 'string' } }, deniedPaths: { type: 'array', items: { type: 'string' } } },
			additionalProperties: false
		},
		default: { readwritePaths: [], readonlyPaths: [], deniedPaths: [] },
		description:
			'path เพิ่มเติมของ sandbox: readwritePaths อ่านและเขียนได้ readonlyPaths ห้ามเขียน deniedPaths ห้ามทั้งอ่านและเขียน (denied ชนะ readonly ชนะ readwrite) ใช้ path ตรงตัว ไม่รองรับ glob เริ่มด้วย ~/ ได้ และ path สัมพัทธ์นับจากโฟลเดอร์ที่ agent ทำงาน (Customize file path permissions in the sandbox.)',
		scope: 'application'
	},
	{
		id: 'chat.agent.sandbox.network.allowLocalNetwork',
		group: 'Agent Chat',
		type: 'boolean',
		default: false,
		description:
			'เมื่อปิด chat.agent.sandbox.network.allowNetwork ยังให้คำสั่งใน sandbox ต่อ localhost ได้ (Seatbelt แยกได้แค่ localhost กับทุกที่ จึงหมายถึง loopback เท่านั้น ไม่รวมเครื่องอื่นใน LAN บน Linux หมายถึง loopback ของ sandbox เอง ไม่ใช่ของเครื่อง) (Allow the sandboxed process to reach hosts on the local network. Windows needs this on when a proxy, host rules, or credential masking is used: it reaches the local listener over host loopback, and a sandboxed command will not launch without it. The local proxy checks destination addresses for direct connections. An upstream proxy resolves its own destinations.)',
		scope: 'application'
	},
	{
		id: 'chat.agent.sandbox.network.allowNetwork',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description:
			'ให้คำสั่งใน sandbox ออกเครือข่ายได้ ยังจำกัดด้วย chat.agent.sandbox.network.allowedDomains และ deniedDomains ปิดแล้วคำสั่งต่อได้เฉพาะโดเมนใน allowedDomains (ถ้ามี) (Allow outbound network access in the sandbox (`allowOutbound` in the SDK). Configured allowed and denied network domains still restrict destinations. When disabled, outbound network access is blocked, including for the integrated browser.)',
		scope: 'application'
	},
	{
		id: 'chat.agent.sandbox.network.allowedDomains',
		group: 'Agent Chat',
		type: 'array',
		items: 'string',
		default: [],
		description:
			'โดเมนที่คำสั่งใน sandbox ต่อได้ เมื่อมีรายการนี้ คำสั่งออกเครือข่ายได้เฉพาะโดเมนเหล่านี้ (ทั้งเมื่อเปิดและปิด allowNetwork) ผ่าน proxy ของ Kingu ด้วย HTTP(S) เท่านั้น รองรับ *.example.com และ * ค่าที่ไม่ใช่โดเมนทำให้ agent ไม่เริ่มทำงาน deniedDomains ชนะเสมอ (Allowed domains for network access by agent tools (fetch tool, integrated browser) when `#chat.agent.networkFilter#` is enabled. In Copilot Agent Host sessions with sandboxing (`#chat.agent.sandbox.enabled#`) enabled, also restricts the integrated browser when outbound network access (`#chat.agent.sandbox.network.allowNetwork#`) is allowed; an empty allow list adds no sandbox restriction. This list does not enable outbound access. Supports wildcards like `*.example.com`. Outside sandboxing, when both allowed and denied lists are empty, all domains are blocked. Denied domains (see `#chat.agent.sandbox.network.deniedDomains#`) take precedence.)',
		scope: 'application'
	},
	{
		id: 'chat.agent.sandbox.network.deniedDomains',
		group: 'Agent Chat',
		type: 'array',
		items: 'string',
		default: [],
		description:
			'โดเมนที่คำสั่งใน sandbox ต่อไม่ได้ แม้เปิด allowNetwork หรืออยู่ใน allowedDomains เมื่อมีรายการนี้ คำสั่งออกเครือข่ายผ่าน proxy ของ Kingu ด้วย HTTP(S) เท่านั้น รองรับ *.example.com (Denied domains for network access by agent tools (fetch tool, integrated browser) when `#chat.agent.networkFilter#` is enabled. Also applies to the integrated browser in sandboxed Copilot Agent Host sessions (`#chat.agent.sandbox.enabled#`); allowing outbound network access (`#chat.agent.sandbox.network.allowNetwork#`) does not bypass this list. Takes precedence over `#chat.agent.sandbox.network.allowedDomains#`. Supports wildcards like `*.example.com`.)',
		scope: 'application'
	},
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
	// Which MCP servers may run (VS Code: chat.shared.contribution.ts, allowedMcpServers.ts). Rust
	// reads these from the user's settings.json only (agent/mcp_policy.rs); a machine-wide
	// managed-settings.json (allowedMcpServers, deniedMcpServers, allowManagedMcpServersOnly) wins.
	{
		id: 'chat.mcp.access',
		group: 'Agent Chat',
		type: 'string',
		default: 'all',
		enum: ['none', 'registry', 'all'],
		enumDescriptions: [
			'ไม่ให้ใช้ MCP server ใดเลย (No access to MCP servers.)',
			'เฉพาะ server ใน registry Kingu ไม่มี MCP registry จึงใช้ได้เฉพาะ server ที่ allowlist ที่องค์กรจัดการอนุญาต (Allows access to MCP servers listed in the registry that VS Code is connected to.)',
			'ใช้ MCP server ที่ติดตั้งได้ทุกตัว (Allow access to any installed MCP server.)'
		],
		description:
			'ควบคุมการเข้าถึง MCP server ที่ติดตั้งไว้ server ที่ถูกบล็อกจะไม่เริ่มทำงาน และหน้า MCP Servers แสดงว่า "ถูกบล็อกโดยนโยบาย" (Controls access to installed Model Context Protocol servers.)',
		scope: 'application'
	},
	{
		id: 'chat.mcp.allowedServers',
		group: 'Agent Chat',
		type: 'json',
		schema: { type: ['array', 'null'], items: MCP_SERVER_MATCHER },
		default: null,
		description:
			'MCP server ที่รันได้ แต่ละรายการคือ { "serverName" }, { "serverUrl" } (ใช้ * ได้) หรือ { "serverCommand": [คำสั่ง, ...อาร์กิวเมนต์] } รายการว่างไม่อนุญาตเลย ไม่ตั้งค่าคือไม่จำกัด deniedServers ชนะเสมอ ถ้า managed-settings.json ของเครื่องมี allowedMcpServers จะใช้ค่านั้นแทน และส่งให้ Claude Code ด้วย (Enterprise-managed allowlist that controls which Model Context Protocol servers may be installed and run. Local servers must match a command entry when any command entries exist; remote servers must match a URL entry when any URL entries exist. Otherwise, servers may match a literal name entry. An empty list allows no servers. If omitted, no allowlist restriction applies.)',
		scope: 'application'
	},
	{
		id: 'chat.mcp.deniedServers',
		group: 'Agent Chat',
		type: 'json',
		schema: { type: ['array', 'null'], items: MCP_SERVER_MATCHER },
		default: null,
		description:
			'MCP server ที่ห้ามรันเสมอ แม้อยู่ใน allowedServers รูปแบบรายการเหมือน allowedServers รวมกับ deniedMcpServers ใน managed-settings.json ของเครื่อง (Enterprise-managed denylist of Model Context Protocol servers. Servers matching any entry are unconditionally blocked from being installed or run, even if they also match the allow list — deny rules always take precedence.)',
		scope: 'application'
	},
	{
		id: 'chat.permissions.assisted.instructions',
		group: 'Agent Chat',
		type: 'string',
		default: '',
		description:
			'คำแนะนำเพิ่มให้ตัวตรวจของ Assisted permissions ที่ตัดสินว่าเครื่องมือใดรันได้โดยไม่ถาม มีน้ำหนักเหนือแนวทางเริ่มต้นของตัวตรวจ แต่ข้ามกฎการอนุญาตหรือ sandbox ไม่ได้ และไม่ส่งให้ agent ว่างไว้เพื่อใช้แนวทางเริ่มต้น (Custom instructions for the reviewer that decides which tool calls can run without asking when a Copilot session uses Assisted permissions. They take precedence over the reviewer\'s default guidance but cannot override permission rules, organization policy, or the sandbox, and they are not sent to the agent. Leave empty to use the default guidance.)',
		scope: 'application'
	},
	{
		id: 'chat.mcp.apps.enabled',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description:
			'ให้ MCP server แสดง UI ของตัวเอง (MCP App, ui://) ใต้การเรียกเครื่องมือในแชต Kingu แสดงใน frame ที่แยก origin ไม่มีสิทธิ์เข้าถึงแอปหรือแชตอื่น และการเรียกเครื่องมือจาก App ผ่านกฎการอนุญาตของแชต (Controls whether MCP servers can provide custom UI for tool invocations.)',
		scope: 'application'
	},
	{
		id: 'chat.agentHost.mcpSkills.enabled',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description:
			'ให้ Arkai ใช้ skill ที่ MCP server ให้มา (Skills over MCP, SEP-2640) รายชื่อ skill อยู่ในคำสั่งของโมเดลและเป็นคำสั่ง /<server>:<skill> ในแชต ก่อนโหลด skill ของ server ใด Kingu ถามคุณก่อน และตรวจไฟล์ทุกไฟล์กับ sha256 ที่ server ประกาศไว้ มีผลกับแชตใหม่ (When enabled, Copilot agent sessions discover and use skills served by MCP servers. Changes apply to new sessions.)',
		scope: 'application'
	},
	{
		id: 'chat.copilot.modelRouter.enabled',
		group: 'Agent Chat',
		type: 'boolean',
		default: false,
		description:
			'แสดง model router แต่ละตัวใน ~/.agents/model-routers/ (<ชื่อ>.model-router.yaml) เป็นโมเดลในตัวเลือกโมเดลของ Arkai router เลือกโมเดลของ provider นั้นให้แต่ละข้อความตาม route ที่คุณเขียน โดยถามโมเดลแรกของ router ว่า route ไหนเหมาะ (When enabled, Copilot in Agent Host sessions offers each model router in `~/.agents/model-routers/` as a model. A router picks a model for each turn from the routes you write. The built-in `model-router` skill can write and check routers.)',
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
		id: 'chat.tips.enabled',
		group: 'Agent Chat',
		type: 'boolean',
		default: true,
		description:
			'แสดงเคล็ดลับการใช้แชตในการ์ดเหนือช่องพิมพ์ของแชตใหม่ ปิด เลื่อน หรือปิดทั้งหมดได้จากปุ่มบนการ์ด (Controls whether tips are shown above user messages in chat. New tips are added frequently, so this is a helpful way to stay up to date with the latest features.)',
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
	},
	{
		id: 'chat.viewProgressBadge.enabled',
		group: 'Agent Chat',
		type: 'boolean',
		default: false,
		description: 'แสดงจุดบนปุ่มแผงแชตใน title bar ขณะ agent ของแชตกำลังทำงาน (Show a progress badge on the chat view when an agent session is in progress that is opened in that view.)'
	}
];
