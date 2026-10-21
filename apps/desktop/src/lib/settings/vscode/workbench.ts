// VS Code settings: workbench.* other than editor management. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';
import { KINGU_PRODUCT_ICON_THEME_ID, PRODUCT_ICON_THEMES } from '../../workbench/codicons';

export const WORKBENCH_SETTINGS: SettingSchema[] = [
	{
		id: 'workbench.startupEditor',
		group: 'Workbench',
		type: 'string',
		default: 'none',
		enum: ['none', 'readme', 'newUntitledFile', 'terminal'],
		enumDescriptions: [
			'ไม่เปิดอะไร (Start without an editor.)',
			'เปิด README ของโฟลเดอร์ (Open the README when opening a folder that contains one, fallback to \'welcomePage\' otherwise. Note: This is only observed as a global configuration, it will be ignored if set in a workspace or folder configuration.)',
			'เปิดไฟล์ข้อความใหม่ที่ยังไม่มีชื่อ (Open a new untitled text file (only applies when opening an empty window).)',
			'เปิด terminal ใน panel (Open a new terminal in the editor area.)'
		],
		description: 'editor ที่เปิดตอนเริ่มเมื่อไม่มี editor ให้กู้คืนจากครั้งก่อน (Controls which editor is shown at startup, if none are restored from the previous session.)'
	},
	{
		id: 'workbench.statusBar.visible',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง status bar ด้านล่างของหน้าต่าง (Controls the visibility of the status bar at the bottom of the workbench.)'
	},
	{
		id: 'workbench.tree.indent',
		group: 'Workbench',
		type: 'number',
		default: 8,
		minimum: 4,
		maximum: 40,
		description: 'ระยะเยื้องของ tree เป็นพิกเซล (Controls tree indentation in pixels.)'
	},
	{
		id: 'workbench.list.smoothScrolling',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'เลื่อนรายการและ tree แบบมีแอนิเมชัน (Controls whether lists and trees have smooth scrolling.)'
	},
	{
		id: 'workbench.sideBar.location',
		group: 'Workbench',
		type: 'string',
		default: 'left',
		enum: ['left', 'right'],
		enumDescriptions: ['ด้านซ้าย', 'ด้านขวา'],
		description: 'ตำแหน่งของ primary side bar และ activity bar ซ้ายหรือขวา โดย secondary side bar อยู่ฝั่งตรงข้าม (Controls the location of the primary side bar and activity bar. They can either show on the left or right of the workbench. The secondary side bar will show on the opposite side of the workbench.)'
	},
	{
		id: 'workbench.panel.defaultLocation',
		group: 'Workbench',
		type: 'string',
		default: 'bottom',
		enum: ['left', 'bottom', 'top', 'right'],
		enumDescriptions: ['ด้านซ้ายของ editor', 'ด้านล่างของ editor', 'ด้านบนของ editor', 'ด้านขวาของ editor'],
		description: 'ตำแหน่งของ panel เช่น terminal, problems, output (Controls the default location of the panel (Terminal, Debug Console, Output, Problems) in a new workspace. It can either show at the bottom, top, right, or left of the editor area.)'
	},
	{
		id: 'workbench.panel.opensMaximized',
		group: 'Workbench',
		type: 'string',
		default: 'preserve',
		enum: ['always', 'never', 'preserve'],
		enumDescriptions: [
			'ขยายเต็มทุกครั้งที่เปิด (Always maximize the panel when opening it.)',
			'ไม่ขยายเมื่อเปิด (Never maximize the panel when opening it.)',
			'คืนสถานะขยายเหมือนตอนปิดครั้งล่าสุด (Open the panel to the state that it was in, before it was closed.)'
		],
		description: 'เปิด panel แบบขยายเต็มพื้นที่ editor หรือไม่ (Controls whether the panel opens maximized. It can either always open maximized, never open maximized, or open to the last state it was in before being closed.)'
	},
	{
		id: 'workbench.panel.showLabels',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงแท็บของ panel เป็นข้อความ ปิดเพื่อแสดงเป็นไอคอน (Controls whether activity items in the panel title are shown as label or icon.)'
	},
	{
		id: 'workbench.activityBar.location',
		group: 'Workbench',
		type: 'string',
		default: 'top',
		enum: ['default', 'top', 'bottom', 'hidden'],
		enumDescriptions: [
			'แถบแนวตั้งข้าง primary side bar (Show the Activity Bar on the side of the Primary Side Bar and on top of the Secondary Side Bar.)',
			'ไอคอนอยู่บนหัว side bar (Show the Activity Bar on top of the Primary and Secondary Side Bars.)',
			'ไอคอนอยู่ท้าย side bar (Show the Activity Bar at the bottom of the Primary and Secondary Side Bars.)',
			'ซ่อน activity bar (Hide the Activity Bar in the Primary and Secondary Side Bars.)'
		],
		description: 'ตำแหน่งของ activity bar เทียบกับ side bar (Controls the location of the Activity Bar relative to the Primary and Secondary Side Bars.)'
	},
	{
		id: 'workbench.activityBar.compact',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'activity bar แบบกะทัดรัด ไอคอนเล็กลงและแถบแคบลง (Controls whether the Activity Bar uses a compact layout with smaller icons and reduced width. This setting only applies when `#workbench.activityBar.location#` is set to `default`.)'
	},
	{
		id: 'workbench.activityBar.iconClickBehavior',
		group: 'Workbench',
		type: 'string',
		default: 'toggle',
		enum: ['toggle', 'focus'],
		enumDescriptions: [
			'ซ่อน side bar ถ้าไอคอนที่คลิกเปิดอยู่แล้ว (Hide the Primary Side Bar if the clicked item is already visible.)',
			'โฟกัส view ถ้าไอคอนที่คลิกเปิดอยู่แล้ว (Focus the Primary Side Bar if the clicked item is already visible.)'
		],
		description: 'การคลิกไอคอนของ activity bar ที่เปิดอยู่แล้ว (Controls the behavior of clicking an Activity Bar icon in the workbench. This value is ignored when `#workbench.activityBar.location#` is not set to `default`.)'
	},
	{
		id: 'workbench.layoutControl.enabled',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่มควบคุมเลย์เอาต์ในแถบชื่อเรื่อง (Controls whether the layout control is shown in the custom title bar. This setting only has an effect when `#window.customTitleBarVisibility#` is not set to `never`.)'
	},
	{
		id: 'workbench.layoutControl.type',
		group: 'Workbench',
		type: 'string',
		default: 'both',
		enum: ['menu', 'toggles', 'both'],
		enumDescriptions: [
			'ปุ่มเดียวที่เปิดเมนูเลย์เอาต์ (Shows a single button with a dropdown of layout options.)',
			'ปุ่มเปิดปิด side bar และ panel (Shows several buttons for toggling the visibility of the panels and side bar.)',
			'แสดงทั้งเมนูและปุ่มเปิดปิด (Shows both the dropdown and toggle buttons.)'
		],
		description: 'รูปแบบของปุ่มควบคุมเลย์เอาต์ในแถบชื่อเรื่อง (Controls whether the layout control in the custom title bar is displayed as a single menu button or with multiple UI toggles.)'
	},
	{
		id: 'workbench.navigationControl.enabled',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่มย้อนกลับและไปข้างหน้าในแถบชื่อเรื่อง (Controls whether the navigation control is shown in the custom title bar. This setting only has an effect when `#window.customTitleBarVisibility#` is not set to `never`.)'
	},
	{
		id: 'workbench.sash.size',
		group: 'Workbench',
		type: 'number',
		default: 4,
		minimum: 1,
		maximum: 20,
		description: 'ความกว้างของแถบลากปรับขนาดระหว่าง view และ editor เป็นพิกเซล (Controls the feedback area size in pixels of the dragging area in between views/editors. Set it to a larger value if you feel it\'s hard to resize views using the mouse.)'
	},
	{
		id: 'workbench.sash.hoverDelay',
		group: 'Workbench',
		type: 'number',
		default: 300,
		minimum: 0,
		maximum: 2000,
		description: 'หน่วงเวลาก่อนแถบลากปรับขนาดเปลี่ยนสีเมื่อเอาเมาส์ชี้ เป็นมิลลิวินาที (Controls the hover feedback delay in milliseconds of the dragging area in between views/editors.)'
	},
	{
		id: 'workbench.reduceMotion',
		group: 'Workbench',
		type: 'string',
		default: 'auto',
		enum: ['on', 'off', 'auto'],
		enumDescriptions: [
			'ลดแอนิเมชันเสมอ (Always render with reduced motion.)',
			'ไม่ลดแอนิเมชัน (Do not render with reduced motion)',
			'ทำตามการตั้งค่าลดการเคลื่อนไหวของระบบ (Render with reduced motion based on OS configuration.)'
		],
		description: 'ลดแอนิเมชันของ workbench (Controls whether the workbench should render with fewer animations.)'
	},
	{
		id: 'workbench.fontAliasing',
		group: 'Workbench',
		type: 'string',
		default: 'default',
		enum: ['default', 'antialiased', 'none', 'auto'],
		enumDescriptions: [
			'ปรับขอบแบบ sub-pixel ตัวอักษรคมที่สุดบนจอส่วนใหญ่ (Sub-pixel font smoothing. On most non-retina displays this will give the sharpest text.)',
			'ปรับขอบระดับพิกเซล ตัวอักษรดูบางลง (Smooth the font on the level of the pixel, as opposed to the subpixel. Can make the font appear lighter overall.)',
			'ไม่ปรับขอบ ขอบตัวอักษรหยัก (Disables font smoothing. Text will show with jagged sharp edges.)',
			'เลือก default หรือ antialiased ตามความละเอียดของจอ (Applies `default` or `antialiased` automatically based on the DPI of displays.)'
		],
		description: 'วิธีปรับขอบตัวอักษรของ workbench บน macOS (Controls font aliasing method in the workbench.)'
	},
	{
		id: 'workbench.shadows',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงเงารอบ quick input, เมนู, การแจ้งเตือน และส่วนอื่นของ workbench (Controls whether shadow effects are shown around the side panels and other workbench elements.)'
	},
	{
		id: 'workbench.tips.enabled',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงคีย์ลัดแนะนำในพื้นที่ editor เมื่อไม่มี editor เปิดอยู่ (When enabled, will show the watermark tips when no editor is open.)'
	},
	{
		id: 'workbench.commandPalette.history',
		group: 'Workbench',
		type: 'number',
		default: 50,
		minimum: 0,
		description: 'จำนวนคำสั่งที่ใช้ล่าสุดที่ command palette จำไว้แสดงก่อน 0 คือไม่จำ (Controls the number of recently used commands to keep in history for the command palette. Set to 0 to disable command history.)'
	},
	{
		id: 'workbench.commandPalette.preserveInput',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'เปิด command palette ครั้งถัดไปพร้อมข้อความที่พิมพ์ไว้ครั้งล่าสุด (Controls whether the last typed input to the command palette should be restored when opening it the next time.)'
	},
	{
		id: 'workbench.quickOpen.closeOnFocusLost',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'ปิด quick open อัตโนมัติเมื่อโฟกัสออกจากกล่อง (Controls whether Quick Open should close automatically once it loses focus.)'
	},
	{
		id: 'workbench.quickOpen.preserveInput',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'เปิด quick open ครั้งถัดไปพร้อมข้อความที่พิมพ์ไว้ครั้งล่าสุด (Controls whether the last typed input to Quick Open should be restored when opening it the next time.)'
	},
	{
		id: 'workbench.notifications.position',
		group: 'Workbench',
		type: 'string',
		default: 'bottom-right',
		enum: ['bottom-right', 'bottom-left', 'top-right'],
		enumDescriptions: [
			'มุมขวาล่าง (Show notifications in the bottom right corner.)',
			'มุมซ้ายล่าง (Show notifications in the bottom left corner.)',
			'มุมขวาบน (Show notifications in the top right corner, similar to OS-level notifications.)'
		],
		description: 'ตำแหน่งของการแจ้งเตือนและศูนย์การแจ้งเตือน (Controls the position of the notification toasts and notification center.)'
	},
	{
		id: 'workbench.settings.editor',
		group: 'Workbench',
		type: 'string',
		default: 'ui',
		enum: ['ui', 'json'],
		enumDescriptions: [
			'หน้าการตั้งค่าแบบ UI (Use the settings UI editor.)',
			'ไฟล์ settings.json (Use the JSON file editor.)'
		],
		description: 'หน้าการตั้งค่าที่เปิดด้วยคำสั่ง Open Settings (Determines which Settings editor to use by default.)'
	},
	{
		id: 'workbench.settings.applyToAllProfiles',
		group: 'Workbench',
		type: 'array',
		items: 'string',
		default: [],
		description: 'การตั้งค่าที่ใช้ค่าเดียวกันในทุก profile เมื่อเปลี่ยนใน profile ใดก็เปลี่ยนทุก profile (Configure settings to be applied for all profiles.)',
		scope: 'application'
	},
	{
		id: 'workbench.externalBrowser',
		group: 'Workbench',
		type: 'string',
		default: '',
		description: 'เบราว์เซอร์ที่ใช้เปิดลิงก์ http/https เช่น chrome, edge, firefox หรือ path เต็มของโปรแกรม เว้นว่างใช้เบราว์เซอร์เริ่มต้นของระบบ (Configure the browser to use for opening http or https links externally. This can either be the name of the browser (`edge`, `chrome`, `firefox`) or an absolute path to the browser\'s executable. Will use the system default if not set.)',
		scope: 'application'
	},
	{
		id: 'workbench.notifications.showInTitleBar',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่มการแจ้งเตือนในแถบชื่อเรื่อง เมื่อการแจ้งเตือนอยู่มุมขวาบน (Controls the visibility of the Notifications button in the title bar. Only applies when notifications are positioned at the top right.)'
	},
	{
		id: 'workbench.list.multiSelectModifier',
		group: 'Workbench',
		type: 'string',
		default: 'ctrlCmd',
		enum: ['ctrlCmd', 'alt'],
		enumDescriptions: [
			'Command บน macOS, Control บน Windows/Linux (Maps to `Control` on Windows and Linux and to `Command` on macOS.)',
			'Option บน macOS, Alt บน Windows/Linux (Maps to `Alt` on Windows and Linux and to `Option` on macOS.)'
		],
		description: 'ปุ่มที่กดค้างขณะคลิกเพื่อเลือกหลายรายการใน list และ tree ส่วนปุ่มอีกตัวใช้เปิดไฟล์ด้านข้าง (The modifier to be used to add an item in trees and lists to a multi-selection with the mouse (for example in the explorer, open editors and scm view). The \'Open to Side\' mouse gestures - if supported - will adapt such that they do not conflict with the multiselect modifier.)'
	},
	{
		id: 'workbench.list.openMode',
		group: 'Workbench',
		type: 'string',
		default: 'singleClick',
		enum: ['singleClick', 'doubleClick'],
		description: 'เปิดรายการใน list และ tree ด้วยคลิกเดียวหรือดับเบิลคลิก (Controls how to open items in trees and lists using the mouse (if supported). Note that some trees and lists might choose to ignore this setting if it is not applicable.)'
	},
	{
		id: 'workbench.list.horizontalScrolling',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'ให้ list และ tree เลื่อนแนวนอนได้ แทนการตัดชื่อที่ยาว (Controls whether lists and trees support horizontal scrolling in the workbench. Warning: turning on this setting has a performance implication.)'
	},
	{
		id: 'workbench.list.mouseWheelScrollSensitivity',
		group: 'Workbench',
		type: 'number',
		default: 1,
		description: 'ตัวคูณระยะเลื่อนของล้อเมาส์ใน list และ tree (A multiplier to be used on the `deltaX` and `deltaY` of mouse wheel scroll events.)'
	},
	{
		id: 'workbench.list.fastScrollSensitivity',
		group: 'Workbench',
		type: 'number',
		default: 5,
		description: 'ตัวคูณความเร็วเลื่อนเมื่อกด Alt ค้างใน list และ tree (Scrolling speed multiplier when pressing `Alt`.)'
	},
	{
		id: 'workbench.tree.expandMode',
		group: 'Workbench',
		type: 'string',
		default: 'singleClick',
		enum: ['singleClick', 'doubleClick'],
		description: 'ขยายโฟลเดอร์ใน tree ด้วยคลิกเดียวหรือดับเบิลคลิก (คลิกที่ลูกศรขยายได้เสมอ) (Controls how tree folders are expanded when clicking the folder names. Note that some trees and lists might choose to ignore this setting if it is not applicable.)'
	},
	{
		id: 'workbench.tree.renderIndentGuides',
		group: 'Workbench',
		type: 'string',
		default: 'onHover',
		enum: ['none', 'onHover', 'always'],
		description: 'แสดงเส้นนำระดับย่อหน้าใน tree: ไม่แสดง เมื่อชี้เมาส์ หรือตลอดเวลา (Controls whether the tree should render indent guides.)'
	},
	{
		id: 'workbench.view.alwaysShowHeaderActions',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'แสดงปุ่มบนหัวของมุมมองตลอดเวลา แทนที่จะแสดงเมื่อชี้เมาส์หรือโฟกัส (Controls the visibility of view header actions. View header actions may either be always visible, or only visible when that view is focused or hovered over.)'
	},
	{
		id: 'workbench.colorCustomizations',
		group: 'Workbench',
		type: 'json',
		schema: { type: 'object' },
		default: {},
		description: 'แทนที่สีของธีมที่ใช้อยู่ เช่น {"editor.background": "#1e1e1e"} หรือเฉพาะธีม {"[Kingu Dark]": {...}} (Overrides colors from the currently selected color theme.)'
	},
	{
		id: 'workbench.iconTheme',
		group: 'Workbench',
		type: 'json',
		// VS Code lists the installed icon themes; Kingu has its own one (`vs-seti`) or none.
		schema: { type: ['null', 'string'], enum: [null, 'vs-seti'] },
		default: 'vs-seti',
		description: 'ชุดไอคอนไฟล์ของ workbench (null = ไม่แสดงไอคอนไฟล์) (Specifies the file icon theme used in the workbench or \'null\' to not show any file icons.)'
	},
	{
		id: 'workbench.productIconTheme',
		group: 'Workbench',
		type: 'json',
		// VS Code lists `Default` (the codicons) and the installed product icon themes; Kingu ships
		// kingu-old's Kingu (Lucide), its default.
		schema: { type: ['null', 'string'], enum: PRODUCT_ICON_THEMES.map((t) => t.id) },
		default: KINGU_PRODUCT_ICON_THEME_ID,
		description: 'ชุดไอคอนของ workbench: Default คือ codicon ของ VS Code, kingu-lucide คือชุด Lucide ของ Kingu (Specifies the product icon theme used.)'
	},
	{
		id: 'workbench.settings.settingsSearchTocBehavior',
		group: 'Workbench',
		type: 'string',
		default: 'filter',
		enum: ['hide', 'filter'],
		enumDescriptions: [
			'ซ่อนสารบัญขณะค้นหา (Hide the Table of Contents while searching.)',
			'แสดงเฉพาะหมวดที่มีผลลัพธ์ คลิกหมวดเพื่อดูเฉพาะผลในหมวดนั้น (Filter the Table of Contents to just categories that have matching settings. Clicking on a category will filter the results to that category.)'
		],
		description: 'สารบัญของหน้าการตั้งค่าขณะค้นหา (Controls the behavior of the Settings editor Table of Contents while searching. If this setting is being changed in the Settings editor, the setting will take effect after the search query is modified.)'
	}
];
