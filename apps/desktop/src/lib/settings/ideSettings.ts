// VS Code-derived IDE settings beyond the core set in registry.ts: text editor, files, explorer,
// search, terminal, workbench, window, git and debug. Every one here has a consumer (mappings.ts
// for the pure ones); ids, values and defaults follow VS Code so a VS Code settings.json carries over.

import { THEMES } from '../theme/themes';
import type { SettingSchema } from './registry';

const FONT_WEIGHTS = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;

/** VS Code's `files.exclude` default. */
export const DEFAULT_FILES_EXCLUDE = { '**/.git': true, '**/.svn': true, '**/.hg': true, '**/CVS': true, '**/.DS_Store': true, '**/Thumbs.db': true };

export const IDE_SETTINGS: SettingSchema[] = [
	// --- Text Editor (Monaco options, see mappings.editorOptionsFrom)
	{
		id: 'editor.fontWeight',
		group: 'Text Editor',
		type: 'string',
		default: 'normal',
		enum: FONT_WEIGHTS,
		description: 'น้ำหนักตัวอักษรของ editor (Controls the font weight.)'
	},
	{
		id: 'editor.fontLigatures',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'เปิด font ligatures เช่น => เป็นลูกศร (Enables font ligatures.)'
	},
	{
		id: 'editor.lineHeight',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 150,
		description: 'ความสูงบรรทัด 0 = คำนวณจากขนาดตัวอักษร ค่าน้อยกว่า 8 คือตัวคูณของขนาดตัวอักษร (Controls the line height; 0 computes it from the font size, values below 8 multiply the font size.)'
	},
	{
		id: 'editor.letterSpacing',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: -5,
		maximum: 20,
		description: 'ระยะห่างตัวอักษรเป็นพิกเซล (Controls the letter spacing in pixels.)'
	},
	{
		id: 'editor.wordWrapColumn',
		group: 'Text Editor',
		type: 'number',
		default: 80,
		minimum: 1,
		integer: true,
		description: 'คอลัมน์ที่ตัดบรรทัด เมื่อ editor.wordWrap เป็น wordWrapColumn หรือ bounded (Controls the wrapping column when editor.wordWrap is wordWrapColumn or bounded.)'
	},
	{
		id: 'editor.lineNumbers',
		group: 'Text Editor',
		type: 'string',
		default: 'on',
		enum: ['off', 'on', 'relative', 'interval'],
		enumDescriptions: ['ไม่แสดงเลขบรรทัด', 'แสดงเลขบรรทัด', 'แสดงระยะจากบรรทัดของเคอร์เซอร์', 'แสดงทุก 10 บรรทัด'],
		description: 'การแสดงเลขบรรทัด (Controls the display of line numbers.)'
	},
	{
		id: 'editor.rulers',
		group: 'Text Editor',
		type: 'array',
		items: 'number',
		default: [],
		description: 'เส้นแนวตั้งที่คอลัมน์ที่กำหนด เช่น [80, 120] (Render vertical rulers after a certain number of monospace characters.)'
	},
	{
		id: 'editor.renderLineHighlight',
		group: 'Text Editor',
		type: 'string',
		// Kingu's editor has always highlighted gutter + line; VS Code's default is `line`.
		default: 'all',
		enum: ['none', 'gutter', 'line', 'all'],
		description: 'การไฮไลต์บรรทัดปัจจุบัน (Controls how the editor renders the current line highlight.)'
	},
	{
		id: 'editor.renderControlCharacters',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงอักขระควบคุม (Controls whether the editor renders control characters.)'
	},
	{
		id: 'editor.minimap.side',
		group: 'Text Editor',
		type: 'string',
		default: 'right',
		enum: ['left', 'right'],
		description: 'ด้านที่แสดง minimap (Controls the side where to render the minimap.)'
	},
	{
		id: 'editor.minimap.renderCharacters',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงตัวอักษรจริงใน minimap แทนบล็อกสี (Render the actual characters on a line as opposed to color blocks.)'
	},
	{
		id: 'editor.cursorStyle',
		group: 'Text Editor',
		type: 'string',
		default: 'line',
		enum: ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'],
		description: 'รูปแบบเคอร์เซอร์ (Controls the cursor style.)'
	},
	{
		id: 'editor.cursorBlinking',
		group: 'Text Editor',
		type: 'string',
		default: 'blink',
		enum: ['blink', 'smooth', 'phase', 'expand', 'solid'],
		description: 'แอนิเมชันการกะพริบของเคอร์เซอร์ (Control the cursor animation style.)'
	},
	{
		id: 'editor.cursorSmoothCaretAnimation',
		group: 'Text Editor',
		type: 'string',
		default: 'off',
		enum: ['off', 'explicit', 'on'],
		enumDescriptions: ['ปิด', 'เฉพาะเมื่อย้ายเคอร์เซอร์เอง', 'ทุกครั้ง'],
		description: 'แอนิเมชันเคอร์เซอร์แบบลื่น (Controls whether the smooth caret animation should be enabled.)'
	},
	{
		id: 'editor.cursorSurroundingLines',
		group: 'Text Editor',
		type: 'number',
		default: 0,
		minimum: 0,
		integer: true,
		description: 'จำนวนบรรทัดที่เห็นรอบเคอร์เซอร์อย่างน้อย (Controls the minimal number of visible lines around the cursor.)'
	},
	{
		id: 'editor.bracketPairColorization.enabled',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ระบายสีวงเล็บเป็นคู่ (Controls whether bracket pair colorization is enabled.)'
	},
	{
		id: 'editor.guides.bracketPairs',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'แสดงเส้นนำของคู่วงเล็บ (Controls whether bracket pair guides are enabled.)'
	},
	{
		id: 'editor.guides.indentation',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงเส้นนำการเยื้อง (Controls whether the editor should render indent guides.)'
	},
	{
		id: 'editor.stickyScroll.enabled',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ตรึงหัวของ scope ที่ซ้อนกันไว้ด้านบนขณะเลื่อน (Shows the nested current scopes during the scroll at the top of the editor.)'
	},
	{
		id: 'editor.folding',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'พับโค้ดได้ (Controls whether the editor has code folding enabled.)'
	},
	{
		id: 'editor.glyphMargin',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงขอบสำหรับ breakpoint (Controls whether the editor should render the vertical glyph margin.)'
	},
	{
		id: 'editor.scrollBeyondLastLine',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'เลื่อนเลยบรรทัดสุดท้ายได้ (Controls whether the editor will scroll beyond the last line.)'
	},
	{
		id: 'editor.smoothScrolling',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'เลื่อนแบบมีแอนิเมชัน (Controls whether the editor will scroll using an animation.)'
	},
	{
		id: 'editor.mouseWheelZoom',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'ซูมตัวอักษรด้วย ⌘ + ล้อเมาส์ (Zoom the font of the editor when using mouse wheel and holding Cmd.)'
	},
	{
		id: 'editor.multiCursorModifier',
		group: 'Text Editor',
		type: 'string',
		default: 'alt',
		enum: ['ctrlCmd', 'alt'],
		enumDescriptions: ['⌘ บน macOS, Ctrl บนระบบอื่น', '⌥ บน macOS, Alt บนระบบอื่น'],
		description: 'ปุ่มที่ใช้เพิ่มเคอร์เซอร์ด้วยเมาส์ (The modifier to be used to add multiple cursors with the mouse.)'
	},
	{
		id: 'editor.matchBrackets',
		group: 'Text Editor',
		type: 'string',
		default: 'always',
		enum: ['always', 'near', 'never'],
		description: 'ไฮไลต์วงเล็บคู่ (Highlight matching brackets.)'
	},
	{
		id: 'editor.selectionHighlight',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ไฮไลต์ข้อความที่ตรงกับส่วนที่เลือก (Controls whether the editor should highlight matches similar to the selection.)'
	},
	{
		id: 'editor.links',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ตรวจหาลิงก์และทำให้คลิกได้ (Controls whether the editor should detect links and make them clickable.)'
	},
	{
		id: 'editor.dragAndDrop',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'ลากข้อความที่เลือกไปวางได้ (Controls whether the editor should allow moving selections via drag and drop.)'
	},
	{
		id: 'editor.emptySelectionClipboard',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'คัดลอกโดยไม่ได้เลือก = คัดลอกทั้งบรรทัด (Copying without a selection copies the current line.)'
	},
	{
		id: 'editor.hover.enabled',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดง hover (Controls whether the hover is shown.)'
	},
	{
		id: 'editor.parameterHints.enabled',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำใบ้พารามิเตอร์ขณะพิมพ์ (Enables a pop-up that shows parameter documentation as you type.)'
	},
	{
		id: 'editor.quickSuggestions',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำอัตโนมัติขณะพิมพ์ในโค้ด (ไม่รวมคอมเมนต์และสตริง) (Controls whether suggestions should automatically show up while typing.)'
	},
	{
		id: 'editor.suggestOnTriggerCharacters',
		group: 'Text Editor',
		type: 'boolean',
		default: true,
		description: 'แสดงคำแนะนำเมื่อพิมพ์อักขระกระตุ้น เช่น . (Controls whether suggestions should automatically show up when typing trigger characters.)'
	},
	{
		id: 'editor.acceptSuggestionOnEnter',
		group: 'Text Editor',
		type: 'string',
		default: 'on',
		enum: ['on', 'smart', 'off'],
		enumDescriptions: ['Enter รับคำแนะนำ', 'รับเมื่อทำให้ข้อความเปลี่ยน', 'ใช้ Tab เท่านั้น'],
		description: 'กด Enter เพื่อรับคำแนะนำ (Controls whether suggestions should be accepted on Enter, in addition to Tab.)'
	},
	{
		id: 'editor.tabCompletion',
		group: 'Text Editor',
		type: 'string',
		default: 'off',
		enum: ['on', 'off', 'onlySnippets'],
		description: 'เติมคำด้วย Tab (Enables tab completions.)'
	},
	{
		id: 'editor.wordBasedSuggestions',
		group: 'Text Editor',
		type: 'string',
		default: 'matchingDocuments',
		enum: ['off', 'currentDocument', 'matchingDocuments', 'allDocuments'],
		description: 'แนะนำคำจากเนื้อหาในเอกสาร (Controls whether completions should be computed based on words in the document.)'
	},
	{
		id: 'editor.snippetSuggestions',
		group: 'Text Editor',
		type: 'string',
		default: 'inline',
		enum: ['top', 'bottom', 'inline', 'none'],
		description: 'ตำแหน่งของ snippet ในรายการคำแนะนำ (Controls whether snippets are shown with other suggestions and how they are sorted.)'
	},
	{
		id: 'editor.autoClosingBrackets',
		group: 'Text Editor',
		type: 'string',
		default: 'languageDefined',
		enum: ['always', 'languageDefined', 'beforeWhitespace', 'never'],
		description: 'ปิดวงเล็บให้อัตโนมัติ (Controls whether the editor should automatically close brackets.)'
	},
	{
		id: 'editor.autoClosingQuotes',
		group: 'Text Editor',
		type: 'string',
		default: 'languageDefined',
		enum: ['always', 'languageDefined', 'beforeWhitespace', 'never'],
		description: 'ปิดเครื่องหมายคำพูดให้อัตโนมัติ (Controls whether the editor should automatically close quotes.)'
	},
	{
		id: 'editor.autoSurround',
		group: 'Text Editor',
		type: 'string',
		default: 'languageDefined',
		enum: ['languageDefined', 'quotes', 'brackets', 'never'],
		description: 'ครอบข้อความที่เลือกเมื่อพิมพ์วงเล็บหรือเครื่องหมายคำพูด (Controls whether the editor should automatically surround selections.)'
	},
	{
		id: 'editor.autoIndent',
		group: 'Text Editor',
		type: 'string',
		default: 'full',
		enum: ['none', 'keep', 'brackets', 'advanced', 'full'],
		description: 'ปรับการเยื้องอัตโนมัติเมื่อพิมพ์ วาง หรือย้ายบรรทัด (Controls whether the editor should automatically adjust the indentation.)'
	},
	{
		id: 'editor.linkedEditing',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'แก้แท็กเปิด/ปิด HTML พร้อมกัน (Controls whether the editor has linked editing enabled.)'
	},
	{
		id: 'editor.formatOnSave',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'จัดรูปแบบไฟล์ด้วย language server ตอนบันทึก (ไม่ทำตอนบันทึกอัตโนมัติแบบ afterDelay) (Format a file on save. Not run by auto save after a delay.)'
	},
	{
		id: 'editor.formatOnPaste',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'จัดรูปแบบข้อความที่วาง ต้องมี language server ที่จัดรูปแบบช่วงได้ (Format the pasted content; needs a range formatter.)'
	},
	{
		id: 'editor.formatOnType',
		group: 'Text Editor',
		type: 'boolean',
		default: false,
		description: 'จัดรูปแบบบรรทัดหลังพิมพ์ (Format the line after typing.)'
	},
	{
		id: 'editor.codeActionsOnSave',
		group: 'Text Editor',
		type: 'object',
		values: 'boolean|string',
		default: {},
		description:
			'code action ที่รันตอนบันทึก เช่น { "source.organizeImports": "explicit", "source.fixAll": "explicit" } — "explicit" เฉพาะบันทึกเอง, "always" รวมบันทึกอัตโนมัติด้วย (Code action kinds run on save: explicit for manual saves, always also on auto save.)'
	},
	// --- Files
	{
		id: 'files.exclude',
		group: 'Files',
		type: 'object',
		values: 'boolean',
		default: DEFAULT_FILES_EXCLUDE,
		description: 'glob ของไฟล์และโฟลเดอร์ที่ซ่อนใน Explorer, Quick Open และการค้นหา (Glob patterns for excluding files and folders from the Explorer, Quick Open and Search.)'
	},
	{
		id: 'files.associations',
		group: 'Files',
		type: 'object',
		values: 'string',
		default: {},
		description: 'จับคู่ไฟล์กับภาษา เช่น { "*.tmpl": "html" } (Configure file associations to languages.)'
	},
	{
		id: 'files.watcherExclude',
		group: 'Files',
		type: 'object',
		values: 'boolean',
		default: { '**/.git/objects/**': true, '**/.git/subtree-cache/**': true, '**/node_modules/*/**': true, '**/.hg/store/**': true },
		description: 'glob ที่ตัวเฝ้าไฟล์ไม่สนใจ ลดงานเมื่อมีไฟล์เปลี่ยนจำนวนมาก (Glob patterns of paths to exclude from file watching.)'
	},
	{
		id: 'files.eol',
		group: 'Files',
		type: 'string',
		default: 'auto',
		enum: ['\n', '\r\n', 'auto'],
		enumDescriptions: ['LF', 'CRLF', 'ตามระบบปฏิบัติการ (LF บน macOS/Linux)'],
		description: 'อักขระขึ้นบรรทัดใหม่ของไฟล์ใหม่หรือไฟล์ที่ยังไม่มีบรรทัด (The default end of line character for new files.)'
	},
	{
		id: 'files.trimTrailingWhitespace',
		group: 'Files',
		type: 'boolean',
		default: false,
		description: 'ลบช่องว่างท้ายบรรทัดตอนบันทึก (Trim trailing whitespace when saving a file.)'
	},
	{
		id: 'files.insertFinalNewline',
		group: 'Files',
		type: 'boolean',
		default: false,
		description: 'เติมบรรทัดว่างท้ายไฟล์ตอนบันทึก (Insert a final new line at the end of the file when saving it.)'
	},
	{
		id: 'files.trimFinalNewlines',
		group: 'Files',
		type: 'boolean',
		default: false,
		description: 'ลบบรรทัดว่างที่เกินท้ายไฟล์ตอนบันทึก (Trim all new lines after the final new line at the end of the file when saving it.)'
	},
	// --- Explorer
	{
		id: 'explorer.confirmDelete',
		group: 'Explorer',
		type: 'boolean',
		default: true,
		description: 'ถามก่อนย้ายไฟล์ไปถังขยะ (Controls whether the Explorer should ask for confirmation when deleting a file via the trash.)'
	},
	{
		id: 'explorer.sortOrder',
		group: 'Explorer',
		type: 'string',
		default: 'default',
		enum: ['default', 'mixed', 'filesFirst', 'type'],
		enumDescriptions: ['โฟลเดอร์ก่อน แล้วเรียงตามชื่อ', 'ไฟล์และโฟลเดอร์ปนกันตามชื่อ', 'ไฟล์ก่อนโฟลเดอร์', 'โฟลเดอร์ก่อน แล้วเรียงตามนามสกุลไฟล์'],
		description: 'การเรียงไฟล์และโฟลเดอร์ใน Explorer (Controls the property-based sorting of files and folders in the Explorer.)'
	},
	{
		id: 'explorer.autoReveal',
		group: 'Explorer',
		type: 'boolean',
		default: true,
		description: 'เลือกและแสดงไฟล์ของ editor ที่เปิดอยู่ใน Explorer อัตโนมัติ (Controls whether the Explorer should automatically reveal and select files when opening them.)'
	},
	{
		id: 'explorer.excludeGitIgnore',
		group: 'Explorer',
		type: 'boolean',
		default: false,
		description: 'ซ่อนไฟล์ที่ .gitignore ไม่สนใจออกจาก Explorer (Controls whether entries in .gitignore should be excluded from the Explorer.)'
	},
	// --- Search
	{
		id: 'search.exclude',
		group: 'Search',
		type: 'object',
		values: 'boolean',
		default: { '**/node_modules': true, '**/bower_components': true, '**/*.code-search': true },
		description: 'glob ที่ไม่ค้นหา (รวม files.exclude ด้วย) (Glob patterns for excluding files and folders in searches; inherits files.exclude.)'
	},
	{
		id: 'search.useIgnoreFiles',
		group: 'Search',
		type: 'boolean',
		default: true,
		description: 'ใช้ .gitignore และ .ignore ตอนค้นหา (Controls whether to use .gitignore and .ignore files when searching.)'
	},
	{
		id: 'search.useGlobalIgnoreFiles',
		group: 'Search',
		type: 'boolean',
		default: false,
		description: 'ใช้ไฟล์ ignore ส่วนกลางของ git (core.excludesFile) ตอนค้นหา (Controls whether to use your global gitignore file when searching.)'
	},
	{
		id: 'search.useParentIgnoreFiles',
		group: 'Search',
		type: 'boolean',
		default: false,
		description: 'ใช้ .gitignore ของโฟลเดอร์แม่ที่อยู่นอก workspace (Controls whether to use .gitignore files in parent directories.)'
	},
	{
		id: 'search.followSymlinks',
		group: 'Search',
		type: 'boolean',
		default: true,
		description: 'ตาม symlink ตอนค้นหา (Controls whether to follow symlinks while searching.)'
	},
	{
		id: 'search.smartCase',
		group: 'Search',
		type: 'boolean',
		default: false,
		description: 'ไม่สนตัวพิมพ์เล็กใหญ่ ยกเว้นคำค้นมีตัวพิมพ์ใหญ่ (Search case-insensitively if the pattern is all lowercase.)'
	},
	{
		id: 'search.maxResults',
		group: 'Search',
		type: 'number',
		default: 20000,
		minimum: 1,
		integer: true,
		description: 'จำนวนผลลัพธ์สูงสุด (Controls the maximum number of search results.)'
	},
	{
		id: 'search.searchOnType',
		group: 'Search',
		type: 'boolean',
		default: true,
		description: 'ค้นหาขณะพิมพ์ (Search all files as you type.)'
	},
	{
		id: 'search.searchOnTypeDebouncePeriod',
		group: 'Search',
		type: 'number',
		default: 300,
		minimum: 0,
		integer: true,
		description: 'หน่วงเวลา (ms) ก่อนค้นหาขณะพิมพ์ (The delay in milliseconds before searching as you type.)'
	},
	// --- Terminal (xterm options, see mappings.terminalOptionsFrom; shell settings are user-only)
	{
		id: 'terminal.integrated.fontWeight',
		group: 'Terminal',
		type: 'string',
		default: 'normal',
		enum: FONT_WEIGHTS,
		description: 'น้ำหนักตัวอักษรของ terminal (The font weight to use within the terminal for non-bold text.)'
	},
	{
		id: 'terminal.integrated.lineHeight',
		group: 'Terminal',
		type: 'number',
		default: 1,
		minimum: 1,
		maximum: 3,
		description: 'ตัวคูณความสูงบรรทัดของ terminal (Controls the line height of the terminal; multiplied by the font size.)'
	},
	{
		id: 'terminal.integrated.letterSpacing',
		group: 'Terminal',
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 20,
		integer: true,
		description: 'ระยะห่างตัวอักษรเป็นพิกเซล (Controls the letter spacing of the terminal.)'
	},
	{
		id: 'terminal.integrated.cursorStyle',
		group: 'Terminal',
		type: 'string',
		default: 'block',
		enum: ['block', 'line', 'underline'],
		description: 'รูปแบบเคอร์เซอร์ของ terminal (Controls the style of the terminal cursor when the terminal is focused.)'
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
		minimum: 1,
		maximum: 10,
		integer: true,
		description: 'ความกว้างเคอร์เซอร์เมื่อ cursorStyle เป็น line (The width of the cursor when cursorStyle is line.)'
	},
	{
		id: 'terminal.integrated.scrollback',
		group: 'Terminal',
		type: 'number',
		default: 1000,
		minimum: 0,
		maximum: 1000000,
		integer: true,
		description: 'จำนวนบรรทัดย้อนหลังที่เก็บไว้ (Controls the maximum number of lines the terminal keeps in its buffer.)'
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
		description: '⌥/Alt + คลิกเพื่อย้ายเคอร์เซอร์ของ shell (Alt + click repositions the prompt cursor.)'
	},
	{
		id: 'terminal.integrated.drawBoldTextInBrightColors',
		group: 'Terminal',
		type: 'boolean',
		default: true,
		description: 'ตัวหนาใช้สีสว่าง (Controls whether bold text in the terminal will always use the bright ANSI color variant.)'
	},
	{
		id: 'terminal.integrated.minimumContrastRatio',
		group: 'Terminal',
		type: 'number',
		default: 4.5,
		minimum: 1,
		maximum: 21,
		description: 'ปรับสีตัวอักษรให้มีความต่างของสีอย่างน้อยเท่านี้ 1 = ไม่ปรับ (Adjusts foreground colors to meet this contrast ratio; 1 disables it.)'
	},
	{
		id: 'terminal.integrated.mouseWheelScrollSensitivity',
		group: 'Terminal',
		type: 'number',
		default: 1,
		minimum: 0.1,
		maximum: 20,
		description: 'ตัวคูณความเร็วเลื่อนด้วยล้อเมาส์ (A multiplier for mouse wheel scroll deltas.)'
	},
	{
		id: 'terminal.integrated.fastScrollSensitivity',
		group: 'Terminal',
		type: 'number',
		default: 5,
		minimum: 1,
		maximum: 50,
		description: 'ตัวคูณความเร็วเลื่อนเมื่อกด ⌥/Alt (Scrolling speed multiplier when pressing Alt.)'
	},
	{
		id: 'terminal.integrated.cwd',
		group: 'Terminal',
		type: 'string',
		default: '',
		description: 'โฟลเดอร์เริ่มต้นของ terminal ใน panel (absolute หรือเทียบกับโฟลเดอร์ที่เปิด) เว้นว่าง = โฟลเดอร์ที่เปิด (The starting directory of panel terminals, absolute or relative to the folder.)'
	},
	{
		id: 'terminal.integrated.shell.osx',
		group: 'Terminal',
		type: 'string',
		default: '',
		description: 'path ของ shell บน macOS เว้นว่าง = $SHELL (The path of the shell on macOS; empty uses $SHELL.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.shell.linux',
		group: 'Terminal',
		type: 'string',
		default: '',
		description: 'path ของ shell บน Linux เว้นว่าง = $SHELL (The path of the shell on Linux; empty uses $SHELL.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.shellArgs.osx',
		group: 'Terminal',
		type: 'array',
		items: 'string',
		default: ['-l'],
		description: 'อาร์กิวเมนต์ของ shell บน macOS (The command line arguments to use on macOS.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.shellArgs.linux',
		group: 'Terminal',
		type: 'array',
		items: 'string',
		// Kingu always started a login shell; VS Code's Linux default is [].
		default: ['-l'],
		description: 'อาร์กิวเมนต์ของ shell บน Linux (The command line arguments to use on Linux.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.env.osx',
		group: 'Terminal',
		type: 'object',
		values: 'string',
		default: {},
		description: 'ตัวแปร environment เพิ่มเติมของ terminal บน macOS (Environment variables added to terminals on macOS.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.env.linux',
		group: 'Terminal',
		type: 'object',
		values: 'string',
		default: {},
		description: 'ตัวแปร environment เพิ่มเติมของ terminal บน Linux (Environment variables added to terminals on Linux.)',
		scope: 'application'
	},
	{
		id: 'terminal.integrated.confirmOnKill',
		group: 'Terminal',
		type: 'string',
		default: 'editor',
		enum: ['never', 'editor', 'panel', 'always'],
		enumDescriptions: ['ไม่ถาม', 'ถามเมื่อ terminal อยู่ในพื้นที่ editor (แท็บ terminal ของ Agents)', 'ถามเมื่อ terminal อยู่ใน panel', 'ถามทั้งใน editor และ panel'],
		description: 'ถามก่อนปิด terminal ที่มีโปรเซสทำงานอยู่ (Controls whether to confirm killing terminals when they have child processes.)'
	},
	// --- Workbench / Window
	{
		id: 'window.autoDetectColorScheme',
		group: 'Window',
		type: 'boolean',
		default: false,
		description: 'เปลี่ยนธีมตามโหมดสว่าง/มืดของระบบ ใช้ workbench.preferredDarkColorTheme / preferredLightColorTheme (Follow the OS color scheme using the preferred dark and light themes.)',
		scope: 'application'
	},
	{
		id: 'workbench.preferredDarkColorTheme',
		group: 'Workbench',
		type: 'string',
		default: 'Dark Modern',
		enum: THEMES.map((t) => t.id),
		enumDescriptions: THEMES.map((t) => t.label),
		description: 'ธีมเมื่อระบบอยู่ในโหมดมืด (ต้องเปิด window.autoDetectColorScheme) (The color theme used in dark mode when window.autoDetectColorScheme is on.)',
		scope: 'application'
	},
	{
		id: 'workbench.preferredLightColorTheme',
		group: 'Workbench',
		type: 'string',
		default: 'Light Modern',
		enum: THEMES.map((t) => t.id),
		enumDescriptions: THEMES.map((t) => t.label),
		description: 'ธีมเมื่อระบบอยู่ในโหมดสว่าง (ต้องเปิด window.autoDetectColorScheme) (The color theme used in light mode when window.autoDetectColorScheme is on.)',
		scope: 'application'
	},
	{
		id: 'workbench.startupEditor',
		group: 'Workbench',
		type: 'string',
		default: 'none',
		enum: ['none', 'readme'],
		enumDescriptions: ['ไม่เปิดอะไร', 'เปิด README ของโฟลเดอร์เมื่อไม่มี editor ที่กู้คืน'],
		description: 'editor ที่เปิดเมื่อเปิดโฟลเดอร์ (Controls which editor is shown at startup when none is restored.)'
	},
	{
		id: 'workbench.editor.showTabs',
		group: 'Workbench',
		type: 'string',
		default: 'multiple',
		enum: ['multiple', 'single', 'none'],
		enumDescriptions: ['แท็บทุก editor', 'แท็บเดียวของ editor ที่ใช้งาน', 'ไม่แสดงแท็บ'],
		description: 'การแสดงแท็บของ editor (Controls whether opened editors should show as individual tabs, one single large tab or no tabs.)'
	},
	{
		id: 'workbench.editor.tabSizing',
		group: 'Workbench',
		type: 'string',
		default: 'fit',
		enum: ['fit', 'shrink', 'fixed'],
		enumDescriptions: ['กว้างพอดีชื่อเสมอ', 'หดได้เมื่อพื้นที่ไม่พอ', 'กว้างเท่ากันทุกแท็บ'],
		description: 'ขนาดของแท็บ (Controls the size of editor tabs.)'
	},
	{
		id: 'workbench.editor.highlightModifiedTabs',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'ขีดเส้นบนแท็บที่ยังไม่บันทึก (Controls whether a top border is drawn on tabs for editors that have unsaved changes.)'
	},
	{
		id: 'workbench.editor.closeOnFileDelete',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'ปิดแท็บเมื่อไฟล์ถูกลบนอก Kingu (ถ้าไม่มีการแก้ไขค้าง) (Controls whether editors showing a file deleted elsewhere close automatically.)'
	},
	{
		id: 'workbench.statusBar.visible',
		group: 'Workbench',
		type: 'boolean',
		default: true,
		description: 'แสดง status bar (Controls the visibility of the status bar.)'
	},
	{
		id: 'workbench.tree.indent',
		group: 'Workbench',
		type: 'number',
		default: 8,
		minimum: 4,
		maximum: 40,
		integer: true,
		description: 'ระยะเยื้องของ tree (Explorer) เป็นพิกเซล (Controls tree indentation in pixels.)'
	},
	{
		id: 'workbench.list.smoothScrolling',
		group: 'Workbench',
		type: 'boolean',
		default: false,
		description: 'เลื่อนรายการและ tree แบบมีแอนิเมชัน (Controls whether lists and trees have smooth scrolling.)'
	},
	{
		id: 'window.restoreWindows',
		group: 'Window',
		type: 'string',
		default: 'one',
		enum: ['one', 'none'],
		enumDescriptions: ['เปิดโฟลเดอร์ล่าสุดและ editor ที่เปิดไว้อีกครั้ง', 'เริ่มด้วยหน้าต่างว่าง'],
		description: 'สิ่งที่เปิดคืนเมื่อเริ่ม Kingu (Controls how windows and their editors are reopened at startup.)',
		scope: 'application'
	},
	{
		id: 'window.confirmBeforeClose',
		group: 'Window',
		type: 'string',
		default: 'never',
		enum: ['never', 'always'],
		enumDescriptions: ['ไม่ถาม (ยังถามเสมอถ้ามีไฟล์ที่ยังไม่บันทึก)', 'ถามทุกครั้งก่อนปิดหน้าต่างหรือออก'],
		description: 'ถามก่อนปิดหน้าต่างหรือออกจาก Kingu (Controls whether to show a confirmation dialog before closing the window or quitting.)',
		scope: 'application'
	},
	// --- Git / Source Control
	{
		id: 'git.autofetch',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'fetch จาก remote เป็นระยะ (When set to true, commits will automatically be fetched from the default remote.)'
	},
	{
		id: 'git.autofetchPeriod',
		group: 'Git',
		type: 'number',
		default: 180,
		minimum: 10,
		integer: true,
		description: 'ระยะห่าง (วินาที) ระหว่าง fetch อัตโนมัติ (Duration in seconds between each automatic git fetch.)'
	},
	{
		id: 'git.confirmSync',
		group: 'Git',
		type: 'boolean',
		default: true,
		description: 'ถามก่อน sync (pull + push) (Confirm before synchronizing git repositories.)'
	},
	{
		id: 'git.enableSmartCommit',
		group: 'Git',
		type: 'boolean',
		default: false,
		description: 'commit การเปลี่ยนแปลงทั้งหมดเมื่อยังไม่มีไฟล์ที่ stage (Commit all changes when there are no staged changes.)'
	},
	{
		id: 'git.smartCommitChanges',
		group: 'Git',
		type: 'string',
		default: 'all',
		enum: ['all', 'tracked'],
		enumDescriptions: ['stage ทุกการเปลี่ยนแปลง', 'stage เฉพาะไฟล์ที่ git track อยู่'],
		description: 'สิ่งที่ smart commit stage ให้ (Control which changes are automatically staged by smart commit.)'
	},
	{
		id: 'git.postCommitCommand',
		group: 'Git',
		type: 'string',
		default: 'none',
		enum: ['none', 'push', 'sync'],
		description: 'คำสั่งที่รันต่อหลัง commit สำเร็จ (Run a git command after a successful commit.)'
	},
	{
		id: 'scm.countBadge',
		group: 'Git',
		type: 'string',
		default: 'all',
		enum: ['all', 'off'],
		description: 'ตัวเลขบนไอคอน Source Control (Controls the count badge on the Source Control icon on the Activity Bar.)'
	},
	// --- Debug
	{
		id: 'debug.openDebug',
		group: 'Debug',
		type: 'string',
		default: 'openOnFirstSessionStart',
		enum: ['neverOpen', 'openOnSessionStart', 'openOnFirstSessionStart'],
		description: 'เปิดมุมมอง Run and Debug เมื่อเริ่ม debug (Controls when the debug view should open.)'
	},
	{
		id: 'debug.internalConsoleOptions',
		group: 'Debug',
		type: 'string',
		default: 'openOnFirstSessionStart',
		enum: ['neverOpen', 'openOnSessionStart', 'openOnFirstSessionStart'],
		description: 'เปิด Debug Console เมื่อเริ่ม debug (Controls when the internal Debug Console should open.)'
	},
	{
		id: 'debug.saveBeforeStart',
		group: 'Debug',
		type: 'string',
		default: 'allEditorsInActiveGroup',
		enum: ['allEditorsInActiveGroup', 'none'],
		enumDescriptions: ['บันทึกไฟล์ที่ยังไม่บันทึกก่อนเริ่ม', 'ไม่บันทึก'],
		description: 'บันทึกไฟล์ก่อนเริ่ม debug (Controls what editors to save before starting a debug session.)'
	}
];
