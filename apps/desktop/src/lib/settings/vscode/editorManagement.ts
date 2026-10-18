// VS Code settings: workbench.editor.* and editor associations. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const EDITOR_MANAGEMENT_SETTINGS: SettingSchema[] = [
	{
		id: 'workbench.editor.showTabs',
		group: 'Workbench',
		type: 'string',
		default: 'multiple',
		enum: ['multiple', 'single', 'none'],
		enumDescriptions: [
			'แท็บทุก editor (Each editor is displayed as a tab in the editor title area.)',
			'แท็บเดียวของ editor ที่ใช้งาน (The active editor is displayed as a single large tab in the editor title area.)',
			'ไม่แสดงแท็บ (The editor title area is not displayed.)'
		],
		description: 'การแสดงแท็บของ editor (Controls whether opened editors should show as individual tabs, one single large tab or if the title area should not be shown.)'
	},
	{
		id: 'workbench.editor.tabSizing',
		group: 'Workbench',
		type: 'string',
		default: 'fit',
		enum: ['fit', 'shrink', 'fixed'],
		enumDescriptions: [
			'กว้างพอดีชื่อเสมอ (Always keep tabs large enough to show the full editor label.)',
			'หดได้เมื่อพื้นที่ไม่พอ (Allow tabs to get smaller when the available space is not enough to show all tabs at once.)',
			'กว้างเท่ากันทุกแท็บ (Make all tabs the same size, while allowing them to get smaller when the available space is not enough to show all tabs at once.)'
		],
		description: 'ขนาดของแท็บ (Controls the size of editor tabs. This value is ignored when `#workbench.editor.showTabs#` is not set to `multiple`.)'
	},
	{
		id: 'workbench.editor.tabSizingFixedMinWidth',
		group: 'Workbench',
		type: 'number',
		default: 50,
		minimum: 38,
		description: 'ความกว้างต่ำสุดของแท็บเมื่อขนาดแท็บเป็น fixed (Controls the minimum width of tabs when `#workbench.editor.tabSizing#` size is set to `fixed`.)'
	},
	{
		id: 'workbench.editor.tabSizingFixedMaxWidth',
		group: 'Workbench',
		type: 'number',
		default: 160,
		minimum: 38,
		description: 'ความกว้างสูงสุดของแท็บเมื่อขนาดแท็บเป็น fixed (Controls the maximum width of tabs when `#workbench.editor.tabSizing#` size is set to `fixed`.)'
	},
	{
		id: 'workbench.editor.pinnedTabSizing',
		group: 'Workbench',
		type: 'string',
		default: 'normal',
		enum: ['normal', 'compact', 'shrink'],
		enumDescriptions: [
			'ขนาดเท่าแท็บอื่น (A pinned tab inherits the look of non pinned tabs.)',
			'แสดงเฉพาะไอคอน (A pinned tab will show in a compact form with only icon or first letter of the editor name.)',
			'หดเหลือพอเห็นชื่อบางส่วน (A pinned tab shrinks to a compact fixed size showing parts of the editor name.)'
		],
		description: 'ขนาดของแท็บที่ปักหมุดไว้ (Controls the size of pinned editor tabs. Pinned tabs are sorted to the beginning of all opened tabs and typically do not close until unpinned. This value is ignored when `#workbench.editor.showTabs#` is not set to `multiple`.)'
	},
	{
		id: 'workbench.editor.pinnedTabsOnSeparateRow',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'แสดงแท็บที่ปักหมุดในแถวแยกด้านบน (When enabled, displays pinned tabs in a separate row above all other tabs. This value is ignored when `#workbench.editor.showTabs#` is not set to `multiple`.)'
	},
	{
		id: 'workbench.editor.wrapTabs',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'ขึ้นบรรทัดใหม่ให้แท็บเมื่อเกินความกว้าง แทนการเลื่อน (Controls whether tabs should be wrapped over multiple lines when exceeding available space or whether a scrollbar should appear instead. This value is ignored when `#workbench.editor.showTabs#` is not set to \'`multiple`\'.)'
	},
	{
		id: 'workbench.editor.showIcons',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงไอคอนไฟล์บนแท็บ (Controls whether opened editors should show with an icon or not. This requires a file icon theme to be enabled as well.)'
	},
	{
		id: 'workbench.editor.showTabIndex',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'แสดงลำดับที่ของแท็บ (When enabled, will show the tab index. This value is ignored when `#workbench.editor.showTabs#` is not set to `multiple`.)'
	},
	{
		id: 'workbench.editor.highlightModifiedTabs',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'ขีดเส้นบนแท็บที่ยังไม่บันทึก (Controls whether a top border is drawn on tabs for editors that have unsaved changes. This value is ignored when `#workbench.editor.showTabs#` is not set to multiple.)'
	},
	{
		id: 'workbench.editor.labelFormat',
		group: 'Workbench',
		type: 'string',
		default: 'default',
		enum: ['default', 'short', 'medium', 'long'],
		enumDescriptions: [
			'แสดงโฟลเดอร์เฉพาะเมื่อชื่อไฟล์ซ้ำกัน (Show the name of the file. When tabs are enabled and two files have the same name in one group the distinguishing sections of each file\'s path are added. When tabs are disabled, the path relative to the workspace folder is shown if the editor is active.)',
			'แสดงชื่อโฟลเดอร์แม่ (Show the name of the file followed by its directory name.)',
			'แสดงพาธโฟลเดอร์เทียบกับ workspace (Show the name of the file followed by its path relative to the workspace folder.)',
			'แสดงพาธโฟลเดอร์เต็ม (Show the name of the file followed by its absolute path.)'
		],
		description: 'รูปแบบคำอธิบายโฟลเดอร์ต่อท้ายชื่อแท็บ (Controls the format of the label for an editor.)'
	},
	{
		id: 'workbench.editor.untitled.labelFormat',
		group: 'Workbench',
		type: 'string',
		default: 'content',
		enum: ['content', 'name'],
		enumDescriptions: [
			'ใช้บรรทัดแรกของเนื้อหา (The name of the untitled file is derived from the contents of its first line unless it has an associated file path. It will fallback to the name in case the line is empty or contains no word characters.)',
			'ใช้ชื่อ Untitled-N (The name of the untitled file is not derived from the contents of the file.)'
		],
		description: 'ชื่อแท็บของไฟล์ที่ยังไม่มีชื่อ (Controls the format of the label for an untitled editor.)'
	},
	{
		id: 'workbench.editor.customLabels.enabled',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'ใช้ชื่อแท็บที่กำหนดเองตาม pattern (Controls whether the custom workbench editor labels should be applied.)'
	},
	{
		id: 'workbench.editor.customLabels.patterns',
		group: 'Workbench',
		type: 'json',
		schema: {
			type: 'object',
			additionalProperties: { type: ['string', 'null'], minLength: 1, pattern: '.*[a-zA-Z0-9].*' }
		},
		default: {},
		description: 'ชื่อแท็บที่กำหนดเอง: glob ของพาธ ไปยังแม่แบบชื่อ เช่น ${dirname}/${filename}.${extname} (Controls the rendering of the editor label. Each __Item__ is a pattern that matches a file path. Both relative and absolute file paths are supported. The relative path must include the WORKSPACE_FOLDER (e.g `WORKSPACE_FOLDER/src/**.tsx` or `*/src/**.tsx`). Absolute patterns must start with a `/`. In case multiple patterns match, the longest matching path will be picked. Each __Value__ is the template for the rendered editor when the __Item__ matches. Variables are substituted based on the context:\n- `${dirname}`: name of the folder in which the file is located (e.g. `WORKSPACE_FOLDER/folder/file.txt -> folder`).\n- `${dirname(N)}`: name of the nth parent folder in which the file is located (e.g. `N=2: WORKSPACE_FOLDER/static/folder/file.txt -> WORKSPACE_FOLDER`). Folders can be picked from the start of the path by using negative numbers (e.g. `N=-1: WORKSPACE_FOLDER/folder/file.txt -> WORKSPACE_FOLDER`). If the __Item__ is an absolute pattern path, the first folder (`N=-1`) refers to the first folder in the absolute path, otherwise it corresponds to the workspace folder.\n- `${filename}`: name of the file without the file extension (e.g. `WORKSPACE_FOLDER/folder/file.txt -> file`).\n- `${extname}`: the file extension (e.g. `WORKSPACE_FOLDER/folder/file.txt -> txt`).\n- `${extname(N)}`: the nth extension of the file separated by \'.\' (e.g. `N=2: WORKSPACE_FOLDER/folder/file.ext1.ext2.ext3 -> ext1`). Extension can be picked from the start of the extension by using negative numbers (e.g. `N=-1: WORKSPACE_FOLDER/folder/file.ext1.ext2.ext3 -> ext2`).\n\nExample: `"**/static/**/*.html": "${filename} - ${dirname} (${extname})"` will render a file `WORKSPACE_FOLDER/static/folder/file.html` as `file - folder (html)`.)'
	},
	{
		id: 'workbench.editor.decorations.colors',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'ใช้สีของสถานะ Git กับชื่อแท็บ (Controls whether editor file decorations should use colors.)'
	},
	{
		id: 'workbench.editor.decorations.badges',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงตัวอักษรสถานะ Git บนแท็บ (Controls whether editor file decorations should use badges.)'
	},
	{
		id: 'workbench.editor.tabActionLocation',
		group: 'Workbench',
		type: 'string',
		default: 'right',
		enum: ['left', 'right'],
		enumDescriptions: ['ด้านซ้าย', 'ด้านขวา'],
		description: 'ตำแหน่งปุ่มปิดและปุ่มเลิกปักหมุดบนแท็บ (Controls the position of the editor\'s tabs action buttons (close, unpin). This value is ignored when `#workbench.editor.showTabs#` is not set to `multiple`.)'
	},
	{
		id: 'workbench.editor.tabActionCloseVisibility',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่มปิดบนแท็บ (Controls the visibility of the tab close action button.)'
	},
	{
		id: 'workbench.editor.tabActionUnpinVisibility',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่มเลิกปักหมุดบนแท็บที่ปักหมุด (Controls the visibility of the tab unpin action button.)'
	},
	{
		id: 'workbench.editor.tabActionReserveSpace',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'เว้นที่ให้ปุ่มบนแท็บเสมอ แม้ปุ่มจะซ่อนอยู่ (Controls whether Modern UI editor tabs always reserve space for tab action buttons. When disabled, clean tabs stay compact; tabs with persistent dirty or pinned indicators reserve space regardless.)'
	},
	{
		id: 'workbench.editor.titleScrollbarSizing',
		group: 'Workbench',
		type: 'string',
		default: 'default',
		enum: ['default', 'large'],
		enumDescriptions: [
			'ขนาดปกติ (The default size.)',
			'ขนาดใหญ่ จับง่ายขึ้น (Increases the size, so it can be grabbed more easily with the mouse.)'
		],
		description: 'ความหนาของแถบเลื่อนของแถบแท็บ (Controls the height of the scrollbars used for tabs and breadcrumbs in the editor title area.)'
	},
	{
		id: 'workbench.editor.titleScrollbarVisibility',
		group: 'Workbench',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'visible', 'hidden'],
		enumDescriptions: [
			'แสดงเมื่อชี้เมาส์ (The horizontal scrollbar will be visible only when necessary.)',
			'แสดงเสมอ (The horizontal scrollbar will always be visible.)',
			'ไม่แสดง (The horizontal scrollbar will always be hidden.)'
		],
		description: 'การแสดงแถบเลื่อนของแถบแท็บ (Controls the visibility of the scrollbars used for tabs and breadcrumbs in the editor title area.)'
	},
	{
		id: 'workbench.editor.doubleClickTabToToggleEditorGroupSizes',
		group: 'Workbench',
		type: 'string',
		default: 'expand',
		enum: ['maximize', 'expand', 'off'],
		enumDescriptions: [
			'ขยายกลุ่มเต็มพื้นที่และซ่อนกลุ่มอื่น (All other editor groups are hidden and the current editor group is maximized to take up the entire editor area.)',
			'ขยายกลุ่มให้ใหญ่ที่สุดโดยไม่ซ่อนกลุ่มอื่น (The editor group takes as much space as possible by making all other editor groups as small as possible.)',
			'ไม่ทำอะไร (No editor group is resized when double clicking on a tab.)'
		],
		description: 'ดับเบิลคลิกแท็บเพื่อขยายกลุ่ม editor (Controls how the editor group is resized when double clicking on a tab. This value is ignored when `#workbench.editor.showTabs#` is not set to `multiple`.)'
	},
	{
		id: 'workbench.editor.scrollToSwitchTabs',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'หมุนล้อเมาส์บนแถบแท็บเพื่อสลับแท็บ กด Shift เพื่อสลับพฤติกรรมชั่วคราว (Controls whether scrolling over tabs will open them or not. By default tabs will only reveal upon scrolling, but not open. You can press and hold the Shift-key while scrolling to change this behavior for that duration. This value is ignored when `#workbench.editor.showTabs#` is not set to `multiple`.)'
	},
	{
		id: 'workbench.editor.mouseBackForwardToNavigate',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'ใช้ปุ่มเมาส์ที่ 4 และ 5 เพื่อย้อนกลับและไปข้างหน้า (Enables the use of mouse buttons four and five for commands \'Go Back\' and \'Go Forward\'.)'
	},
	{
		id: 'workbench.editor.navigationScope',
		group: 'Workbench',
		type: 'string',
		default: 'default',
		enum: ['default', 'editorGroup', 'editor'],
		enumDescriptions: [
			'ทุก editor ทุกกลุ่ม (Navigate across all opened editors and editor groups.)',
			'เฉพาะกลุ่ม editor ที่ใช้งาน (Navigate only in editors of the active editor group.)',
			'เฉพาะ editor ที่ใช้งาน (Navigate only in the active editor.)'
		],
		description: 'ขอบเขตของประวัติ Go Back และ Go Forward (Controls the scope of history navigation in editors for commands such as \'Go Back\' and \'Go Forward\'.)'
	},
	{
		id: 'workbench.editor.preventPinnedEditorClose',
		group: 'Workbench',
		type: 'string',
		default: 'keyboardAndMouse',
		enum: ['keyboardAndMouse', 'keyboard', 'mouse', 'never'],
		enumDescriptions: [
			'ป้องกันทั้งคีย์บอร์ดและคลิกกลาง (Always prevent closing the pinned editor when using mouse middle click or keyboard.)',
			'ป้องกันเฉพาะคีย์บอร์ด (Prevent closing the pinned editor when using the keyboard.)',
			'ป้องกันเฉพาะคลิกกลาง (Prevent closing the pinned editor when using mouse middle click.)',
			'ไม่ป้องกัน (Never prevent closing a pinned editor.)'
		],
		description: 'ป้องกันไม่ให้ปิดแท็บที่ปักหมุดด้วยคีย์บอร์ดหรือคลิกกลาง (Controls whether pinned editors should close when keyboard or middle mouse click is used for closing.)'
	},
	{
		id: 'workbench.editor.openPositioning',
		group: 'Workbench',
		type: 'string',
		default: 'right',
		enum: ['left', 'right', 'first', 'last'],
		enumDescriptions: ['ทางซ้ายของแท็บที่ใช้งาน', 'ทางขวาของแท็บที่ใช้งาน', 'แท็บแรก', 'แท็บสุดท้าย'],
		description: 'ตำแหน่งของแท็บที่เปิดใหม่ (Controls where editors open. Select `left` or `right` to open editors to the left or right of the currently active one. Select `first` or `last` to open editors independently from the currently active one.)'
	},
	{
		id: 'workbench.editor.openSideBySideDirection',
		group: 'Workbench',
		type: 'string',
		default: 'right',
		enum: ['right', 'down'],
		enumDescriptions: ['ทางขวา', 'ด้านล่าง'],
		description: 'ทิศทางที่เปิด editor ไว้ข้างกัน (Controls the default direction of editors that are opened side by side (for example, from the Explorer). By default, editors will open on the right hand side of the currently active one. If changed to `down`, the editors will open below the currently active one. This also impacts the split editor action in the editor toolbar.)'
	},
	{
		id: 'workbench.editor.splitSizing',
		group: 'Workbench',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'distribute', 'split'],
		enumDescriptions: [
			'แบ่งครึ่งกลุ่มเดิม เว้นแต่ทุกกลุ่มเท่ากันอยู่แล้วจึงเฉลี่ยทั้งหมด (Splits the active editor group to equal parts, unless all editor groups are already in equal parts. In that case, splits all the editor groups to equal parts.)',
			'เฉลี่ยทุกกลุ่มให้เท่ากัน (Splits all the editor groups to equal parts.)',
			'แบ่งครึ่งกลุ่มที่ใช้งาน (Splits the active editor group to equal parts.)'
		],
		description: 'ขนาดของกลุ่ม editor เมื่อแบ่งหน้าจอ (Controls the size of editor groups when splitting them.)'
	},
	{
		id: 'workbench.editor.closeEmptyGroups',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'ปิดกลุ่ม editor อัตโนมัติเมื่อแท็บสุดท้ายถูกปิด (Controls the behavior of empty editor groups when the last tab in the group is closed. When enabled, empty groups will automatically close. When disabled, empty groups will remain part of the grid.)'
	},
	{
		id: 'workbench.editor.focusRecentEditorAfterClose',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'เมื่อปิดแท็บ ให้ไปที่แท็บที่ใช้ล่าสุด แทนแท็บถัดไป (Controls whether editors are closed in most recently used order or from left to right.)'
	},
	{
		id: 'workbench.editor.revealIfOpen',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'ถ้าไฟล์เปิดอยู่ในกลุ่มอื่นแล้ว ให้ไปที่กลุ่มนั้นแทนการเปิดซ้ำ (Controls whether an editor is revealed in any of the visible groups if opened. If disabled, an editor will prefer to open in the currently active editor group. If enabled, an already opened editor will be revealed instead of opened again in the currently active editor group. Note that there are some cases where this setting is ignored, such as when forcing an editor to open in a specific group or to the side of the currently active group.)'
	},
	{
		id: 'workbench.editor.limit.enabled',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'จำกัดจำนวน editor ที่เปิด โดยปิดแท็บที่ใช้น้อยที่สุดก่อน (Controls if the number of opened editors should be limited or not. When enabled, less recently used editors will close to make space for newly opening editors.)'
	},
	{
		id: 'workbench.editor.limit.value',
		group: 'Workbench',
		type: 'number',
		default: 10,
		description: 'จำนวน editor สูงสุดที่เปิดได้ (Controls the maximum number of opened editors. Use the `#workbench.editor.limit.perEditorGroup#` setting to control this limit per editor group or across all groups.)'
	},
	{
		id: 'workbench.editor.limit.perEditorGroup',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'นับขีดจำกัดแยกต่อกลุ่ม editor (Controls if the limit of maximum opened editors should apply per editor group or across all editor groups.)'
	},
	{
		id: 'workbench.editor.limit.excludeDirty',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'ไม่นับ editor ที่ยังไม่บันทึกในขีดจำกัด (Controls if the maximum number of opened editors should exclude dirty editors for counting towards the configured limit.)'
	},
	{
		id: 'workbench.editor.restoreEditors',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'เปิดแท็บเดิมคืนเมื่อเปิดโฟลเดอร์อีกครั้ง (Controls whether editors are restored on startup. When disabled, only dirty editors will be restored from the previous session.)'
	},
	{
		id: 'workbench.editor.restoreViewState',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'จำตำแหน่งเลื่อนและเคอร์เซอร์ของไฟล์ที่ปิดไป เมื่อเปิดใหม่ (Restores the last editor view state (such as scroll position) when re-opening editors after they have been closed. Editor view state is stored per editor group and discarded when a group closes. Use the `#workbench.editor.sharedViewState#` setting to use the last known view state across all editor groups in case no previous view state was found for a editor group.)'
	},
	{
		id: 'workbench.editor.sharedViewState',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'ใช้ตำแหน่งล่าสุดจากกลุ่มอื่น เมื่อกลุ่มนี้ไม่เคยเปิดไฟล์นั้น (Preserves the most recent editor view state (such as scroll position) across all editor groups and restores that if no specific editor view state is found for the editor group.)'
	},
	{
		id: 'workbench.editor.enablePreviewFromQuickOpen',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'เปิดไฟล์จาก Quick Open เป็นแท็บพรีวิว (Controls whether editors opened from Quick Open show as preview editors. Preview editors do not stay open, and are reused until explicitly set to be kept open (via double-click or editing). When enabled, hold Ctrl before selection to open an editor as a non-preview. This value is ignored when `#workbench.editor.showTabs#` is not set to `multiple`.)'
	},
	{
		id: 'workbench.editor.enablePreviewFromCodeNavigation',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'ให้แท็บพรีวิวยังเป็นพรีวิวเมื่อกระโดดไปยังโค้ดอื่นจากแท็บนั้น (Controls whether editors remain in preview when a code navigation is started from them. Preview editors do not stay open, and are reused until explicitly set to be kept open (via double-click or editing). This value is ignored when `#workbench.editor.showTabs#` is not set to `multiple`.)'
	},
	{
		id: 'workbench.editor.empty.hint',
		group: 'Workbench',
		type: 'string',
		default: 'text',
		enum: ['text', 'hidden'],
		enumDescriptions: ['แสดงคำแนะนำ', 'ซ่อน'],
		description: 'แสดงคำแนะนำในไฟล์ใหม่ที่ยังว่าง (Controls if the empty editor text hint should be visible in the editor.)'
	},
	{
		id: 'workbench.editor.closeOnFileDelete',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'ปิดแท็บเมื่อไฟล์ถูกลบนอก Kingu (Controls whether editors showing a file that was opened during the session should close automatically when getting deleted or renamed by some other process. Disabling this will keep the editor open  on such an event. Note that deleting from within the application will always close the editor and that editors with unsaved changes will never close to preserve your data.)'
	},
	{
		id: 'workbench.editorLargeFileConfirmation',
		group: 'Workbench',
		type: 'number',
		default: 10,
		minimum: 1,
		description: 'ขนาดไฟล์เป็น MB ที่ต้องยืนยันก่อนเปิดใน editor (Controls the minimum size of a file in MB before asking for confirmation when opening in the editor. Note that this setting may not apply to all editor types and environments.)'
	}
];
