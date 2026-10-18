// Orca's Terminal page: what the VS Code terminal.integrated.* keys do not cover (group ADE Terminal).
// They apply to the ADE's terminals (Agents layout); the IDE panel keeps VS Code's behaviour.
// Orca keys that VS Code already has are not repeated here: terminalFontFamily/Size/Weight,
// terminalLineHeight, terminalCursorStyle/Blink, terminalScrollbackRows, terminalScrollSensitivity,
// terminalFastScrollSensitivity, terminalMinimumContrastRatio, terminalMacOptionAsAlt,
// terminalClipboardOnSelect, terminalDefaultShell/Args → terminal.integrated.* (see ./orcaMap.ts).
import type { SettingSchema } from '../registry';

const G = 'ADE Terminal';

export const TERMINAL_SETTINGS: SettingSchema[] = [
	{
		id: 'kingu.terminal.activePaneOpacity',
		group: G,
		type: 'number',
		default: 1,
		minimum: 0.1,
		maximum: 1,
		description: 'ความทึบของ pane ที่โฟกัสอยู่เมื่อแบ่ง terminal หลาย pane (Orca: terminalActivePaneOpacity) (Opacity of the focused pane of a split ADE terminal.)'
	},
	{
		id: 'kingu.terminal.inactivePaneOpacity',
		group: G,
		type: 'number',
		default: 0.9,
		minimum: 0.1,
		maximum: 1,
		description: 'ความทึบของ pane อื่นที่ไม่ได้โฟกัสเมื่อแบ่ง terminal (Orca: terminalInactivePaneOpacity) (Opacity of the unfocused panes of a split ADE terminal.)'
	},
	{
		id: 'kingu.terminal.paneOpacityTransitionMs',
		group: G,
		type: 'number',
		default: 140,
		minimum: 0,
		maximum: 2000,
		integer: true,
		description: 'เวลา (ms) ที่ความทึบของ pane ค่อย ๆ เปลี่ยนเมื่อย้ายโฟกัส 0 คือเปลี่ยนทันที (Orca: terminalPaneOpacityTransitionMs) (Fade duration in milliseconds when pane focus moves; 0 switches at once.)'
	},
	{
		id: 'kingu.terminal.dividerColorDark',
		group: G,
		type: 'string',
		default: '#3f3f46',
		description: 'สีเส้นแบ่ง pane ในธีมมืด เป็น hex เช่น #3f3f46 (Orca: terminalDividerColorDark) (Split divider color in dark themes, as hex.)'
	},
	{
		id: 'kingu.terminal.dividerColorLight',
		group: G,
		type: 'string',
		default: '#d4d4d8',
		description: 'สีเส้นแบ่ง pane ในธีมสว่าง เป็น hex (Orca: terminalDividerColorLight) (Split divider color in light themes, as hex.)'
	},
	{
		id: 'kingu.terminal.dividerThicknessPx',
		group: G,
		type: 'number',
		default: 3,
		minimum: 1,
		maximum: 12,
		integer: true,
		description: 'ความหนาของเส้นแบ่ง pane เป็นพิกเซล (Orca: terminalDividerThicknessPx) (Split divider thickness in pixels.)'
	},
	{
		id: 'kingu.terminal.backgroundOpacity',
		group: G,
		type: 'number',
		default: 1,
		minimum: 0,
		maximum: 1,
		description: 'ความทึบของพื้นหลัง terminal 1 คือทึบ ค่าน้อยลงจะเห็นพื้นหลังของหน้าต่างทะลุ (Orca: terminalBackgroundOpacity) (Terminal background opacity; below 1 lets the window background show through.)'
	},
	{
		id: 'kingu.terminal.cursorOpacity',
		group: G,
		type: 'number',
		default: 1,
		minimum: 0,
		maximum: 1,
		description: 'ความทึบของเคอร์เซอร์ terminal (ใช้กับสีเคอร์เซอร์แบบ hex) (Orca: terminalCursorOpacity) (Terminal cursor opacity; applies to hex cursor colors.)'
	},
	{
		id: 'kingu.terminal.colorOverrides',
		group: G,
		type: 'object',
		values: 'string',
		default: {},
		description:
			'แทนสีบางสีของธีม terminal โดยไม่ต้องเปลี่ยนธีม: background, foreground, cursor, cursorAccent, selectionBackground, selectionForeground, black, red, green, yellow, blue, magenta, cyan, white และ brightBlack…brightWhite ค่าเป็นสี CSS เช่น "#ff5555" (Orca: terminalColorOverrides) (Override individual terminal theme colors by name, e.g. { "red": "#ff5555" }.)'
	},
	{
		id: 'kingu.terminal.paddingX',
		group: G,
		type: 'number',
		default: 8,
		minimum: 0,
		maximum: 64,
		integer: true,
		description: 'ระยะขอบซ้าย-ขวาภายใน terminal เป็นพิกเซล (Orca: terminalPaddingX) (Horizontal padding inside the terminal, in pixels.)'
	},
	{
		id: 'kingu.terminal.paddingY',
		group: G,
		type: 'number',
		default: 4,
		minimum: 0,
		maximum: 64,
		integer: true,
		description: 'ระยะขอบบนภายใน terminal เป็นพิกเซล (Orca: terminalPaddingY) (Top padding inside the terminal, in pixels.)'
	},
	{
		id: 'kingu.terminal.allowOsc52Clipboard',
		group: G,
		type: 'boolean',
		default: true,
		description:
			'ให้โปรแกรมใน terminal (tmux, Zellij, nvim รวมถึงผ่าน SSH) คัดลอกข้อความลง clipboard ด้วย OSC 52 ได้ ไม่ตอบคำขออ่าน clipboard เด็ดขาด และจำกัดขนาด 128 KB (Orca: terminalAllowOsc52Clipboard) (Let terminal programs write the clipboard with OSC 52; clipboard reads are never answered and payloads are capped.)'
	},
	{
		id: 'kingu.terminal.copyTrimsGutter',
		group: G,
		type: 'boolean',
		default: true,
		description:
			'เมื่อคัดลอกจาก terminal ตัดช่องว่างซ้ายที่ทุกบรรทัดมีร่วมกัน (ร่องที่ agent CLI วาดข้อความไว้) โดยคงการเยื้องภายในไว้ (Orca: terminalCopyTrimsGutter) (Copying drops the left gutter shared by every selected line, keeping relative indentation.)'
	},
	{
		id: 'kingu.terminal.middleClickPaste',
		group: G,
		type: 'boolean',
		default: true,
		description:
			'คลิกปุ่มกลางเมาส์ใน terminal เพื่อวางข้อความที่เลือกล่าสุดใน terminal (primary selection แบบ X11) โดยไม่แตะ clipboard (Orca: primarySelectionMiddleClickPaste) (Middle-click pastes the last terminal selection, X11 primary-selection style, without touching the clipboard.)'
	},
	{
		id: 'kingu.terminal.focusFollowsMouse',
		group: G,
		type: 'boolean',
		default: false,
		description: 'ย้ายโฟกัสไปยัง pane ของ terminal ที่เมาส์ชี้ โดยไม่ต้องคลิก (Orca: terminalFocusFollowsMouse) (Focus the split pane under the mouse without clicking.)'
	},
	{
		id: 'kingu.terminal.mouseHideWhileTyping',
		group: G,
		type: 'boolean',
		default: false,
		description: 'ซ่อนตัวชี้เมาส์ขณะพิมพ์ใน terminal จนกว่าจะขยับเมาส์ (Orca: terminalMouseHideWhileTyping) (Hide the mouse pointer while typing in a terminal until the mouse moves.)'
	},
	{
		id: 'kingu.terminal.jisYenToBackslash',
		group: G,
		type: 'boolean',
		default: false,
		description: 'macOS: ปุ่ม ¥ บนคีย์บอร์ด JIS พิมพ์ \\ ใน terminal (Orca: terminalJISYenToBackslash) (macOS: the physical JIS Yen key types a backslash in the terminal.)'
	},
	{
		id: 'kingu.terminal.tuiScrollSensitivity',
		group: G,
		type: 'number',
		default: 1,
		minimum: 1,
		maximum: 10,
		description:
			'ตัวคูณการเลื่อนล้อเมาส์เมื่อโปรแกรมเต็มจอ (TUI เช่น vim, less, agent CLI) รับเหตุการณ์เมาส์เอง (Orca: terminalTuiScrollSensitivity) (Wheel multiplier while a full-screen TUI has mouse reporting on.)'
	},
	{
		id: 'kingu.terminal.scopeHistoryByWorktree',
		group: G,
		type: 'boolean',
		default: true,
		description:
			'ประวัติคำสั่ง shell แยกต่อ worktree ใน terminal ของ Agents (zsh, bash, fish) ลูกศรขึ้นจึงไม่เห็นคำสั่งของ worktree อื่น เก็บไว้ใน data ของ Kingu ใช้กับ terminal ที่เปิดใหม่ (Orca: terminalScopeHistoryByWorktree) (Per-worktree shell history for ADE terminals — zsh, bash, fish — so ArrowUp does not surface other worktrees\' commands; applies to new terminals.)'
	},
	{
		id: 'kingu.terminal.quickCommands',
		group: G,
		type: 'object',
		values: 'string',
		default: {},
		description:
			'คำสั่งด่วน: ชื่อ → คำสั่ง เช่น { "Tests": "bun test" } เรียกด้วย Terminal: Run Quick Command… หรือเมนูคลิกขวาของ terminal พิมพ์คำสั่งลง terminal ที่ใช้ล่าสุดแล้วกด Enter (Orca: terminalQuickCommands) (Quick commands, label → command, run with Terminal: Run Quick Command… or the terminal context menu; typed into the last used terminal.)',
		// User-only: it is text Kingu types into a shell.
		scope: 'application'
	}
];
