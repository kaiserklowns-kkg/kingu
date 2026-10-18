// VS Code settings: explorer.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const EXPLORER_SETTINGS: SettingSchema[] = [
	{
		id: 'explorer.confirmDelete',
		group: 'Explorer',
		type: 'boolean',
		default: true,
		description: 'ถามก่อนย้ายไฟล์ไปถังขยะ (Controls whether the Explorer should ask for confirmation when deleting files and folders.)'
	},
	{
		id: 'explorer.sortOrder',
		group: 'Explorer',
		type: 'string',
		default: 'default',
		enum: ['default', 'mixed', 'filesFirst', 'type', 'modified', 'foldersNestsFiles'],
		enumDescriptions: [
			'โฟลเดอร์ก่อน แล้วเรียงตามชื่อ (Files and folders are sorted by their names. Folders are displayed before files.)',
			'ไฟล์และโฟลเดอร์ปนกันตามชื่อ (Files and folders are sorted by their names. Files are interwoven with folders.)',
			'ไฟล์ก่อนโฟลเดอร์ (Files and folders are sorted by their names. Files are displayed before folders.)',
			'โฟลเดอร์ก่อน แล้วเรียงตามนามสกุลไฟล์ (Files and folders are grouped by extension type then sorted by their names. Folders are displayed before files.)',
			'โฟลเดอร์ก่อน แล้วเรียงตามเวลาแก้ไขล่าสุด (Files and folders are sorted by last modified date in descending order. Folders are displayed before files.)',
			'โฟลเดอร์ก่อน แล้วไฟล์ที่มีไฟล์ซ้อนอยู่ แล้วเรียงตามชื่อ (Files and folders are sorted by their names. Folders are displayed before files. Files with nested children are displayed before other files.)'
		],
		description: 'การเรียงไฟล์และโฟลเดอร์ใน Explorer (Controls the property-based sorting of files and folders in the Explorer. When `#explorer.fileNesting.enabled#` is enabled, also controls sorting of nested files.)'
	},
	{
		id: 'explorer.compactFolders',
		group: 'Explorer',
		type: 'boolean',
		default: true,
		description: 'รวมโฟลเดอร์ที่มีโฟลเดอร์ย่อยเดียวเป็นแถวเดียว เช่น src/lib/utils (Controls whether the Explorer should render folders in a compact form. In such a form, single child folders will be compressed in a combined tree element. Useful for Java package structures, for example.)'
	},
	{
		id: 'explorer.enableDragAndDrop',
		group: 'Explorer',
		type: 'boolean',
		default: true,
		description: 'ลากและวางเพื่อย้ายไฟล์และโฟลเดอร์ใน Explorer (Controls whether the Explorer should allow to move files and folders via drag and drop. This setting only effects drag and drop from inside the Explorer.)'
	},
	{
		id: 'explorer.confirmDragAndDrop',
		group: 'Explorer',
		type: 'boolean',
		default: true,
		description: 'ถามก่อนย้ายไฟล์และโฟลเดอร์ด้วยการลากและวาง (Controls whether the Explorer should ask for confirmation to move files and folders via drag and drop.)'
	},
	{
		id: 'explorer.autoReveal',
		group: 'Explorer',
		type: 'json',
		schema: { type: ['boolean', 'string'], enum: [true, false, 'focusNoScroll'] },
		default: true,
		description: 'เลือกและแสดงไฟล์ของ editor ที่เปิดอยู่ใน Explorer อัตโนมัติ (Controls whether the Explorer should automatically reveal and select files when opening them.)'
	},
	{
		id: 'explorer.excludeGitIgnore',
		group: 'Explorer',
		type: 'boolean',
		default: false,
		description: 'ซ่อนไฟล์ที่ .gitignore ไม่สนใจออกจาก Explorer (Controls whether entries in .gitignore should be parsed and excluded from the Explorer. Similar to `#files.exclude#`.)'
	},
	{
		id: 'explorer.autoRevealExclude',
		group: 'Explorer',
		type: 'object',
		values: 'boolean|when',
		default: { '**/node_modules': true, '**/bower_components': true },
		description: 'pattern ของไฟล์และโฟลเดอร์ที่ไม่ต้องเลือกให้ใน Explorer เมื่อเปิดไฟล์ (Configure paths or [glob patterns](https://aka.ms/vscode-glob-patterns) for excluding files and folders from being revealed and selected in the Explorer when they are opened. Glob patterns are always evaluated relative to the path of the workspace folder unless they are absolute paths.)'
	},
	{
		id: 'explorer.sortOrderLexicographicOptions',
		group: 'Explorer',
		type: 'string',
		default: 'default',
		enum: ['default', 'upper', 'lower', 'unicode'],
		enumDescriptions: [
			'ตัวพิมพ์ใหญ่และเล็กปนกัน (Uppercase and lowercase names are mixed together.)',
			'ชื่อที่ขึ้นต้นด้วยตัวพิมพ์ใหญ่มาก่อน (Uppercase names are grouped together before lowercase names.)',
			'ชื่อที่ขึ้นต้นด้วยตัวพิมพ์เล็กมาก่อน (Lowercase names are grouped together before uppercase names.)',
			'เรียงตามรหัส Unicode (Names are sorted in Unicode order.)'
		],
		description: 'วิธีเรียงชื่อไฟล์และโฟลเดอร์ตามตัวอักษร (Controls the lexicographic sorting of file and folder names in the Explorer.)'
	},
	{
		id: 'explorer.sortOrderReverse',
		group: 'Explorer',
		type: 'boolean',
		default: false,
		description: 'กลับลำดับการเรียงไฟล์และโฟลเดอร์ (Controls whether the file and folder sort order, should be reversed.)'
	},
	{
		id: 'explorer.decorations.colors',
		group: 'Explorer',
		type: 'boolean',
		default: true,
		description: 'ใช้สีแสดงสถานะไฟล์ใน Explorer เช่น แก้ไขแล้วหรือไฟล์ใหม่ (Controls whether file decorations should use colors.)'
	},
	{
		id: 'explorer.decorations.badges',
		group: 'Explorer',
		type: 'boolean',
		default: true,
		description: 'แสดงตัวอักษรสถานะไฟล์ท้ายชื่อใน Explorer (Controls whether file decorations should use badges.)'
	},
	{
		id: 'explorer.incrementalNaming',
		group: 'Explorer',
		type: 'string',
		default: 'simple',
		enum: ['simple', 'smart', 'disabled'],
		enumDescriptions: [
			'เติมคำว่า copy ต่อท้ายชื่อ (Appends the word "copy" at the end of the duplicated name potentially followed by a number.)',
			'เพิ่มตัวเลขในชื่อ (Adds a number at the end of the duplicated name. If some number is already part of the name, tries to increase that number.)',
			'ไม่ตั้งชื่อใหม่ ถามว่าจะเขียนทับไหม (Disables incremental naming. If two files with the same name exist you will be prompted to overwrite the existing file.)'
		],
		description: 'วิธีตั้งชื่อใหม่เมื่อวางไฟล์ซ้ำชื่อเดิม (Controls which naming strategy to use when giving a new name to a duplicated Explorer item on paste.)'
	},
	{
		id: 'explorer.autoOpenDroppedFile',
		group: 'Explorer',
		type: 'boolean',
		default: true,
		description: 'เปิดไฟล์ที่ลากมาวางใน Explorer อัตโนมัติ (Controls whether the Explorer should automatically open a file when it is dropped into the explorer)'
	},
	{
		id: 'explorer.copyRelativePathSeparator',
		group: 'Explorer',
		type: 'string',
		default: 'auto',
		enum: ['/', '\\', 'auto'],
		enumDescriptions: [
			'ใช้ / (Use slash as path separation character.)',
			'ใช้ \\ (Use backslash as path separation character.)',
			'ตามระบบปฏิบัติการ (Uses operating system specific path separation character.)'
		],
		description: 'ตัวคั่นพาธเมื่อคัดลอก relative path (The path separation character used when copying relative file paths.)'
	},
	{
		id: 'explorer.copyPathSeparator',
		group: 'Explorer',
		type: 'string',
		default: 'auto',
		enum: ['/', '\\', 'auto'],
		enumDescriptions: [
			'ใช้ / (Use slash as path separation character.)',
			'ใช้ \\ (Use backslash as path separation character.)',
			'ตามระบบปฏิบัติการ (Uses operating system specific path separation character.)'
		],
		description: 'ตัวคั่นพาธเมื่อคัดลอกพาธเต็ม (The path separation character used when copying file paths.)'
	},
	{
		id: 'explorer.fileNesting.enabled',
		group: 'Explorer',
		type: 'boolean',
		default: false,
		description: 'ซ้อนไฟล์ที่เกี่ยวข้องกันไว้ใต้ไฟล์หลักใน Explorer (Controls whether file nesting is enabled in the Explorer. File nesting allows for related files in a directory to be visually grouped together under a single parent file.)'
	},
	{
		id: 'explorer.fileNesting.expand',
		group: 'Explorer',
		type: 'boolean',
		default: true,
		description: 'กางไฟล์ที่ซ้อนอยู่ไว้ตั้งแต่แรก (Controls whether file nests are automatically expanded. `#explorer.fileNesting.enabled#` must be set for this to take effect.)'
	},
	{
		id: 'explorer.fileNesting.patterns',
		group: 'Explorer',
		type: 'object',
		values: 'string',
		default: {
			'*.ts': '${capture}.js',
			'*.js': '${capture}.js.map, ${capture}.min.js, ${capture}.d.ts',
			'*.jsx': '${capture}.js',
			'*.tsx': '${capture}.ts',
			'tsconfig.json': 'tsconfig.*.json',
			'package.json': 'package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb, bun.lock'
		},
		description: 'กฎการซ้อนไฟล์ แต่ละรายการคือ pattern ของไฟล์หลักกับรายชื่อไฟล์ที่ซ้อนใต้มัน (Controls nesting of files in the Explorer. `#explorer.fileNesting.enabled#` must be set for this to take effect. Each __Item__ represents a parent pattern and may contain a single `*` character that matches any string. Each __Value__ represents a comma separated list of the child patterns that should be shown nested under a given parent. Child patterns may contain several special tokens:\n- `${capture}`: Matches the resolved value of the `*` from the parent pattern\n- `${basename}`: Matches the parent file\'s basename, the `file` in `file.ts`\n- `${extname}`: Matches the parent file\'s extension, the `ts` in `file.ts`\n- `${dirname}`: Matches the parent file\'s directory name, the `src` in `src/file.ts`\n- `*`:  Matches any string, may only be used once per child pattern)'
	}
];
