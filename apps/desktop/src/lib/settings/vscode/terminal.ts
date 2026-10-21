// VS Code settings: terminal.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const TERMINAL_SETTINGS: SettingSchema[] = [
	{
		id: 'terminal.integrated.fontWeight',
		group: 'Terminal',
		type: 'json',
		schema: {
			anyOf: [
				{ type: 'number', minimum: 1, maximum: 1000 },
				{ type: 'string', pattern: '^(normal|bold|1000|[1-9][0-9]{0,2})$' },
				{ enum: ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'] }
			]
		},
		default: 'normal',
		description: 'น้ำหนักตัวอักษรของ terminal (The font weight to use within the terminal for non-bold text. Accepts "normal" and "bold" keywords or numbers between 1 and 1000.)'
	},
	{
		id: 'terminal.integrated.lineHeight',
		group: 'Terminal',
		type: 'number',
		default: 1,
		description: 'ตัวคูณความสูงบรรทัดของ terminal (Controls the line height of the terminal. This number is multiplied by the terminal font size to get the actual line-height in pixels.)'
	},
	{
		id: 'terminal.integrated.letterSpacing',
		group: 'Terminal',
		type: 'number',
		default: 0,
		description: 'ระยะห่างตัวอักษรเป็นพิกเซล (Controls the letter spacing of the terminal. This is an integer value which represents the number of additional pixels to add between characters.)'
	},
	{
		id: 'terminal.integrated.cursorStyle',
		group: 'Terminal',
		type: 'string',
		default: 'block',
		enum: ['block', 'line', 'underline'],
		description: 'รูปแบบเคอร์เซอร์ของ terminal (Controls the style of terminal cursor when the terminal is focused.)'
	},
	{
		id: 'terminal.integrated.cursorBlinking',
		group: 'Terminal',
		type: 'boolean',
		default: false,
		description: 'เคอร์เซอร์ของ terminal กะพริบ (Controls whether the terminal cursor blinks.)'
	},
	{
		id: 'terminal.integrated.cursorWidth',
		group: 'Terminal',
		type: 'number',
		default: 1,
		description: 'ความกว้างเคอร์เซอร์เมื่อ cursorStyle เป็น line (Controls the width of the cursor when `#terminal.integrated.cursorStyle#` is set to `line`.)'
	},
	{
		id: 'terminal.integrated.scrollback',
		group: 'Terminal',
		type: 'number',
		default: 1000,
		description: 'จำนวนบรรทัดย้อนหลังที่เก็บไว้ (Controls the maximum number of lines the terminal keeps in its buffer. We pre-allocate memory based on this value in order to ensure a smooth experience. As such, as the value increases, so will the amount of memory.)'
	},
	{
		id: 'terminal.integrated.copyOnSelection',
		group: 'Terminal',
		type: 'boolean',
		default: false,
		description: 'คัดลอกข้อความที่เลือกใน terminal ทันที (Controls whether text selected in the terminal will be copied to the clipboard.)'
	},
	{
		id: 'terminal.integrated.macOptionIsMeta',
		group: 'Terminal',
		type: 'boolean',
		default: false,
		description: 'ใช้ปุ่ม Option เป็น Meta บน macOS (Controls whether to treat the option key as the meta key in the terminal on macOS.)'
	},
	{
		id: 'terminal.integrated.altClickMovesCursor',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: '⌥/Alt + คลิกเพื่อย้ายเคอร์เซอร์ของ shell (If enabled, alt/option + click will reposition the prompt cursor to underneath the mouse when `#editor.multiCursorModifier#` is set to `\'alt\'` (the default value). This may not work reliably depending on your shell.)'
	},
	{
		id: 'terminal.integrated.drawBoldTextInBrightColors',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'ตัวหนาใช้สีสว่าง (Controls whether bold text in the terminal will always use the "bright" ANSI color variant.)'
	},
	{
		id: 'terminal.integrated.minimumContrastRatio',
		group: 'Terminal',
		type: 'number',
		default: 4.5,
		description: 'ปรับสีตัวอักษรให้มีความต่างของสีอย่างน้อยเท่านี้ 1 = ไม่ปรับ (When set, the foreground color of each cell will change to try meet the contrast ratio specified. Note that this will not apply to `powerline` characters per #146406. Example values:\n\n- 1: Do nothing and use the standard theme colors.\n- 4.5: [WCAG AA compliance (minimum)](https://www.w3.org/TR/UNDERSTANDING-WCAG20/visual-audio-contrast-contrast.html) (default).\n- 7: [WCAG AAA compliance (enhanced)](https://www.w3.org/TR/UNDERSTANDING-WCAG20/visual-audio-contrast7.html).\n- 21: White on black or black on white.)'
	},
	{
		id: 'terminal.integrated.mouseWheelScrollSensitivity',
		group: 'Terminal',
		type: 'number',
		default: 1,
		description: 'ตัวคูณความเร็วเลื่อนด้วยล้อเมาส์ (A multiplier to be used on the `deltaY` of mouse wheel scroll events.)'
	},
	{
		id: 'terminal.integrated.fastScrollSensitivity',
		group: 'Terminal',
		type: 'number',
		default: 5,
		description: 'ตัวคูณความเร็วเลื่อนเมื่อกด ⌥/Alt (Scrolling speed multiplier when pressing `Alt`.)'
	},
	{
		id: 'terminal.integrated.cwd',
		group: 'Terminal',
		type: 'string',
		default: '',
		description: 'โฟลเดอร์เริ่มต้นของ terminal ใน panel (An explicit start path where the terminal will be launched, this is used as the current working directory (cwd) for the shell process. This may be particularly useful in workspace settings if the root directory is not a convenient cwd.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.env.osx',
		group: 'Terminal',
		type: 'json',
		schema: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
		default: {},
		description: 'ตัวแปร environment เพิ่มเติมของ terminal บน macOS (Object with environment variables that will be added to the Kingu process to be used by the terminal on macOS. Set to `null` to delete the environment variable.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.env.linux',
		group: 'Terminal',
		type: 'json',
		schema: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
		default: {},
		description: 'ตัวแปร environment เพิ่มเติมของ terminal บน Linux (Object with environment variables that will be added to the Kingu process to be used by the terminal on Linux. Set to `null` to delete the environment variable.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.confirmOnKill',
		group: 'Terminal',
		type: 'string',
		default: 'editor',
		enum: ['never', 'editor', 'panel', 'always'],
		enumDescriptions: [
			'ไม่ถาม (Never confirm.)',
			'ถามเมื่อ terminal อยู่ในพื้นที่ editor (Confirm if the terminal is in the editor.)',
			'ถามเมื่อ terminal อยู่ใน panel (Confirm if the terminal is in the panel.)',
			'ถามทั้งใน editor และ panel (Confirm if the terminal is either in the editor or panel.)'
		],
		description: 'ถามก่อนปิด terminal ที่มีโปรเซสทำงานอยู่ (Controls whether to confirm killing terminals when they have child processes. When set to editor, terminals in the editor area will be marked as changed when they have child processes. Note that child process detection may not work well for shells like Git Bash which don\'t run their processes as child processes of the shell. Background terminals like those launched by some extensions will not trigger the confirmation.)'
	},
	{
		id: 'terminal.integrated.fontWeightBold',
		group: 'Terminal',
		type: 'json',
		schema: {
			anyOf: [
				{ type: 'number', minimum: 1, maximum: 1000 },
				{ type: 'string', pattern: '^(normal|bold|1000|[1-9][0-9]{0,2})$' },
				{ enum: ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'] }
			]
		},
		default: 'bold',
		description: 'น้ำหนักตัวอักษรของข้อความตัวหนาใน terminal (The font weight to use within the terminal for bold text. Accepts "normal" and "bold" keywords or numbers between 1 and 1000.)'
	},
	{
		id: 'terminal.integrated.cursorStyleInactive',
		group: 'Terminal',
		type: 'string',
		default: 'outline',
		enum: ['outline', 'block', 'line', 'underline', 'none'],
		description: 'รูปแบบเคอร์เซอร์เมื่อ terminal ไม่ได้โฟกัส (Controls the style of terminal cursor when the terminal is not focused.)'
	},
	{
		id: 'terminal.integrated.tabStopWidth',
		group: 'Terminal',
		type: 'number',
		default: 8,
		minimum: 1,
		description: 'จำนวนช่องของ tab stop ใน terminal (The number of cells in a tab stop.)'
	},
	{
		id: 'terminal.integrated.wordSeparators',
		group: 'Terminal',
		type: 'string',
		default: ' ()[]{}\',"`─‘’“”|',
		description: 'ตัวอักษรที่ใช้แบ่งคำเมื่อดับเบิลคลิกเลือกคำใน terminal (A string containing all characters to be considered word separators when double-clicking to select word and in the fallback \'word\' link detection. Since this is used for link detection, including characters such as `:` that are used when detecting links will cause the line and column part of links like `file:10:5` to be ignored.)'
	},
	{
		id: 'terminal.integrated.macOptionClickForcesSelection',
		group: 'Terminal',
		type: 'boolean',
		default: false,
		description: 'บน macOS ⌥ + คลิกบังคับเลือกข้อความแม้โปรแกรมจะจับเมาส์อยู่ (Controls whether to force selection when using Option+click on macOS. This will force a regular (line) selection and disallow the use of column selection mode. This enables copying and pasting using the regular terminal selection, for example, when mouse mode is enabled in tmux.)'
	},
	{
		id: 'terminal.integrated.rightClickBehavior',
		group: 'Terminal',
		type: 'string',
		default: 'selectWord',
		enum: ['default', 'copyPaste', 'paste', 'selectWord', 'nothing'],
		enumDescriptions: [
			'แสดงเมนู (Show the context menu.)',
			'คัดลอกเมื่อมีข้อความที่เลือก ไม่เช่นนั้นวาง (Copy when there is a selection, otherwise paste.)',
			'วางเสมอ (Paste on right click.)',
			'เลือกคำใต้เคอร์เซอร์แล้วแสดงเมนู (Select the word under the cursor and show the context menu.)',
			'ไม่ทำอะไร (Do nothing and pass event to terminal.)'
		],
		description: 'สิ่งที่เกิดขึ้นเมื่อคลิกขวาใน terminal (Controls how terminal reacts to right click.)'
	},
	{
		id: 'terminal.integrated.middleClickBehavior',
		group: 'Terminal',
		type: 'string',
		default: 'default',
		enum: ['default', 'paste'],
		enumDescriptions: [
			'ไม่ทำอะไรพิเศษ (The platform default to focus the terminal. On Linux this will also paste the selection.)',
			'วางข้อความจาก clipboard (Paste on middle click.)'
		],
		description: 'สิ่งที่เกิดขึ้นเมื่อคลิกปุ่มกลางใน terminal (Controls how terminal reacts to middle click.)'
	},
	{
		id: 'terminal.integrated.smoothScrolling',
		group: 'Terminal',
		type: 'boolean',
		default: false,
		description: 'เลื่อน terminal แบบนุ่มนวลเมื่อใช้ล้อเมาส์ (Controls whether the terminal will scroll using an animation.)'
	},
	{
		id: 'terminal.integrated.ignoreBracketedPasteMode',
		group: 'Terminal',
		type: 'boolean',
		default: false,
		description: 'ไม่ใช้ bracketed paste แม้โปรแกรมใน terminal จะขอ (Controls whether the terminal will ignore bracketed paste mode even if the terminal was put into the mode, omitting the `\\x1b[200~` and `\\x1b[201~` sequences when pasting. This is useful when the shell is not respecting the mode which can happen in sub-shells for example.)'
	},
	{
		id: 'terminal.integrated.fontRendering',
		group: 'Terminal',
		type: 'string',
		default: 'inherit',
		enum: ['inherit', 'grayscale'],
		enumDescriptions: [
			'ใช้แบบเดียวกับ workbench (Follow `#workbench.fontAliasing#`.)',
			'ลบรอยหยักแบบ grayscale (Use grayscale antialiasing, which can make text look sharper. With GPU acceleration, this may require **Developer: Reload Window** to take effect.)'
		],
		description: 'การแสดงผลตัวอักษรของ terminal บน macOS (Controls how terminal text is antialiased on high-DPI displays.)'
	},
	{
		id: 'terminal.integrated.enableVisualBell',
		group: 'Terminal',
		type: 'boolean',
		default: false,
		description: 'แสดงไอคอนกระดิ่งเมื่อโปรแกรมใน terminal ส่งเสียงกระดิ่ง (Controls whether the visual terminal bell is enabled. This shows up next to the terminal\'s name.)'
	},
	{
		id: 'terminal.integrated.bellDuration',
		group: 'Terminal',
		type: 'number',
		default: 1000,
		description: 'เวลาเป็นมิลลิวินาทีที่ไอคอนกระดิ่งแสดงอยู่ (The number of milliseconds to show the bell within a terminal tab when triggered.)'
	},
	{
		id: 'terminal.integrated.enableMultiLinePasteWarning',
		group: 'Terminal',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'always', 'never'],
		enumDescriptions: [
			'เตือนเมื่อ shell ไม่รองรับ bracketed paste (Enable the warning but do not show it when:\n\n- Bracketed paste mode is enabled (the shell supports multi-line paste natively)\n- The paste is handled by the shell\'s readline (in the case of pwsh))',
			'เตือนเสมอ (Always show the warning if the text contains a new line.)',
			'ไม่เตือน (Never show the warning.)'
		],
		description: 'เตือนก่อนวางข้อความหลายบรรทัดลงใน terminal (Controls whether to show a warning dialog when pasting multiple lines into the terminal.)'
	},
	{
		id: 'terminal.integrated.showLinkHover',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำเมื่อเลื่อนเมาส์ไปบนลิงก์ใน terminal (Whether to show hovers for links in the terminal output.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.enableFileLinks',
		group: 'Terminal',
		type: 'string',
		default: 'on',
		enum: ['off', 'on', 'notRemote'],
		enumDescriptions: [
			'ไม่ตรวจหา (Always off.)',
			'ตรวจหาเสมอ (Always on.)',
			'ตรวจหาเมื่อไม่ใช่ remote (Enable only when not in a remote workspace.)'
		],
		description: 'ตรวจหาลิงก์ไปยังไฟล์ใน terminal (Whether to enable file links in terminals. Links can be slow when working on a network drive in particular because each file link is verified against the file system. Changing this will take effect only in new terminals.)'
	},
	{
		id: 'terminal.integrated.allowedLinkSchemes',
		group: 'Terminal',
		type: 'array',
		items: 'string',
		default: ['file', 'http', 'https', 'mailto', 'vscode', 'vscode-insiders'],
		description: 'scheme ของลิงก์ที่เปิดได้จาก terminal (An array of strings containing the URI schemes that the terminal is allowed to open links for. By default, only a small subset of possible schemes are allowed for security reasons.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.ignoreProcessNames',
		group: 'Terminal',
		type: 'array',
		items: 'string',
		default: ['starship', 'oh-my-posh', 'bash', 'zsh'],
		description: 'ชื่อโปรเซสที่ไม่นับว่ากำลังทำงานเมื่อถามก่อนปิด terminal (A set of process names to ignore when using the `#terminal.integrated.confirmOnKill#` setting.)'
	},
	{
		id: 'terminal.integrated.splitCwd',
		group: 'Terminal',
		type: 'string',
		default: 'inherited',
		enum: ['workspaceRoot', 'initial', 'inherited'],
		enumDescriptions: [
			'โฟลเดอร์ราก workspace (A new split terminal will use the workspace root as the working directory. In a multi-root workspace a choice for which root folder to use is offered.)',
			'โฟลเดอร์ที่ terminal ต้นทางเริ่ม (A new split terminal will use the working directory that the parent terminal started with.)',
			'โฟลเดอร์ปัจจุบันของ terminal ต้นทาง (On macOS and Linux, a new split terminal will use the working directory of the parent terminal. On Windows, this behaves the same as initial.)'
		],
		description: 'โฟลเดอร์เริ่มต้นของ terminal ที่แยกออกมา (Controls the working directory a split terminal starts with.)'
	},
	{
		id: 'terminal.integrated.hideOnLastClosed',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'ซ่อน panel ของ terminal เมื่อปิด terminal สุดท้าย (Whether to hide the terminal view when the last terminal is closed. This will only happen when the terminal is the only visible view in the view container.)'
	},
	{
		id: 'terminal.integrated.hideOnStartup',
		group: 'Terminal',
		type: 'string',
		default: 'never',
		enum: ['never', 'whenEmpty', 'always'],
		enumDescriptions: [
			'ไม่ซ่อน (Never hide the terminal view on startup.)',
			'ซ่อนเมื่อไม่มี terminal ที่กู้คืนมา (Only hide the terminal when there are no persistent sessions restored.)',
			'ซ่อนเสมอ (Always hide the terminal, even when there are persistent sessions restored.)'
		],
		description: 'ซ่อน panel ของ terminal ตอนเริ่ม Kingu (Whether to hide the terminal view on startup, avoiding creating a terminal when there are no persistent sessions.)'
	},
	{
		id: 'terminal.integrated.enablePersistentSessions',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'เก็บ session ของ terminal ไว้หลัง reload หรือเปิด Kingu ใหม่ (Persist terminal sessions/history for the workspace across window reloads.)'
	},
	{
		id: 'terminal.integrated.inheritEnv',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'shell ใหม่รับ environment ของ Kingu (Whether new shells should inherit their environment from Kingu, which may source a login shell to ensure $PATH and other development variables are initialized. This has no effect on Windows.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.detectLocale',
		group: 'Terminal',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'off', 'on'],
		enumDescriptions: [
			'ตั้งเมื่อ $LANG ยังไม่ใช่ UTF-8 (Set the `$LANG` environment variable if the existing variable does not exist or it does not end in `\'.UTF-8\'`.)',
			'ไม่ตั้ง (Do not set the `$LANG` environment variable.)',
			'ตั้งเสมอ (Always set the `$LANG` environment variable.)'
		],
		description: 'ตั้งค่า $LANG ของ shell ให้ตรงกับภาษาของ Kingu (Controls whether to detect and set the `$LANG` environment variable to a UTF-8 compliant option since Kingu\'s terminal only supports UTF-8 encoded data coming from the shell.)'
	},
	{
		id: 'terminal.integrated.resizeDimensionsOverlay.enabled',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'แสดงจำนวนคอลัมน์และแถวขณะปรับขนาด terminal (Whether to show a visual overlay with the terminal\'s columns and rows when it is resized.)'
	},
	{
		id: 'terminal.integrated.mouseWheelZoom',
		group: 'Terminal',
		type: 'boolean',
		default: false,
		description: 'กดปุ่ม ⌘ หรือ Ctrl แล้วหมุนล้อเมาส์เพื่อซูมตัวอักษรของ terminal (Zoom the font of the terminal when using mouse wheel and holding `Cmd`.)'
	},
	{
		id: 'terminal.integrated.autoReplies',
		group: 'Terminal',
		type: 'json',
		schema: { type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
		default: {},
		description: 'ข้อความที่ตอบให้อัตโนมัติเมื่อเจอข้อความนั้นใน terminal (A set of messages that, when encountered in the terminal, will be automatically responded to. Provided the message is specific enough, this can help automate away common responses.\n\nRemarks:\n\n- Use `"Terminate batch job (Y/N)": "Y\\r"` to automatically respond to the terminate batch job prompt on Windows.\n- The message includes escape sequences so the reply might not happen with styled text.\n- Each reply can only happen once every second.\n- Use `"\\r"` in the reply to mean the enter key.\n- To unset a default key, set the value to null.\n- Restart Kingu if new don\'t apply.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.enableNotifications',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'แสดงการแจ้งเตือนที่โปรแกรมใน terminal ส่งมาด้วย OSC 99 (Controls whether notifications sent from the terminal via OSC 99 are shown. This uses notifications inside the product instead of desktop notifications. Sounds, icons and filtering are not supported.)'
	},
	{
		id: 'terminal.integrated.confirmOnExit',
		group: 'Terminal',
		type: 'string',
		default: 'never',
		enum: ['never', 'always', 'hasChildProcesses'],
		enumDescriptions: [
			'ไม่ถาม (Never confirm.)',
			'ถามเสมอเมื่อมี terminal (Always confirm if there are terminals.)',
			'ถามเมื่อมีโปรเซสทำงานใน terminal (Confirm if there are any terminals that have child processes.)'
		],
		description: 'ถามก่อนปิดหน้าต่างเมื่อยังมี session ของ terminal (Controls whether to confirm when the window closes if there are active terminal sessions. Background terminals like those launched by some extensions will not trigger the confirmation.)'
	},
	{
		id: 'terminal.integrated.sendKeybindingsToShell',
		group: 'Terminal',
		type: 'boolean',
		default: false,
		description: 'ส่งคีย์ลัดส่วนใหญ่ไปยัง shell แทน workbench (Dispatches most keybindings to the terminal instead of the workbench, overriding `#terminal.integrated.commandsToSkipShell#`, which can be used alternatively for fine tuning.)'
	},
	{
		id: 'terminal.integrated.commandsToSkipShell',
		group: 'Terminal',
		type: 'array',
		items: 'string',
		default: [],
		description: 'คำสั่งที่คีย์ลัดไม่ถูกส่งไปยัง shell แต่ให้ workbench จัดการ (A set of command IDs whose keybindings will not be sent to the shell but instead always be handled by Kingu. This allows keybindings that would normally be consumed by the shell to act instead the same as when the terminal is not focused, for example `Ctrl+P` to launch Quick Open.\n\n&nbsp;\n\nMany commands are skipped by default. To override a default and pass that command\'s keybinding to the shell instead, add the command prefixed with the `-` character. For example add `-workbench.action.quickOpen` to allow `Ctrl+P` to reach the shell.\n\n&nbsp;\n\nThe following list of default skipped commands is truncated when viewed in Settings Editor. To see the full list, [open the default settings JSON](command:workbench.action.openRawDefaultSettings \'Open Default Settings (JSON)\') and search for the first command from the list below.\n\n&nbsp;\n\nDefault Skipped Commands:\n\n- editor.action.accessibilityHelp\n- editor.action.toggleTabFocusMode\n- notification.acceptPrimaryAction\n- notifications.hideList\n- notifications.hideToasts\n- runCommands\n- sessions.focusActiveSession\n- sessions.focusSessionInGrid1\n- sessions.focusSessionInGrid2\n- sessions.focusSessionInGrid3\n- sessions.focusSessionInGrid4\n- sessions.focusSessionInGrid5\n- sessions.focusSessionInGrid6\n- sessions.focusSessionInGrid7\n- sessions.focusSessionInGrid8\n- sessions.focusSessionInGrid9\n- sessions.goBack\n- sessions.goForward\n- sessionsViewPane.navigateNextSession\n- sessionsViewPane.navigatePreviousSession\n- workbench.action.closeQuickOpen\n- workbench.action.debug.continue\n- workbench.action.debug.disconnect\n- workbench.action.debug.pause\n- workbench.action.debug.restart\n- workbench.action.debug.run\n- workbench.action.debug.start\n- workbench.action.debug.stepInto\n- workbench.action.debug.stepOut\n- workbench.action.debug.stepOver\n- workbench.action.debug.stop\n- workbench.action.firstEditorInGroup\n- workbench.action.focusActiveEditorGroup\n- workbench.action.focusEighthEditorGroup\n- workbench.action.focusFifthEditorGroup\n- workbench.action.focusFirstEditorGroup\n- workbench.action.focusFourthEditorGroup\n- workbench.action.focusLastEditorGroup\n- workbench.action.focusNextPart\n- workbench.action.focusPreviousPart\n- workbench.action.focusSecondEditorGroup\n- workbench.action.focusSeventhEditorGroup\n- workbench.action.focusSixthEditorGroup\n- workbench.action.focusThirdEditorGroup\n- workbench.action.lastEditorInGroup\n- workbench.action.navigateDown\n- workbench.action.navigateLeft\n- workbench.action.navigateRight\n- workbench.action.navigateUp\n- workbench.action.nextEditor\n- workbench.action.nextEditorInGroup\n- workbench.action.nextPanelView\n- workbench.action.nextSideBarView\n- workbench.action.openNextRecentlyUsedEditor\n- workbench.action.openNextRecentlyUsedEditorInGroup\n- workbench.action.openPreviousRecentlyUsedEditor\n- workbench.action.openPreviousRecentlyUsedEditorInGroup\n- workbench.action.previousEditor\n- workbench.action.previousEditorInGroup\n- workbench.action.previousPanelView\n- workbench.action.previousSideBarView\n- workbench.action.quickOpen\n- workbench.action.quickOpenLeastRecentlyUsedEditor\n- workbench.action.quickOpenLeastRecentlyUsedEditorInGroup\n- workbench.action.quickOpenPreviousEditor\n- workbench.action.quickOpenPreviousRecentlyUsedEditor\n- workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup\n- workbench.action.quickOpenView\n- workbench.action.showCommands\n- workbench.action.tasks.build\n- workbench.action.tasks.reRunTask\n- workbench.action.tasks.rerunForActiveTerminal\n- workbench.action.tasks.restartTask\n- workbench.action.tasks.runTask\n- workbench.action.tasks.showLog\n- workbench.action.tasks.showTasks\n- workbench.action.tasks.terminate\n- workbench.action.tasks.test\n- workbench.action.terminal.acceptSelectedSuggestion\n- workbench.action.terminal.acceptSelectedSuggestionEnter\n- workbench.action.terminal.chat.cancel\n- workbench.action.terminal.chat.close\n- workbench.action.terminal.chat.discard\n- workbench.action.terminal.chat.feedbackHelpful\n- workbench.action.terminal.chat.feedbackReportIssue\n- workbench.action.terminal.chat.feedbackUnhelpful\n- workbench.action.terminal.chat.insertCommand\n- workbench.action.terminal.chat.makeRequest\n- workbench.action.terminal.chat.runCommand\n- workbench.action.terminal.chat.start\n- workbench.action.terminal.chat.viewInChat\n- workbench.action.terminal.clear\n- workbench.action.terminal.clearSelection\n- workbench.action.terminal.copyAndClearSelection\n- workbench.action.terminal.copyLastCommand\n- workbench.action.terminal.copyLastCommandAndLastCommandOutput\n- workbench.action.terminal.copyLastCommandOutput\n- workbench.action.terminal.copySelection\n- workbench.action.terminal.copySelectionAsHtml\n- workbench.action.terminal.deleteToLineStart\n- workbench.action.terminal.deleteWordLeft\n- workbench.action.terminal.deleteWordRight\n- workbench.action.terminal.findNext\n- workbench.action.terminal.findPrevious\n- workbench.action.terminal.focus\n- workbench.action.terminal.focusAccessibleBuffer\n- workbench.action.terminal.focusAtIndex1\n- workbench.action.terminal.focusAtIndex2\n- workbench.action.terminal.focusAtIndex3\n- workbench.action.terminal.focusAtIndex4\n- workbench.action.terminal.focusAtIndex5\n- workbench.action.terminal.focusAtIndex6\n- workbench.action.terminal.focusAtIndex7\n- workbench.action.terminal.focusAtIndex8\n- workbench.action.terminal.focusAtIndex9\n- workbench.action.terminal.focusFind\n- workbench.action.terminal.focusHover\n- workbench.action.terminal.focusNext\n- workbench.action.terminal.focusNextPane\n- workbench.action.terminal.focusPrevious\n- workbench.action.terminal.focusPreviousPane\n- workbench.action.terminal.goToRecentDirectory\n- workbench.action.terminal.hideFind\n- workbench.action.terminal.hideSuggestWidget\n- workbench.action.terminal.kill\n- workbench.action.terminal.killEditor\n- workbench.action.terminal.moveToEditor\n- workbench.action.terminal.moveToLineEnd\n- workbench.action.terminal.moveToLineStart\n- workbench.action.terminal.moveToTerminalPanel\n- workbench.action.terminal.new\n- workbench.action.terminal.newInActiveWorkspace\n- workbench.action.terminal.newInNewWindow\n- workbench.action.terminal.paste\n- workbench.action.terminal.pastePwsh\n- workbench.action.terminal.pasteSelection\n- workbench.action.terminal.resizePaneDown\n- workbench.action.terminal.resizePaneLeft\n- workbench.action.terminal.resizePaneRight\n- workbench.action.terminal.resizePaneUp\n- workbench.action.terminal.runActiveFile\n- workbench.action.terminal.runRecentCommand\n- workbench.action.terminal.runSelectedText\n- workbench.action.terminal.scrollDown\n- workbench.action.terminal.scrollDownPage\n- workbench.action.terminal.scrollToBottom\n- workbench.action.terminal.scrollToNextCommand\n- workbench.action.terminal.scrollToPreviousCommand\n- workbench.action.terminal.scrollToTop\n- workbench.action.terminal.scrollUp\n- workbench.action.terminal.scrollUpPage\n- workbench.action.terminal.searchWorkspace\n- workbench.action.terminal.selectAll\n- workbench.action.terminal.selectNextPageSuggestion\n- workbench.action.terminal.selectNextSuggestion\n- workbench.action.terminal.selectPrevPageSuggestion\n- workbench.action.terminal.selectPrevSuggestion\n- workbench.action.terminal.selectToNextCommand\n- workbench.action.terminal.selectToNextLine\n- workbench.action.terminal.selectToPreviousCommand\n- workbench.action.terminal.selectToPreviousLine\n- workbench.action.terminal.sendSequence\n- workbench.action.terminal.sendSignal\n- workbench.action.terminal.sizeToContentWidth\n- workbench.action.terminal.split\n- workbench.action.terminal.splitInActiveWorkspace\n- workbench.action.terminal.stopVoice\n- workbench.action.terminal.suggestToggleDetails\n- workbench.action.terminal.suggestToggleDetailsFocus\n- workbench.action.terminal.toggleFindCaseSensitive\n- workbench.action.terminal.toggleFindRegex\n- workbench.action.terminal.toggleFindWholeWord\n- workbench.action.terminal.toggleTerminal\n- workbench.action.terminal.triggerSuggest\n- workbench.action.toggleFullScreen\n- workbench.action.toggleMaximizedPanel\n- workbench.action.togglePanel\n- workbench.action.zoomIn\n- workbench.action.zoomOut\n- workbench.action.zoomReset)'
	},
	{
		id: 'terminal.integrated.allowChords',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'ให้คีย์ลัดสองจังหวะทำงานขณะอยู่ใน terminal (Whether or not to allow chord keybindings in the terminal. Note that when this is true and the keystroke results in a chord it will bypass `#terminal.integrated.commandsToSkipShell#`, setting this to false is particularly useful when you want ctrl+k to go to your shell (not Kingu).)'
	},
	{
		id: 'terminal.integrated.tabs.enabled',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'แสดงรายการ terminal ข้าง terminal (Controls whether terminal tabs display as a list to the side of the terminal. When this is disabled a dropdown will display instead.)'
	},
	{
		id: 'terminal.integrated.tabs.hideCondition',
		group: 'Terminal',
		type: 'string',
		default: 'singleTerminal',
		enum: ['never', 'singleTerminal', 'singleGroup'],
		enumDescriptions: [
			'แสดงเสมอ (Never hide the terminal tabs view)',
			'ซ่อนเมื่อมี terminal เดียว (Hide the terminal tabs view when there is only a single terminal opened)',
			'ซ่อนเมื่อมีกลุ่มเดียว (Hide the terminal tabs view when there is only a single terminal group opened)'
		],
		description: 'เงื่อนไขที่ซ่อนรายการ terminal (Controls whether the terminal tabs view will hide under certain conditions.)'
	},
	{
		id: 'terminal.integrated.tabs.location',
		group: 'Terminal',
		type: 'string',
		default: 'right',
		enum: ['left', 'right'],
		enumDescriptions: [
			'ซ้าย (Show the terminal tabs view to the left of the terminal)',
			'ขวา (Show the terminal tabs view to the right of the terminal)'
		],
		description: 'ตำแหน่งของรายการ terminal (Controls the location of the terminal tabs, either to the left or right of the actual terminal(s).)'
	},
	{
		id: 'terminal.integrated.tabs.focusMode',
		group: 'Terminal',
		type: 'string',
		default: 'doubleClick',
		enum: ['singleClick', 'doubleClick'],
		enumDescriptions: [
			'คลิกครั้งเดียว (Focus the terminal when clicking a terminal tab)',
			'ดับเบิลคลิก (Focus the terminal when double-clicking a terminal tab)'
		],
		description: 'คลิกครั้งเดียวหรือดับเบิลคลิกที่รายการเพื่อโฟกัส terminal (Controls whether focusing the terminal of a tab happens on double or single click.)'
	},
	{
		id: 'terminal.integrated.rescaleOverlappingGlyphs',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'ย่อตัวอักษรกว้างหนึ่งช่องที่ล้นไปทับช่องถัดไปให้พอดี (Whether to rescale glyphs horizontally that are a single cell wide but have glyphs that would overlap following cell(s). This typically happens for ambiguous width characters (eg. the roman numeral characters U+2160+) which aren\'t featured in monospace fonts. Emoji glyphs are never rescaled.)'
	},
	{
		id: 'terminal.integrated.customGlyphs',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'วาดตัวอักษรเส้นกรอบ block และ Powerline เองแทนการใช้ฟอนต์ ให้เส้นต่อกันสนิท (Whether to draw custom glyphs instead of using the font for box drawing, block elements, braille patterns, Powerline symbols and the other ranges xterm.js draws itself. This will typically result in better rendering with continuous lines, even when line height and letter spacing is used.)'
	},
	{
		id: 'terminal.integrated.defaultProfile.osx',
		group: 'Terminal',
		type: 'json',
		schema: { type: ['null', 'string'] },
		default: null,
		description: 'ชื่อโปรไฟล์ terminal ที่ใช้เริ่มต้นบน macOS (จาก terminal.integrated.profiles.osx) null = $SHELL (The default terminal profile on macOS.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.defaultProfile.linux',
		group: 'Terminal',
		type: 'json',
		schema: { type: ['null', 'string'] },
		default: null,
		description: 'ชื่อโปรไฟล์ terminal ที่ใช้เริ่มต้นบน Linux (จาก terminal.integrated.profiles.linux) null = $SHELL (The default terminal profile on Linux.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.profiles.osx',
		group: 'Terminal',
		type: 'json',
		schema: {
			type: 'object',
			additionalProperties: {
				anyOf: [
					{ type: 'null' },
					{
						type: 'object',
						properties: {
							path: { type: ['string', 'array'], items: { type: 'string' } },
							args: { type: 'array', items: { type: 'string' } },
							env: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
							overrideName: { type: 'boolean' },
							icon: { type: 'string' },
							color: { type: 'string' }
						}
					}
				]
			}
		},
		default: {
			bash: { path: 'bash', args: ['-l'], icon: 'terminal-bash' },
			zsh: { path: 'zsh', args: ['-l'] },
			fish: { path: 'fish', args: ['-l'] },
			tmux: { path: 'tmux', icon: 'terminal-tmux' },
			pwsh: { path: 'pwsh', icon: 'terminal-powershell' }
		},
		description: 'โปรไฟล์ terminal บน macOS: path (ชื่อที่หาใน PATH หรือ path เต็ม หรือรายการที่ลองตามลำดับ) args และ env (A set of terminal profile customizations for Mac which allows adding, removing or changing how terminals are launched. Profiles are made up of a mandatory path, optional arguments and other presentation options.\n\nTo override an existing profile use its profile name as the key, for example:\n\n```json\n"terminal.integrated.profile.osx": {\n  "bash": null\n}\n```\n\n[Read more about configuring profiles](https://code.visualstudio.com/docs/terminal/profiles).)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.profiles.linux',
		group: 'Terminal',
		type: 'json',
		schema: {
			type: 'object',
			additionalProperties: {
				anyOf: [
					{ type: 'null' },
					{
						type: 'object',
						properties: {
							path: { type: ['string', 'array'], items: { type: 'string' } },
							args: { type: 'array', items: { type: 'string' } },
							env: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
							overrideName: { type: 'boolean' },
							icon: { type: 'string' },
							color: { type: 'string' }
						}
					}
				]
			}
		},
		default: {
			bash: { path: 'bash', icon: 'terminal-bash' },
			zsh: { path: 'zsh' },
			fish: { path: 'fish' },
			tmux: { path: 'tmux', icon: 'terminal-tmux' },
			pwsh: { path: 'pwsh', icon: 'terminal-powershell' }
		},
		description: 'โปรไฟล์ terminal บน Linux: path (ชื่อที่หาใน PATH หรือ path เต็ม หรือรายการที่ลองตามลำดับ) args และ env (A set of terminal profile customizations for Linux which allows adding, removing or changing how terminals are launched. Profiles are made up of a mandatory path, optional arguments and other presentation options.\n\nTo override an existing profile use its profile name as the key, for example:\n\n```json\n"terminal.integrated.profile.linux": {\n  "bash": null\n}\n```\n\n[Read more about configuring profiles](https://code.visualstudio.com/docs/terminal/profiles).)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.tabs.showActiveTerminal',
		group: 'Terminal',
		type: 'string',
		default: 'singleTerminalOrNarrow',
		enum: ['always', 'singleTerminal', 'singleTerminalOrNarrow', 'never'],
		enumDescriptions: [
			'เสมอ (Always show the active terminal)',
			'เมื่อมี terminal เดียว (Show the active terminal when it is the only terminal opened)',
			'เมื่อมี terminal เดียวหรือไม่มีรายการ terminal (Show the active terminal when it is the only terminal opened or when the tabs view is in its narrow textless state)',
			'ไม่แสดง (Never show the active terminal)'
		],
		description: 'แสดงชื่อ terminal ที่ใช้อยู่บนแถบหัว panel (Shows the active terminal information in the view. This is particularly useful when the title within the tabs aren\'t visible.)'
	},
	{
		id: 'terminal.integrated.tabs.showActions',
		group: 'Terminal',
		type: 'string',
		default: 'singleTerminalOrNarrow',
		enum: ['always', 'singleTerminal', 'singleTerminalOrNarrow', 'never'],
		enumDescriptions: [
			'เสมอ (Always show the actions)',
			'เมื่อมี terminal เดียว (Show the actions when it is the only terminal opened)',
			'เมื่อมี terminal เดียวหรือไม่มีรายการ terminal (Show the actions when it is the only terminal opened or when the tabs view is in its narrow textless state)',
			'ไม่แสดง (Never show the actions)'
		],
		description: 'แสดงปุ่ม Split และ Kill ข้างปุ่ม terminal ใหม่บนแถบหัว panel (Controls whether terminal split and kill buttons are displays next to the new terminal button.)'
	},
	{
		id: 'terminal.integrated.shellIntegration.enabled',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'ใส่สคริปต์ shell integration ให้ zsh, bash, fish และ pwsh ที่เริ่มใหม่ เพื่อรู้ตำแหน่งคำสั่ง exit code และโฟลเดอร์ปัจจุบัน (Determines whether or not shell integration is auto-injected to support features like enhanced command tracking and current working directory detection. Shell integration works by injecting the script that is run when the shell is initialized. The script allows the terminal to get additional information about what\'s happening within the terminal. Supported shells: Linux/macOS: bash, fish, pwsh, zsh. This setting applies only when terminals are created, so you will need to restart your terminals for it to take effect.)'
	},
	{
		id: 'terminal.integrated.shellIntegration.decorationsEnabled',
		group: 'Terminal',
		type: 'string',
		default: 'both',
		enum: ['both', 'gutter', 'overviewRuler', 'never'],
		enumDescriptions: [
			'แสดงทั้งข้างบรรทัดและใน overview ruler (Show decorations in the gutter (left) and overview ruler (right))',
			'แสดงข้างบรรทัด (Show gutter decorations to the left of the terminal)',
			'แสดงใน overview ruler (Show overview ruler decorations to the right of the terminal)',
			'ไม่แสดง (Do not show decorations)'
		],
		description: 'จุดบอกผลของแต่ละคำสั่ง (สำเร็จ/ล้มเหลว) ที่ shell integration ตรวจพบ (When shell integration is enabled, adds a decoration for each command.)'
	},
	{
		id: 'terminal.integrated.shellIntegration.history',
		group: 'Terminal',
		type: 'number',
		default: 100,
		description: 'จำนวนคำสั่งล่าสุดที่เก็บไว้ให้ Run Recent Command (Controls the number of recently used commands to keep in the terminal command history. Set to 0 to disable terminal command history.)'
	},
	{
		id: 'terminal.integrated.shellIntegration.quickFixEnabled',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'เสนอวิธีแก้ด่วนเมื่อคำสั่งล้มเหลว เช่น พอร์ตถูกใช้อยู่ หรือ git push ที่ยังไม่มี upstream (When shell integration is enabled, enables quick fixes for terminal commands that will appear as a lightbulb to the left of the prompt.)'
	},
	{
		id: 'terminal.integrated.stickyScroll.enabled',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'ตรึงคำสั่งของผลลัพธ์ที่เลื่อนอยู่ไว้บนสุดของ terminal (Shows the current command at the top of the terminal. This feature requires shell integration to be activated. See `#terminal.integrated.shellIntegration.enabled#`.)'
	},
	{
		id: 'terminal.integrated.stickyScroll.maxLineCount',
		group: 'Terminal',
		type: 'number',
		default: 5,
		minimum: 1,
		maximum: 10,
		description: 'จำนวนบรรทัดสูงสุดของ sticky scroll (Defines the maximum number of sticky lines to show. Sticky scroll lines will never exceed 40% of the viewport regardless of this setting.)'
	},
	{
		id: 'terminal.integrated.stickyScroll.ignoredCommands',
		group: 'Terminal',
		type: 'array',
		items: 'string',
		default: ['clear', 'cls', 'clear-host', 'agent', 'agy', 'copilot', 'claude', 'codex', 'gemini'],
		description: 'คำสั่งที่ไม่ตรึงด้วย sticky scroll (A list of commands that should not trigger sticky scroll. When a command from this list is detected, the sticky scroll overlay will be hidden.)'
	},
	{
		id: 'terminal.integrated.tabs.defaultColor',
		group: 'Terminal',
		type: 'json',
		schema: { anyOf: [{ type: 'null' }, { type: 'string', enum: ['terminal.ansiBlack', 'terminal.ansiRed', 'terminal.ansiGreen', 'terminal.ansiYellow', 'terminal.ansiBlue', 'terminal.ansiMagenta', 'terminal.ansiCyan', 'terminal.ansiWhite'] }] },
		default: null,
		description: 'สีเริ่มต้นของแท็บ terminal (A theme color ID to associate with terminal icons by default.)'
	}
];
