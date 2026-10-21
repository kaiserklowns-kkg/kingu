// VS Code settings: window.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const WINDOW_SETTINGS: SettingSchema[] = [
	{
		id: 'window.zoomLevel',
		group: 'Window',
		type: 'number',
		default: 0,
		minimum: -8,
		maximum: 8,
		description: 'ระดับการซูมของหน้าต่าง แต่ละขั้นใหญ่หรือเล็กลง 20% (Adjust the default zoom level for all windows. Each increment above `0` (e.g. `1`) or below (e.g. `-1`) represents zooming `20%` larger or smaller. You can also enter decimals to adjust the zoom level with a finer granularity. See `#window.zoomPerWindow#` for configuring if the \'Zoom In\' and \'Zoom Out\' commands apply the zoom level to all windows or only the active window.)',
		scope: 'application'
	},
	{
		id: 'window.titleSeparator',
		group: 'Window',
		type: 'string',
		default: ' — ',
		description: 'ตัวคั่นที่ใช้แทน ${separator} ใน window.title (Separator used by `#window.title#`.)'
	},
	{
		id: 'window.commandCenter',
		group: 'Window',
		type: 'boolean',
		default: true,
		description: 'แสดง command center ช่องค้นหาคำสั่งกลางแถบชื่อเรื่อง (Show command launcher together with the window title. This setting only has an effect when `#window.customTitleBarVisibility#` is not set to `never`.)'
	},
	{
		id: 'window.menuBarVisibility',
		group: 'Window',
		type: 'string',
		default: 'classic',
		enum: ['classic', 'visible', 'toggle', 'hidden', 'compact'],
		enumDescriptions: [
			'แสดงเมนูบนแถบชื่อเรื่อง ซ่อนเมื่อเต็มจอ (Menu is displayed at the top of the window and only hidden in full screen mode.)',
			'แสดงเมนูเสมอแม้เต็มจอ (Menu is always visible at the top of the window even in full screen mode.)',
			'ซ่อนเมนู กด Alt เพื่อแสดง (Menu is hidden but can be displayed at the top of the window via the Alt key.)',
			'ซ่อนเมนูเสมอ (Menu is always hidden.)',
			'รวมเมนูไว้ในปุ่มเดียว (Menu is displayed as a compact button in the side bar. This value is ignored when `#window.titleBarStyle#` is `native` and `#window.menuStyle#` is either `native` or `inherit`.)'
		],
		description: 'การแสดงเมนูในหน้าต่างบน Linux และ Windows ส่วน macOS ใช้เมนูของระบบ (Control the visibility of the menu bar. A setting of \'toggle\' means that the menu bar is hidden and a single press of the Alt key will show it. A setting of \'compact\' will move the menu into the side bar.)',
		scope: 'application'
	},
	{
		id: 'window.autoDetectColorScheme',
		group: 'Window',
		type: 'boolean',
		default: false,
		description: 'เปลี่ยนธีมตามโหมดสว่างหรือมืดของระบบ ใช้ workbench.preferredDarkColorTheme และ preferredLightColorTheme (If enabled, will automatically select a color theme based on the system color mode. If the system color mode is dark, `#workbench.preferredDarkColorTheme#` is used, else `#workbench.preferredLightColorTheme#`.)'
	},
	{
		id: 'window.autoDetectHighContrast',
		group: 'Window',
		type: 'boolean',
		default: true,
		description: 'ใช้ธีม high contrast เมื่อระบบเปิดโหมดเพิ่มคอนทราสต์ (If enabled, will automatically change to high contrast theme if the OS is using a high contrast theme. The high contrast theme to use is specified by `#workbench.preferredHighContrastColorTheme#` and `#workbench.preferredHighContrastLightColorTheme#`.)',
		scope: 'application'
	},
	{
		id: 'window.systemColorTheme',
		group: 'Window',
		type: 'string',
		default: 'default',
		enum: ['default', 'auto', 'light', 'dark'],
		enumDescriptions: [
			'ตามสีของระบบ (Native widget colors match the system colors.)',
			'ตามชนิดของธีมสีที่ใช้ สว่างหรือมืด (Use light native widget colors for light color themes and dark for dark color themes.)',
			'ใช้สีสว่างเสมอ (Use light native widget colors.)',
			'ใช้สีมืดเสมอ (Use dark native widget colors.)'
		],
		description: 'สีของส่วนที่ระบบวาด เช่น กล่องโต้ตอบ เมนู และแถบหน้าต่าง (Set the color mode for native UI elements such as native dialogs, menus and title bar. Even if your OS is configured in light color mode, you can select a dark system color theme for the window. You can also configure to automatically adjust based on the `#workbench.colorTheme#` setting.\n\nNote: This setting is ignored when `#window.autoDetectColorScheme#` is enabled.)',
		scope: 'application'
	},
	{
		id: 'window.density.editorTabHeight',
		group: 'Window',
		type: 'string',
		default: 'default',
		enum: ['default', 'compact'],
		enumDescriptions: ['ความสูงปกติ', 'แท็บเตี้ยลงแบบกะทัดรัด'],
		description: 'ความสูงของแท็บ editor แบบปกติหรือกะทัดรัด (Controls the height of editor tabs. Also applies to the title control bar when `#workbench.editor.showTabs#` is not set to `multiple`.)'
	},
	{
		id: 'window.restoreWindows',
		group: 'Window',
		type: 'string',
		default: 'all',
		enum: ['preserve', 'all', 'folders', 'one', 'none'],
		enumDescriptions: [
			'เปิดโฟลเดอร์ล่าสุดคืนเสมอ (Always reopen all windows. If a folder or workspace is opened (e.g. from the command line) it opens as a new window unless it was opened before. If files are opened they will open in one of the restored windows together with editors that were previously opened.)',
			'เปิดโฟลเดอร์ล่าสุดคืน (Reopen all windows unless a folder, workspace or file is opened (e.g. from the command line). If a file is opened, it will replace any of the editors that were previously opened in a window.)',
			'เปิดโฟลเดอร์ล่าสุดคืน (Reopen all windows that had folders or workspaces opened unless a folder, workspace or file is opened (e.g. from the command line). If a file is opened, it will replace any of the editors that were previously opened in a window.)',
			'เปิดโฟลเดอร์ล่าสุดคืน (Reopen the last active window unless a folder, workspace or file is opened (e.g. from the command line). If a file is opened, it will replace any of the editors that were previously opened in a window.)',
			'เริ่มด้วยหน้าต่างว่าง (Never reopen a window. Unless a folder or workspace is opened (e.g. from the command line), an empty window will appear.)'
		],
		description: 'หน้าต่างที่เปิดคืนเมื่อเริ่ม Kingu แต่ละหน้าต่างกลับมาพร้อมโฟลเดอร์หรือ workspace ของตัวเอง (Controls how windows and editors within are being restored when opening.)',
		scope: 'application'
	},
	{
		id: 'window.openFoldersInNewWindow',
		group: 'Window',
		type: 'string',
		default: 'default',
		enum: ['on', 'off', 'default'],
		enumDescriptions: [
			'เปิดโฟลเดอร์ในหน้าต่างใหม่ (Folders will open in a new window.)',
			'เปิดโฟลเดอร์แทนที่หน้าต่างที่ใช้อยู่ล่าสุด (Folders will replace the last active window.)',
			'เปิดในหน้าต่างใหม่ ยกเว้นเลือกโฟลเดอร์จากในแอป เช่นเมนู File (Folders will open in a new window unless a folder is picked from within the application (e.g. via the File menu).)'
		],
		description: 'เปิดโฟลเดอร์ในหน้าต่างใหม่หรือแทนที่หน้าต่างที่ใช้อยู่ล่าสุด (Controls whether folders should open in a new window or replace the last active window.\nNote that there can still be cases where this setting is ignored (e.g. when using the `--new-window` or `--reuse-window` command line option).)',
		scope: 'application'
	},
	{
		id: 'window.openFilesInNewWindow',
		group: 'Window',
		type: 'string',
		default: 'off',
		enum: ['on', 'off', 'default'],
		enumDescriptions: [
			'เปิดไฟล์ในหน้าต่างใหม่ (Files will open in a new window.)',
			'เปิดไฟล์ในหน้าต่างที่มีโฟลเดอร์ของไฟล์นั้น หรือหน้าต่างที่ใช้อยู่ล่าสุด (Files will open in the window with the files\' folder open or the last active window.)',
			'เปิดในหน้าต่างใหม่ ยกเว้นเลือกไฟล์จากในแอป เช่นเมนู File (Files will open in a new window unless picked from within the application (e.g. via the File menu).)'
		],
		description: 'เปิดไฟล์ในหน้าต่างใหม่หรือไม่ เมื่อเปิดจาก command line หรือกล่องเลือกไฟล์ (Controls whether files should open in a new window when using a command line or file dialog.\nNote that there can still be cases where this setting is ignored (e.g. when using the `--new-window` or `--reuse-window` command line option).)',
		scope: 'application'
	},
	{
		id: 'window.confirmBeforeClose',
		group: 'Window',
		type: 'string',
		default: 'never',
		enum: ['always', 'never'],
		enumDescriptions: ['ถามทุกครั้ง (Always ask for confirmation.)', 'ไม่ถาม (Never explicitly ask for confirmation.)'],
		description: 'ถามก่อนปิดหน้าต่างหรือออกจาก Kingu (Controls whether to show a confirmation dialog before closing a window or quitting the application.)',
		scope: 'application'
	},
	{
		id: 'window.enableMenuBarMnemonics',
		group: 'Window',
		type: 'boolean',
		default: true,
		description: 'เปิดเมนูด้วย Alt กับตัวอักษรขีดเส้นใต้ บน Linux และ Windows (Controls whether the main menus can be opened via Alt-key shortcuts. Disabling mnemonics allows to bind these Alt-key shortcuts to editor commands instead.)',
		scope: 'application'
	},
	{
		id: 'window.customMenuBarAltFocus',
		group: 'Window',
		type: 'boolean',
		default: true,
		description: 'กด Alt แล้วปล่อยเพื่อโฟกัสเมนูบาร์ บน Linux และ Windows (Controls whether the menu bar will be focused by pressing the Alt-key. This setting has no effect on toggling the menu bar with the Alt-key.)',
		scope: 'application'
	},
	{
		id: 'window.closeWhenEmpty',
		group: 'Window',
		type: 'boolean',
		default: false,
		description: 'ปิดหน้าต่างเมื่อปิด editor ตัวสุดท้าย (เฉพาะหน้าต่างที่ไม่ได้เปิดโฟลเดอร์) (Controls whether closing the last editor should also close the window. This setting only applies for windows that do not show folders.)'
	},
	{
		id: 'window.doubleClickIconToClose',
		group: 'Window',
		type: 'boolean',
		default: false,
		description: 'ดับเบิลคลิกไอคอนแอปในแถบชื่อเรื่องเพื่อปิดหน้าต่าง และลากหน้าต่างจากไอคอนไม่ได้ (Windows/Linux) (If enabled, this setting will close the window when the application icon in the title bar is double-clicked. The window will not be able to be dragged by the icon. This setting is effective only if `#window.titleBarStyle#` is set to `custom`.)',
		scope: 'application'
	},
	{
		id: 'window.customTitleBarVisibility',
		group: 'Window',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'windowed', 'never'],
		enumDescriptions: [
			'แสดงตามปกติ (Automatically changes custom title bar visibility.)',
			'ซ่อนเมื่อเต็มจอ (Hide custom titlebar in full screen. When not in full screen, automatically change custom title bar visibility.)',
			'ซ่อนเมื่อเต็มจอ (แถบชื่อเรื่องของ Kingu แสดงเสมอนอกโหมดเต็มจอ) (Hide custom titlebar when `#window.titleBarStyle#` is set to `native`.)'
		],
		description: 'เมื่อใดที่แสดงแถบชื่อเรื่องของ Kingu (Adjust when the custom title bar should be shown. The custom title bar can be hidden when in full screen mode with `windowed`. The custom title bar can only be hidden in non full screen mode with `never` when `#window.titleBarStyle#` is set to `native`.)',
		scope: 'application'
	}
];
