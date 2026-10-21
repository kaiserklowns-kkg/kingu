// VS Code settings: scm.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const SCM_SETTINGS: SettingSchema[] = [
	{
		id: 'scm.countBadge',
		group: 'Source Control',
		type: 'string',
		default: 'all',
		enum: ['all', 'focused', 'off'],
		enumDescriptions: [
			'รวมการเปลี่ยนแปลงทั้งหมด (Show the sum of all Source Control Provider count badges.)',
			'นับเฉพาะ repository ที่เลือกอยู่ (Show the count badge of the focused Source Control Provider.)',
			'ไม่แสดงตัวเลข (Disable the Source Control count badge.)'
		],
		description: 'ตัวเลขบนไอคอน Source Control: รวมทุก repository, เฉพาะ repository ที่ใช้อยู่ (focused) หรือไม่แสดง (Controls the count badge on the Source Control icon on the Activity Bar.)'
	},
	{
		id: 'scm.alwaysShowActions',
		group: 'Source Control',
		type: 'boolean',
		default: false,
		description: 'แสดงปุ่มของแต่ละไฟล์ตลอดโดยไม่ต้องชี้เมาส์ (Controls whether inline actions are always visible in the Source Control view.)'
	},
	{
		id: 'scm.defaultViewMode',
		group: 'Source Control',
		type: 'string',
		default: 'list',
		enum: ['tree', 'list'],
		enumDescriptions: [
			'แสดงเป็นต้นไม้ตามโฟลเดอร์ (Show the repository changes as a tree.)',
			'แสดงเป็นรายการ (Show the repository changes as a list.)'
		],
		description: 'แสดงการเปลี่ยนแปลงเป็นต้นไม้ตามโฟลเดอร์หรือเป็นรายการ (Controls the default Source Control repository view mode.)'
	},
	{
		id: 'scm.defaultViewSortKey',
		group: 'Source Control',
		type: 'string',
		default: 'path',
		enum: ['name', 'path', 'status'],
		enumDescriptions: [
			'เรียงตามชื่อไฟล์ (Sort the repository changes by file name.)',
			'เรียงตาม path (Sort the repository changes by path.)',
			'เรียงตามสถานะ (Sort the repository changes by Source Control status.)'
		],
		description: 'การเรียงการเปลี่ยนแปลงเมื่อแสดงเป็นรายการ (Controls the default Source Control repository changes sort order when viewed as a list.)'
	},
	{
		id: 'scm.autoReveal',
		group: 'Source Control',
		type: 'boolean',
		default: true,
		description: 'เลือกไฟล์ใน Source Control ตาม editor ที่เปิดอยู่ (Controls whether the Source Control view should automatically reveal and select files when opening them.)'
	},
	{
		id: 'scm.inputFontFamily',
		group: 'Source Control',
		type: 'string',
		default: 'default',
		description: 'ฟอนต์ของช่องข้อความ commit ใช้ default สำหรับฟอนต์ของ workbench หรือ editor สำหรับฟอนต์ของ editor (Controls the font for the input message. Use `default` for the workbench user interface font family, `editor` for the `#editor.fontFamily#`\'s value, or a custom font family.)'
	},
	{
		id: 'scm.inputFontSize',
		group: 'Source Control',
		type: 'number',
		default: 13,
		description: 'ขนาดตัวอักษรของช่องข้อความ commit เป็นพิกเซล (Controls the font size for the input message in pixels.)'
	},
	{
		id: 'scm.inputMaxLineCount',
		group: 'Source Control',
		type: 'number',
		default: 10,
		minimum: 1,
		maximum: 50,
		description: 'จำนวนบรรทัดสูงสุดที่ช่องข้อความ commit ขยายได้ (Controls the maximum number of lines that the input will auto-grow to.)'
	},
	{
		id: 'scm.inputMinLineCount',
		group: 'Source Control',
		type: 'number',
		default: 1,
		minimum: 1,
		maximum: 50,
		description: 'จำนวนบรรทัดต่ำสุดของช่องข้อความ commit (Controls the minimum number of lines that the input will auto-grow from.)'
	},
	{
		id: 'scm.showActionButton',
		group: 'Source Control',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่มหลักใต้ช่องข้อความ commit (Controls whether an action button can be shown in the Source Control view.)'
	},
	{
		id: 'scm.showInputActionButton',
		group: 'Source Control',
		type: 'boolean',
		default: true,
		description: 'แสดงปุ่ม commit ในช่องข้อความ commit (Controls whether an action button can be shown in the Source Control input.)'
	},
	{
		id: 'scm.compactFolders',
		group: 'Source Control',
		type: 'boolean',
		default: true,
		description: 'รวมโฟลเดอร์ที่มีโฟลเดอร์ย่อยเดียวเป็นแถวเดียวเมื่อแสดงเป็นต้นไม้ (Controls whether the Source Control view should render folders in a compact form. In such a form, single child folders will be compressed in a combined tree element.)'
	},
	{
		id: 'scm.alwaysShowRepositories',
		group: 'Source Control',
		type: 'boolean',
		default: false,
		description: 'แสดงรายการ repository ตลอดแม้มี repository เดียว (Controls whether repositories should always be visible in the Source Control view.)'
	},
	{
		id: 'scm.repositories.sortOrder',
		group: 'Source Control',
		type: 'string',
		default: 'discovery time',
		enum: ['discovery time', 'name', 'path'],
		enumDescriptions: [
			'เรียงตามลำดับที่พบ (Repositories in the Source Control Repositories view are sorted by discovery time. Repositories in the Source Control view are sorted in the order that they were selected.)',
			'เรียงตามชื่อ repository (Repositories in the Source Control Repositories and Source Control views are sorted by repository name.)',
			'เรียงตาม path (Repositories in the Source Control Repositories and Source Control views are sorted by repository path.)'
		],
		description: 'การเรียง repository ในรายการ Repositories (Controls the sort order of the repositories in the source control repositories view.)'
	},
	{
		id: 'scm.repositories.visible',
		group: 'Source Control',
		type: 'number',
		default: 10,
		description: 'จำนวน repository ที่แสดงใน Source Control เมื่อยังไม่ได้เลือก (Controls how many repositories are visible in the Source Control Repositories section. Set to 0, to be able to manually resize the view.)'
	},
	{
		id: 'scm.repositories.selectionMode',
		group: 'Source Control',
		type: 'string',
		default: 'multiple',
		enum: ['multiple', 'single'],
		enumDescriptions: [
			'เลือกได้หลาย repository (กด Cmd/Ctrl ค้างแล้วคลิก) (Multiple repositories can be selected at the same time.)',
			'เลือกได้ทีละ repository (Only one repository can be selected at a time.)'
		],
		description: 'การเลือก repository ในรายการ Repositories (Controls the selection mode of the repositories in the Source Control Repositories view.)'
	}
];
