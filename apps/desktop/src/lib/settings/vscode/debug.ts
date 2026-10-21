// VS Code settings: debug.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const DEBUG_SETTINGS: SettingSchema[] = [
	{
		id: 'debug.openDebug',
		group: 'Debug',
		type: 'string',
		default: 'openOnDebugBreak',
		enum: ['neverOpen', 'openOnSessionStart', 'openOnFirstSessionStart', 'openOnDebugBreak'],
		description: 'เปิดมุมมอง Run and Debug เมื่อใด (Controls when the debug view should open.)'
	},
	{
		id: 'debug.internalConsoleOptions',
		group: 'Debug',
		type: 'string',
		default: 'openOnFirstSessionStart',
		enum: ['neverOpen', 'openOnSessionStart', 'openOnFirstSessionStart'],
		description: 'เปิด Debug Console เมื่อใด (Controls when the internal Debug Console should open.)'
	},
	{
		id: 'debug.saveBeforeStart',
		group: 'Debug',
		type: 'string',
		default: 'allEditorsInActiveGroup',
		enum: ['allEditorsInActiveGroup', 'nonUntitledEditorsInActiveGroup', 'none'],
		enumDescriptions: [
			'บันทึกทุก editor ในกลุ่มที่ใช้งานอยู่ (Save all editors in the active group before starting a debug session.)',
			'บันทึกทุก editor ในกลุ่มที่ใช้งานอยู่ ยกเว้นไฟล์ untitled (Save all editors in the active group except untitled ones before starting a debug session.)',
			'ไม่บันทึก (Don\'t save any editors before starting a debug session.)'
		],
		description: 'บันทึก editor ใดบ้างก่อนเริ่ม debug (Controls what editors to save before starting a debug session.)'
	},
	{
		id: 'debug.showVariableTypes',
		group: 'Debug',
		type: 'boolean',
		default: false,
		description: 'แสดงชนิดของตัวแปรในมุมมอง Variables ระหว่าง debug (Show variable type in variable pane during debug session)'
	},
	{
		id: 'debug.allowBreakpointsEverywhere',
		group: 'Debug',
		type: 'boolean',
		default: false,
		description: 'ให้ตั้ง breakpoint ได้ในทุกไฟล์ ไม่ใช่เฉพาะภาษาที่มี debugger (Allow setting breakpoints in any file.)'
	},
	{
		id: 'debug.gutterMiddleClickAction',
		group: 'Debug',
		type: 'string',
		default: 'logpoint',
		enum: ['logpoint', 'conditionalBreakpoint', 'triggeredBreakpoint', 'none'],
		enumDescriptions: [
			'เพิ่ม logpoint (Add Logpoint.)',
			'เพิ่ม breakpoint แบบมีเงื่อนไข (Add Conditional Breakpoint.)',
			'เพิ่ม triggered breakpoint (Add Triggered Breakpoint.)',
			'ไม่ทำอะไร (Don\'t perform any action.)'
		],
		description: 'สิ่งที่ทำเมื่อคลิกปุ่มกลางของเมาส์ที่ขอบ editor (Controls the action to perform when clicking the editor gutter with the middle mouse button.)'
	},
	{
		id: 'debug.openExplorerOnEnd',
		group: 'Debug',
		type: 'boolean',
		default: false,
		description: 'เปิดมุมมอง Explorer เองเมื่อ debug session จบ (Automatically open the explorer view at the end of a debug session.)'
	},
	{
		id: 'debug.inlineValues',
		group: 'Debug',
		type: 'string',
		default: 'auto',
		enum: ['on', 'off', 'auto'],
		enumDescriptions: [
			'แสดงเสมอ (Always show variable values inline in editor while debugging.)',
			'ไม่แสดง (Never show variable values inline in editor while debugging.)',
			'แสดงเมื่อภาษารองรับตำแหน่งของค่า (Show variable values inline in editor while debugging when the language supports inline value locations.)'
		],
		description: 'แสดงค่าของตัวแปรต่อท้ายบรรทัดใน editor ระหว่าง debug (Show variable values inline in editor while debugging.)'
	},
	{
		id: 'debug.toolBarLocation',
		group: 'Debug',
		type: 'string',
		default: 'floating',
		enum: ['floating', 'docked', 'commandCenter', 'hidden'],
		enumDescriptions: [
			'ลอยอยู่เหนือทุกมุมมอง (Show debug toolbar in all views.)',
			'อยู่ในมุมมอง Run and Debug เท่านั้น (Show debug toolbar only in debug views.)',
			'อยู่ใน command center ของแถบชื่อหน้าต่าง (`(Experimental)` Show debug toolbar in the command center.)',
			'ไม่แสดง (Do not show debug toolbar.)'
		],
		description: 'ตำแหน่งของแถบเครื่องมือ debug (Controls the location of the debug toolbar. Either `floating` in all views, `docked` in the debug view, `commandCenter` (requires `#window.commandCenter#`), or `hidden`.)'
	},
	{
		id: 'debug.showInStatusBar',
		group: 'Debug',
		type: 'string',
		default: 'onFirstSessionStart',
		enum: ['never', 'always', 'onFirstSessionStart'],
		enumDescriptions: [
			'ไม่แสดง (Never show debug item in status bar)',
			'แสดงเสมอ (Always show debug item in status bar)',
			'แสดงหลังเริ่ม debug ครั้งแรก (Show debug item in status bar only after debug was started for the first time)'
		],
		description: 'แสดงรายการ debug ในแถบสถานะเมื่อใด (Controls when the debug status bar item should be visible.)'
	},
	{
		id: 'debug.console.closeOnEnd',
		group: 'Debug',
		type: 'boolean',
		default: false,
		description: 'ปิด Debug Console เองเมื่อ debug session จบ (Controls if the Debug Console should be automatically closed when the debug session ends.)'
	},
	{
		id: 'debug.console.fontSize',
		group: 'Debug',
		type: 'number',
		default: 12,
		description: 'ขนาดตัวอักษรของ Debug Console เป็นพิกเซล (Controls the font size in pixels in the Debug Console.)'
	},
	{
		id: 'debug.console.fontFamily',
		group: 'Debug',
		type: 'string',
		default: 'default',
		description: 'ฟอนต์ของ Debug Console (Controls the font family in the Debug Console.)'
	},
	{
		id: 'debug.console.lineHeight',
		group: 'Debug',
		type: 'number',
		default: 0,
		description: 'ความสูงบรรทัดของ Debug Console เป็นพิกเซล ค่า 0 คือคำนวณจากขนาดตัวอักษร (Controls the line height in pixels in the Debug Console. Use 0 to compute the line height from the font size.)'
	},
	{
		id: 'debug.console.wordWrap',
		group: 'Debug',
		type: 'boolean',
		default: true,
		description: 'ตัดบรรทัดใน Debug Console (Controls if the lines should wrap in the Debug Console.)'
	},
	{
		id: 'debug.console.historySuggestions',
		group: 'Debug',
		type: 'boolean',
		default: true,
		description: 'แนะนำสิ่งที่เคยพิมพ์ใน Debug Console (Controls if the Debug Console should suggest previously typed input.)'
	},
	{
		id: 'debug.console.collapseIdenticalLines',
		group: 'Debug',
		type: 'boolean',
		default: true,
		description: 'ยุบบรรทัดที่ซ้ำกันติดกันใน Debug Console และแสดงจำนวนครั้ง (Controls if the Debug Console should collapse identical lines and show a number of occurrences with a badge.)'
	},
	{
		id: 'debug.console.acceptSuggestionOnEnter',
		group: 'Debug',
		type: 'string',
		default: 'off',
		enum: ['off', 'on'],
		description: 'กด Enter เพื่อเลือกคำแนะนำใน Debug Console (Controls whether suggestions should be accepted on Enter in the Debug Console. Enter is also used to evaluate whatever is typed in the Debug Console.)'
	},
	{
		id: 'debug.console.maximumLines',
		group: 'Debug',
		type: 'number',
		default: 10000,
		description: 'จำนวนบรรทัดสูงสุดที่ Debug Console เก็บไว้ (Controls the maximum number of lines in the Debug Console.)'
	},
	{
		id: 'debug.focusWindowOnBreak',
		group: 'Debug',
		type: 'boolean',
		default: true,
		description: 'ดึงหน้าต่างขึ้นมาด้านหน้าเมื่อ debugger หยุด (Controls whether the workbench window should be focused when the debugger breaks.)'
	},
	{
		id: 'debug.focusEditorOnBreak',
		group: 'Debug',
		type: 'boolean',
		default: true,
		description: 'ย้าย focus ไปที่ editor เมื่อ debugger หยุด (Controls whether the editor should be focused when the debugger breaks.)'
	},
	{
		id: 'debug.showBreakpointsInOverviewRuler',
		group: 'Debug',
		type: 'boolean',
		default: false,
		description: 'แสดง breakpoint ในแถบ overview ruler ของ editor (Controls whether breakpoints should be shown in the overview ruler.)'
	},
	{
		id: 'debug.breakpointsView.presentation',
		group: 'Debug',
		type: 'string',
		default: 'list',
		enum: ['tree', 'list'],
		description: 'แสดง breakpoint เป็นต้นไม้แยกตามไฟล์ หรือเป็นรายการเดียว (Controls whether breakpoints are displayed in a tree view grouped by file, or as a flat list.)'
	},
	{
		id: 'debug.confirmOnExit',
		group: 'Debug',
		type: 'string',
		default: 'never',
		enum: ['never', 'always'],
		enumDescriptions: ['Never confirm.', 'Always confirm if there are debug sessions.'],
		description: 'ถามก่อนปิดหน้าต่างเมื่อมี debug session ทำงานอยู่ (Controls whether to confirm when the window closes if there are active debug sessions.)'
	},
	{
		id: 'debug.enableStatusBarColor',
		group: 'Debug',
		type: 'boolean',
		default: true,
		description: 'เปลี่ยนสีแถบสถานะระหว่าง debug (Color of the status bar when the debugger is active.)'
	},
	{
		id: 'debug.showSubSessionsInToolBar',
		group: 'Debug',
		type: 'boolean',
		default: false,
		description: 'แสดง sub-session ในแถบเครื่องมือ debug เมื่อปิด คำสั่ง Stop บน sub-session จะหยุด session แม่ด้วย (Controls whether the debug sub-sessions are shown in the debug tool bar. When this setting is false the stop command on a sub-session will also stop the parent session.)'
	},
	{
		id: 'debug.autoExpandLazyVariables',
		group: 'Debug',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'on', 'off'],
		enumDescriptions: [
			'ขยายเองเมื่ออยู่ในโหมดสำหรับโปรแกรมอ่านหน้าจอ (When in screen reader optimized mode, automatically expand lazy variables.)',
			'ขยายเองเสมอ (Always automatically expand lazy variables.)',
			'ไม่ขยายเอง (Never automatically expand lazy variables.)'
		],
		description: 'ดึงค่าตัวแปรแบบ lazy (เช่น getter) มาแสดงเองหรือไม่ (Controls whether variables that are lazily resolved, such as getters, are automatically resolved and expanded by the debugger.)'
	},
	{
		id: 'debug.hideLauncherWhileDebugging',
		group: 'Debug',
		type: 'boolean',
		default: false,
		description: 'ซ่อนปุ่ม Start Debugging ในมุมมอง Run and Debug ระหว่าง debug ใช้เฉพาะเมื่อ debug.toolBarLocation ไม่ใช่ docked (Hide \'Start Debugging\' control in title bar of \'Run and Debug\' view while debugging is active. Only relevant when `#debug.toolBarLocation#` is not `docked`.)'
	},
	{
		id: 'debug.hideSlowPreLaunchWarning',
		group: 'Debug',
		type: 'boolean',
		default: false,
		description: 'ซ่อนคำเตือนเมื่อ preLaunchTask รันนาน (Hide the warning shown when a `preLaunchTask` has been running for a while.)'
	}
];
