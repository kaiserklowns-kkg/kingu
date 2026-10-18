// VS Code settings: files.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const FILES_SETTINGS: SettingSchema[] = [
	{
		id: 'files.exclude',
		group: 'Files',
		type: 'object',
		values: 'boolean|when',
		default: {
			'**/.git': true,
			'**/.svn': true,
			'**/.hg': true,
			'**/.jj': true,
			'**/.DS_Store': true,
			'**/Thumbs.db': true
		},
		description: 'glob ของไฟล์และโฟลเดอร์ที่ซ่อนใน Explorer, Quick Open และการค้นหา (Configure [glob patterns](https://aka.ms/vscode-glob-patterns) for excluding files and folders. For example, the File Explorer decides which files and folders to show or hide based on this setting. Refer to the `#search.exclude#` setting to define search-specific excludes. Refer to the `#explorer.excludeGitIgnore#` setting for ignoring files based on your `.gitignore`.)'
	},
	{
		id: 'files.associations',
		group: 'Files',
		type: 'object',
		values: 'string',
		default: {},
		description: 'จับคู่ไฟล์กับภาษา เช่น { "*.tmpl": "html" } (Configure [glob patterns](https://aka.ms/vscode-glob-patterns) of file associations to languages (for example `"*.extension": "html"`). Patterns will match on the absolute path of a file if they contain a path separator and will match on the name of the file otherwise. These have precedence over the default associations of the languages installed.)'
	},
	{
		id: 'files.watcherExclude',
		group: 'Files',
		type: 'object',
		values: 'boolean',
		default: {
			'.git/objects/**': true,
			'.git/subtree-cache/**': true,
			'.hg/store/**': true,
			'*/.git/objects/**': true,
			'*/.git/subtree-cache/**': true,
			'*/.hg/store/**': true
		},
		description: 'glob ที่ตัวเฝ้าไฟล์ไม่สนใจ ลดงานเมื่อมีไฟล์เปลี่ยนจำนวนมาก (Configure paths or [glob patterns](https://aka.ms/vscode-glob-patterns) to exclude from file watching. Paths can either be relative to the watched folder or absolute. Glob patterns are matched relative from the watched folder. When you experience the file watcher process consuming a lot of CPU, make sure to exclude large folders that are of less interest (such as build output folders).)'
	},
	{
		id: 'files.eol',
		group: 'Files',
		type: 'string',
		default: 'auto',
		enum: ['\n', '\r\n', 'auto'],
		enumDescriptions: [
			'LF (LF)',
			'CRLF (CRLF)',
			'ตามระบบปฏิบัติการ (Uses operating system specific end of line character.)'
		],
		description: 'อักขระขึ้นบรรทัดใหม่ของไฟล์ใหม่หรือไฟล์ที่ยังไม่มีบรรทัด (The default end of line character.)'
	},
	{
		id: 'files.autoGuessEncoding',
		group: 'Files',
		type: 'boolean',
		default: false,
		description: 'เดา encoding ของไฟล์จากเนื้อหาตอนเปิด (When enabled, the editor will attempt to guess the character set encoding when opening files. This setting can also be configured per language. Note, this setting is not respected by text search. Only `#files.encoding#` is respected.)'
	},
	{
		id: 'files.hotExit',
		group: 'Files',
		type: 'string',
		default: 'onExit',
		enum: ['off', 'onExit', 'onExitAndWindowClose'],
		enumDescriptions: [
			'ปิด hot exit: ถามให้บันทึกทุกครั้งที่ออก (Disable hot exit. A prompt will show when attempting to close a window with editors that have unsaved changes.)',
			'ออกจากแอปแล้วจำไฟล์ที่ยังไม่บันทึกไว้เปิดคืนครั้งหน้า (Hot exit will be triggered when the last window is closed on Windows/Linux or when the `workbench.action.quit` command is triggered (command palette, keybinding, menu). All windows without folders opened will be restored upon next launch. A list of previously opened windows with unsaved files can be accessed via `File > Open Recent > More...`)',
			'เหมือน onExit และรวมการปิดหน้าต่างหรือเปลี่ยนโฟลเดอร์ด้วย (Hot exit will be triggered when the last window is closed on Windows/Linux or when the `workbench.action.quit` command is triggered (command palette, keybinding, menu), and also for any window with a folder opened regardless of whether it\'s the last window. All windows without folders opened will be restored upon next launch. A list of previously opened windows with unsaved files can be accessed via `File > Open Recent > More...`)'
		],
		description: 'จำไฟล์ที่ยังไม่บันทึกไว้ระหว่างการเปิดปิดแอป ([Hot Exit](https://aka.ms/vscode-hot-exit) controls whether unsaved files are remembered between sessions, allowing the save prompt when exiting the editor to be skipped.)',
		scope: 'application'
	},
	{
		id: 'files.trimTrailingWhitespace',
		group: 'Files',
		type: 'boolean',
		default: false,
		description: 'ลบช่องว่างท้ายบรรทัดตอนบันทึก (When enabled, will trim trailing whitespace when saving a file.)'
	},
	{
		id: 'files.insertFinalNewline',
		group: 'Files',
		type: 'boolean',
		default: false,
		description: 'เติมบรรทัดว่างท้ายไฟล์ตอนบันทึก (When enabled, insert a final new line at the end of the file when saving it.)'
	},
	{
		id: 'files.trimFinalNewlines',
		group: 'Files',
		type: 'boolean',
		default: false,
		description: 'ลบบรรทัดว่างที่เกินท้ายไฟล์ตอนบันทึก (When enabled, will trim all new lines after the final new line at the end of the file when saving it.)'
	},
	{
		id: 'files.enableTrash',
		group: 'Files',
		type: 'boolean',
		default: true,
		description: 'ย้ายไฟล์ที่ลบไปถังขยะ ถ้าปิดจะลบถาวร (Moves files/folders to the OS trash (recycle bin on Windows) when deleting. Disabling this will delete files/folders permanently.)'
	},
	{
		id: 'files.trimTrailingWhitespaceInRegexAndStrings',
		group: 'Files',
		type: 'boolean',
		default: true,
		description: 'ลบช่องว่างท้ายบรรทัดในสตริงหลายบรรทัดและ regex ด้วย (When enabled, trailing whitespace will be removed from multiline strings and regexes on save or when executing \'editor.action.trimTrailingWhitespace\'. This can cause whitespace to not be trimmed from lines when there isn\'t up-to-date token information.)'
	},
	{
		id: 'files.autoSaveWorkspaceFilesOnly',
		group: 'Files',
		type: 'boolean',
		default: false,
		description: 'บันทึกอัตโนมัติเฉพาะไฟล์ในโฟลเดอร์ที่เปิดอยู่ (When enabled, will limit [auto save](https://code.visualstudio.com/docs/editor/codebasics#_save-auto-save) of editors to files that are inside the opened workspace. Only applies when `#files.autoSave#` is enabled.)'
	},
	{
		id: 'files.autoSaveWhenNoErrors',
		group: 'Files',
		type: 'boolean',
		default: false,
		description: 'บันทึกอัตโนมัติเฉพาะไฟล์ที่ไม่มี error (When enabled, will limit [auto save](https://code.visualstudio.com/docs/editor/codebasics#_save-auto-save) of editors to files that have no errors reported in them at the time the auto save is triggered. Only applies when `#files.autoSave#` is enabled.)'
	},
	{
		id: 'files.watcherInclude',
		group: 'Files',
		type: 'array',
		items: 'string',
		default: [],
		description: 'พาธเพิ่มเติมที่ต้องเฝ้าดูการเปลี่ยนแปลง เช่น โฟลเดอร์ที่เป็น symlink (Configure extra paths to watch for changes inside the workspace. By default, all workspace folders will be watched recursively, except for folders that are symbolic links. You can explicitly add absolute or relative paths to support watching folders that are symbolic links. Relative paths will be resolved to an absolute path using the currently opened workspace.)'
	},
	{
		id: 'files.defaultLanguage',
		group: 'Files',
		type: 'string',
		default: '',
		description: 'ภาษาของไฟล์ใหม่ที่ยังไม่ได้บันทึก (The default language identifier that is assigned to new files. If configured to `${activeEditorLanguage}`, will use the language identifier of the currently active text editor if any.)'
	},
	{
		id: 'files.readonlyInclude',
		group: 'Files',
		type: 'object',
		values: 'boolean',
		default: {},
		description: 'pattern ของไฟล์ที่เปิดแบบอ่านอย่างเดียว (Configure paths or [glob patterns](https://aka.ms/vscode-glob-patterns) to mark as read-only. Glob patterns are always evaluated relative to the path of the workspace folder unless they are absolute paths. You can exclude matching paths via the `#files.readonlyExclude#` setting. Files from readonly file system providers will always be read-only independent of this setting.)'
	},
	{
		id: 'files.readonlyExclude',
		group: 'Files',
		type: 'object',
		values: 'boolean',
		default: {},
		description: 'pattern ของไฟล์ที่ไม่ต้องอ่านอย่างเดียว แม้จะตรงกับ files.readonlyInclude (Configure paths or [glob patterns](https://aka.ms/vscode-glob-patterns) to exclude from being marked as read-only if they match as a result of the `#files.readonlyInclude#` setting. Glob patterns are always evaluated relative to the path of the workspace folder unless they are absolute paths. Files from readonly file system providers will always be read-only independent of this setting.)'
	},
	{
		id: 'files.readonlyFromPermissions',
		group: 'Files',
		type: 'boolean',
		default: false,
		description: 'เปิดไฟล์แบบอ่านอย่างเดียวเมื่อสิทธิ์ของไฟล์ไม่ให้เขียน (Marks files as read-only when their file permissions indicate as such. This can be overridden via `#files.readonlyInclude#` and `#files.readonlyExclude#` settings.)'
	},
	{
		id: 'files.saveConflictResolution',
		group: 'Files',
		type: 'string',
		default: 'askUser',
		enum: ['askUser', 'overwriteFileOnDisk'],
		enumDescriptions: [
			'ถามก่อน ให้เลือกเปรียบเทียบ เขียนทับ หรือใช้เวอร์ชันบนดิสก์ (Will refuse to save and ask for resolving the save conflict manually.)',
			'เขียนทับไฟล์บนดิสก์เลย (Will resolve the save conflict by overwriting the file on disk with the changes in the editor.)'
		],
		description: 'ทำอย่างไรเมื่อไฟล์บนดิสก์ถูกแก้โดยโปรแกรมอื่นระหว่างบันทึก (A save conflict can occur when a file is saved to disk that was changed by another program in the meantime. To prevent data loss, the user is asked to compare the changes in the editor with the version on disk. This setting should only be changed if you frequently encounter save conflict errors and may result in data loss if used without caution.)'
	}
];
