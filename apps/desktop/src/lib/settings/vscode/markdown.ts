// VS Code settings: markdown.* (the built-in Markdown Language Features and Markdown Math
// extensions). Key, type, enum and default are VS Code's; the Thai text is Kingu's. Read by
// lib/markdown (language features) and the Markdown preview.
import type { SettingSchema } from '../registry';

const LEVEL = ['ignore', 'warning', 'error'] as const;
const LEVEL_TH = ['ไม่ตรวจ', 'คำเตือน', 'ข้อผิดพลาด'];
const SMART = ['always', 'smart', 'never'] as const;
const SMART_TH = ['สร้างลิงก์ Markdown เสมอ', 'สร้างลิงก์ เว้นแต่อยู่ใน code block', 'ไม่สร้างลิงก์'];
const COPY = ['mediaFiles', 'never'] as const;
const COPY_TH = ['คัดลอกไฟล์สื่อ (รูป วิดีโอ เสียง)', 'ไม่คัดลอก'];

export const MARKDOWN_SETTINGS: SettingSchema[] = [
	// --- Language features ---------------------------------------------------------------------
	{
		id: 'markdown.suggest.paths.enabled',
		group: 'Markdown',
		type: 'boolean',
		default: true,
		description: 'แนะนำ path ขณะเขียนลิงก์ในไฟล์ Markdown (Controls whether path suggestions are shown while writing links in Markdown files.)'
	},
	{
		id: 'markdown.suggest.paths.includeWorkspaceHeaderCompletions',
		group: 'Markdown',
		type: 'string',
		default: 'onDoubleHash',
		enum: ['never', 'onDoubleHash', 'onSingleOrDoubleHash'],
		enumDescriptions: ['ไม่แนะนำหัวข้อจากไฟล์อื่น', 'แนะนำหลังพิมพ์ `##` ใน path', 'แนะนำหลังพิมพ์ `#` หรือ `##` ใน path'],
		description: 'แนะนำหัวข้อของไฟล์ Markdown อื่นใน workspace โดยแทรก path เต็มถึงหัวข้อนั้น (Suggest headers in other Markdown files of the workspace; accepting one inserts the full path to the header.)'
	},
	{
		id: 'markdown.preferredMdPathExtensionStyle',
		group: 'Markdown',
		type: 'string',
		default: 'auto',
		enum: ['auto', 'includeExtension', 'removeExtension'],
		enumDescriptions: ['path เดิมคงรูปแบบเดิม path ใหม่ใส่นามสกุล', 'ใส่นามสกุล เช่น `file.md`', 'ไม่ใส่นามสกุล เช่น `file`'],
		description: 'ใส่นามสกุลไฟล์ (เช่น `.md`) ในลิงก์ที่ Kingu สร้างหรือไม่ (Whether file extensions such as `.md` are added to links to Markdown files that tooling creates.)'
	},
	{
		id: 'markdown.links.openLocation',
		group: 'Markdown',
		type: 'string',
		default: 'currentGroup',
		enum: ['currentGroup', 'beside'],
		enumDescriptions: ['เปิดในกลุ่ม editor ปัจจุบัน', 'เปิดข้าง editor ปัจจุบัน'],
		description: 'ตำแหน่งที่เปิดลิงก์จากไฟล์ Markdown (Controls where links in Markdown files are opened.)'
	},
	{
		id: 'markdown.validate.enabled',
		group: 'Markdown',
		type: 'boolean',
		default: false,
		description: 'ตรวจลิงก์ในไฟล์ Markdown และรายงานใน Problems (Controls whether error reporting is enabled in Markdown files.)'
	},
	{
		id: 'markdown.validate.referenceLinks.enabled',
		group: 'Markdown',
		type: 'string',
		default: 'warning',
		enum: LEVEL,
		enumDescriptions: LEVEL_TH,
		description: 'ตรวจ reference link เช่น `[link][ref]` (Validate reference links such as `[link][ref]`. Requires `#markdown.validate.enabled#`.)'
	},
	{
		id: 'markdown.validate.fragmentLinks.enabled',
		group: 'Markdown',
		type: 'string',
		default: 'warning',
		enum: LEVEL,
		enumDescriptions: LEVEL_TH,
		description: 'ตรวจลิงก์ไปหัวข้อในไฟล์เดียวกัน เช่น `[link](#header)` (Validate links to headers of the same file. Requires `#markdown.validate.enabled#`.)'
	},
	{
		id: 'markdown.validate.fileLinks.enabled',
		group: 'Markdown',
		type: 'string',
		default: 'warning',
		enum: LEVEL,
		enumDescriptions: LEVEL_TH,
		description: 'ตรวจว่าไฟล์ที่ลิงก์ถึงมีอยู่จริง (Validate that linked files exist, for example `[link](/path/to/file.md)`. Requires `#markdown.validate.enabled#`.)'
	},
	{
		id: 'markdown.validate.fileLinks.markdownFragmentLinks',
		group: 'Markdown',
		type: 'string',
		default: 'inherit',
		enum: ['inherit', ...LEVEL],
		enumDescriptions: ['ใช้ค่าของ `#markdown.validate.fragmentLinks.enabled#`', ...LEVEL_TH],
		description: 'ตรวจส่วนหัวข้อของลิงก์ไปไฟล์อื่น เช่น `[link](file.md#header)` (Validate the header part of links to other Markdown files.)'
	},
	{
		id: 'markdown.validate.ignoredLinks',
		group: 'Markdown',
		type: 'array',
		items: 'string',
		default: [],
		description: 'ลิงก์หรือ glob ที่ไม่ต้องตรวจ เช่น `/about` หรือ `/assets/**/*.svg` (Links or globs that are not validated.)'
	},
	{
		id: 'markdown.validate.unusedLinkDefinitions.enabled',
		group: 'Markdown',
		type: 'string',
		default: 'hint',
		enum: ['ignore', 'hint', 'warning', 'error'],
		enumDescriptions: ['ไม่ตรวจ', 'คำแนะนำ', 'คำเตือน', 'ข้อผิดพลาด'],
		description: 'ตรวจ link definition ที่ไม่มีใครใช้ในไฟล์ (Validate link definitions that are unused in the current file.)'
	},
	{
		id: 'markdown.validate.duplicateLinkDefinitions.enabled',
		group: 'Markdown',
		type: 'string',
		default: 'warning',
		enum: LEVEL,
		enumDescriptions: LEVEL_TH,
		description: 'ตรวจ link definition ที่ซ้ำกันในไฟล์ (Validate duplicated link definitions in the current file.)'
	},
	{
		id: 'markdown.updateLinksOnFileMove.enabled',
		group: 'Markdown',
		type: 'string',
		default: 'never',
		enum: ['prompt', 'always', 'never'],
		enumDescriptions: ['ถามทุกครั้งที่ย้ายไฟล์', 'อัปเดตลิงก์อัตโนมัติเสมอ', 'ไม่อัปเดตและไม่ถาม'],
		description: 'อัปเดตลิงก์ในไฟล์ Markdown เมื่อเปลี่ยนชื่อหรือย้ายไฟล์ใน workspace (Update links in Markdown files when a file is renamed or moved in the workspace.)'
	},
	{
		id: 'markdown.updateLinksOnFileMove.include',
		group: 'Markdown',
		type: 'array',
		items: 'string',
		default: ['**/*.{md,mkd,mdwn,mdown,markdown,markdn,mdtxt,mdtext,workbook}', '**/*.{jpg,jpe,jpeg,png,bmp,gif,ico,webp,avif,tiff,svg,mp4}'],
		description: 'glob ของไฟล์ที่การย้ายแล้วจะอัปเดตลิงก์ (Globs of the files whose move triggers link updates.)'
	},
	{
		id: 'markdown.updateLinksOnFileMove.enableForDirectories',
		group: 'Markdown',
		type: 'boolean',
		default: true,
		description: 'อัปเดตลิงก์เมื่อย้ายหรือเปลี่ยนชื่อโฟลเดอร์ด้วย (Also update links when a folder is moved or renamed.)'
	},
	{
		id: 'markdown.editor.drop.enabled',
		group: 'Markdown',
		type: 'string',
		default: 'smart',
		enum: SMART,
		enumDescriptions: SMART_TH,
		description: 'ลากไฟล์มาวางใน editor Markdown (กด Shift ค้าง) แล้วแทรกเป็นลิงก์ (Insert Markdown links when files are dropped into a Markdown editor while holding Shift.)'
	},
	{
		id: 'markdown.editor.drop.copyIntoWorkspace',
		group: 'Markdown',
		type: 'string',
		default: 'mediaFiles',
		enum: COPY,
		enumDescriptions: COPY_TH,
		description: 'คัดลอกไฟล์นอก workspace ที่ลากมาวางเข้ามาไว้ข้างไฟล์ Markdown (Copy files from outside the workspace that are dropped into a Markdown editor into the workspace.)'
	},
	{
		id: 'markdown.editor.filePaste.enabled',
		group: 'Markdown',
		type: 'string',
		default: 'smart',
		enum: SMART,
		enumDescriptions: SMART_TH,
		description: 'วางไฟล์ใน editor Markdown แล้วแทรกเป็นลิงก์ (Insert Markdown links when files are pasted into a Markdown editor.)'
	},
	{
		id: 'markdown.editor.filePaste.copyIntoWorkspace',
		group: 'Markdown',
		type: 'string',
		default: 'mediaFiles',
		enum: COPY,
		enumDescriptions: COPY_TH,
		description: 'คัดลอกไฟล์นอก workspace ที่วางเข้ามาไว้ข้างไฟล์ Markdown (Copy files from outside the workspace that are pasted into a Markdown editor into the workspace.)'
	},
	{
		id: 'markdown.editor.pasteUrlAsFormattedLink.enabled',
		group: 'Markdown',
		type: 'string',
		default: 'smartWithSelection',
		enum: ['always', 'smart', 'smartWithSelection', 'never'],
		enumDescriptions: ['สร้างลิงก์ Markdown เสมอ', 'สร้างลิงก์ เว้นแต่อยู่ใน code block', 'สร้างลิงก์เมื่อมีข้อความที่เลือกไว้ และไม่อยู่ใน code block', 'ไม่สร้างลิงก์'],
		description: 'วาง URL ใน editor Markdown แล้วสร้างเป็นลิงก์ (Create Markdown links when URLs are pasted into a Markdown editor.)'
	},
	// --- Preview -------------------------------------------------------------------------------
	{
		id: 'markdown.preview.breaks',
		group: 'Markdown',
		type: 'boolean',
		default: false,
		description: 'ขึ้นบรรทัดใหม่ในย่อหน้าของ preview เป็น `<br>` (Render newlines inside paragraphs of the Markdown preview as `<br>`.)'
	},
	{
		id: 'markdown.preview.linkify',
		group: 'Markdown',
		type: 'boolean',
		default: true,
		description: 'แปลงข้อความที่หน้าตาเหมือน URL เป็นลิงก์ใน preview (Convert URL-like text to links in the Markdown preview.)'
	},
	{
		id: 'markdown.preview.typographer',
		group: 'Markdown',
		type: 'boolean',
		default: false,
		description: 'แทนที่เครื่องหมายคำพูดและสัญลักษณ์ให้สวยใน preview (Enable language-neutral replacements and quote beautification in the Markdown preview.)'
	},
	{
		id: 'markdown.preview.fontFamily',
		group: 'Markdown',
		type: 'string',
		default: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif",
		description: 'ฟอนต์ของ preview (Controls the font family used in the Markdown preview.)'
	},
	{
		id: 'markdown.preview.fontSize',
		group: 'Markdown',
		type: 'number',
		default: 14,
		description: 'ขนาดฟอนต์ (px) ของ preview (Controls the font size in pixels used in the Markdown preview.)'
	},
	{
		id: 'markdown.preview.lineHeight',
		group: 'Markdown',
		type: 'number',
		default: 1.6,
		description: 'ระยะบรรทัดของ preview เทียบกับขนาดฟอนต์ (Controls the line height used in the Markdown preview, relative to the font size.)'
	},
	{
		id: 'markdown.preview.markEditorSelection',
		group: 'Markdown',
		type: 'boolean',
		default: false,
		description: 'ทำเครื่องหมายบรรทัดที่เลือกใน editor บน preview (Mark the current editor selection in the Markdown preview.)'
	},
	{
		id: 'markdown.preview.scrollEditorWithPreview',
		group: 'Markdown',
		type: 'boolean',
		default: true,
		description: 'เลื่อน editor ตามเมื่อเลื่อน preview (When a Markdown preview is scrolled, update the view of the editor.)'
	},
	{
		id: 'markdown.preview.scrollPreviewWithEditor',
		group: 'Markdown',
		type: 'boolean',
		default: true,
		description: 'เลื่อน preview ตามเมื่อเลื่อน editor (When a Markdown editor is scrolled, update the view of the preview.)'
	},
	{
		id: 'markdown.preview.doubleClickToSwitchToEditor',
		group: 'Markdown',
		type: 'boolean',
		default: false,
		description: 'ดับเบิลคลิกใน preview เพื่อไปยังบรรทัดนั้นใน editor (Double-click in the Markdown preview to switch to the editor.)'
	},
	{
		id: 'markdown.preview.openMarkdownLinks',
		group: 'Markdown',
		type: 'string',
		default: 'inPreview',
		enum: ['inPreview', 'inEditor'],
		enumDescriptions: ['เปิดใน preview', 'เปิดใน editor'],
		description: 'วิธีเปิดลิงก์ไปไฟล์ Markdown อื่นจาก preview (Controls how links to other Markdown files in the Markdown preview are opened.)'
	},
	{
		id: 'markdown.math.enabled',
		group: 'Markdown',
		type: 'boolean',
		default: true,
		description: 'แสดงสูตรคณิตศาสตร์ ($…$ และ $$…$$) ใน preview (Enable rendering math in the Markdown preview.)'
	}
];
