// VS Code settings: search.*. Key, type, enum, default and English description are VS Code's
// (generated from its schema by tools/vscode-settings/gen.ts); the Thai text is Kingu's.
import type { SettingSchema } from '../registry';

export const SEARCH_SETTINGS: SettingSchema[] = [
	{
		id: 'search.exclude',
		group: 'Search',
		type: 'object',
		values: 'boolean|when',
		default: { '**/node_modules': true, '**/bower_components': true, '**/*.code-search': true },
		description: 'glob ที่ไม่ค้นหา (Configure [glob patterns](https://code.visualstudio.com/docs/editor/codebasics#_advanced-search-options) for excluding files and folders in fulltext searches and file search in quick open. To exclude files from the recently opened list in quick open, patterns must be absolute (for example `**/node_modules/**`). Inherits all glob patterns from the `#files.exclude#` setting.)'
	},
	{
		id: 'search.useIgnoreFiles',
		group: 'Search',
		type: 'boolean',
		default: true,
		description: 'ใช้ .gitignore และ .ignore ตอนค้นหา (Controls whether to use `.gitignore` and `.ignore` files when searching for files.)'
	},
	{
		id: 'search.useGlobalIgnoreFiles',
		group: 'Search',
		type: 'boolean',
		default: false,
		description: 'ใช้ไฟล์ ignore ส่วนกลางของ git (Controls whether to use your global gitignore file (for example, from `$HOME/.config/git/ignore`) when searching for files. Requires `#search.useIgnoreFiles#` to be enabled.)'
	},
	{
		id: 'search.useParentIgnoreFiles',
		group: 'Search',
		type: 'boolean',
		default: false,
		description: 'ใช้ .gitignore ของโฟลเดอร์แม่ที่อยู่นอก workspace (Controls whether to use `.gitignore` and `.ignore` files in parent directories when searching for files. Requires `#search.useIgnoreFiles#` to be enabled.)'
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
		description: 'ไม่สนตัวพิมพ์เล็กใหญ่ ยกเว้นคำค้นมีตัวพิมพ์ใหญ่ (Search case-insensitively if the pattern is all lowercase, otherwise, search case-sensitively.)'
	},
	{
		id: 'search.maxResults',
		group: 'Search',
		type: 'json',
		schema: { type: ['number', 'null'] },
		default: 20000,
		description: 'จำนวนผลลัพธ์สูงสุด (Controls the maximum number of search results, this can be set to `null` (empty) to return unlimited results.)'
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
		description: 'หน่วงเวลา (When `#search.searchOnType#` is enabled, controls the timeout in milliseconds between a character being typed and the search starting. Has no effect when `#search.searchOnType#` is disabled.)'
	},
	{
		id: 'search.ripgrep.maxThreads',
		group: 'Search',
		type: 'number',
		default: 0,
		description: 'จำนวน thread ที่ใช้ค้นหา 0 = ให้ ripgrep เลือกเอง (Number of threads to use for searching. When set to 0, the engine automatically determines this value.)'
	},
	{
		id: 'search.sortOrder',
		group: 'Search',
		type: 'string',
		default: 'default',
		enum: ['default', 'fileNames', 'type', 'modified', 'countDescending', 'countAscending'],
		enumDescriptions: [
			'ตามชื่อโฟลเดอร์และชื่อไฟล์ (Results are sorted by folder and file names, in alphabetical order.)',
			'ตามชื่อไฟล์ ไม่สนโฟลเดอร์ (Results are sorted by file names ignoring folder order, in alphabetical order.)',
			'ตามนามสกุลไฟล์ (Results are sorted by file extensions, in alphabetical order.)',
			'ไฟล์ที่แก้ไขล่าสุดก่อน (Results are sorted by file last modified date, in descending order.)',
			'ไฟล์ที่เจอมากสุดก่อน (Results are sorted by count per file, in descending order.)',
			'ไฟล์ที่เจอน้อยสุดก่อน (Results are sorted by count per file, in ascending order.)'
		],
		description: 'ลำดับไฟล์ในผลการค้นหา (Controls sorting order of search results.)'
	},
	{
		id: 'search.collapseResults',
		group: 'Search',
		type: 'string',
		default: 'alwaysExpand',
		enum: ['auto', 'alwaysCollapse', 'alwaysExpand'],
		enumDescriptions: [
			'ยุบไฟล์ที่เจอมากกว่า 10 ที่ (Files with less than 10 results are expanded. Others are collapsed.)',
			'ยุบทุกไฟล์',
			'กางทุกไฟล์'
		],
		description: 'ยุบหรือกางผลการค้นหาของแต่ละไฟล์ (Controls whether the search results will be collapsed or expanded.)'
	},
	{
		id: 'search.showLineNumbers',
		group: 'Search',
		type: 'boolean',
		default: false,
		description: 'แสดงเลขบรรทัดในผลการค้นหา (Controls whether to show line numbers for search results.)'
	},
	{
		id: 'search.seedWithNearestWord',
		group: 'Search',
		type: 'boolean',
		default: false,
		description: 'ใช้คำที่ cursor อยู่เป็นคำค้นเมื่อไม่ได้เลือกข้อความ (Enable seeding search from the word nearest the cursor when the active editor has no selection.)'
	},
	{
		id: 'search.seedOnFocus',
		group: 'Search',
		type: 'boolean',
		default: false,
		description: 'ใช้ข้อความที่เลือกใน editor เป็นคำค้นเมื่อโฟกัสมุมมอง Search (Update the search query to the editor\'s selected text when focusing the Search view. This happens either on click or when triggering the `workbench.views.search.focus` command.)'
	},
	{
		id: 'search.decorations.colors',
		group: 'Search',
		type: 'boolean',
		default: true,
		description: 'ใช้สีแสดงสถานะไฟล์ในผลการค้นหา (Controls whether search file decorations should use colors.)'
	},
	{
		id: 'search.decorations.badges',
		group: 'Search',
		type: 'boolean',
		default: true,
		description: 'แสดงตัวอักษรสถานะไฟล์ในผลการค้นหา (Controls whether search file decorations should use badges.)'
	},
	{
		id: 'search.defaultViewMode',
		group: 'Search',
		type: 'string',
		default: 'list',
		enum: ['tree', 'list'],
		enumDescriptions: [
			'แบบต้นไม้ตามโฟลเดอร์ (Shows search results as a tree.)',
			'แบบรายการ (Shows search results as a list.)'
		],
		description: 'มุมมองเริ่มต้นของผลการค้นหา (Controls the default search result view mode.)'
	},
	{
		id: 'search.quickOpen.includeSymbols',
		group: 'Search',
		type: 'boolean',
		default: false,
		description: 'แสดงสัญลักษณ์จาก language server ใน Quick Open ด้วย (Whether to include results from a global symbol search in the file results for Quick Open.)'
	},
	{
		id: 'search.quickOpen.includeHistory',
		group: 'Search',
		type: 'boolean',
		default: true,
		description: 'แสดงไฟล์ที่เพิ่งเปิดใน Quick Open (Whether to include results from recently opened files in the file results for Quick Open.)'
	},
	{
		id: 'search.quickOpen.history.filterSortOrder',
		group: 'Search',
		type: 'string',
		default: 'default',
		enum: ['default', 'recency'],
		enumDescriptions: [
			'ตามความตรงกับคำค้น (History entries are sorted by relevance based on the filter value used. More relevant entries appear first.)',
			'ตามที่เปิดล่าสุด (History entries are sorted by recency. More recently opened entries appear first.)'
		],
		description: 'ลำดับไฟล์ที่เพิ่งเปิดใน Quick Open ขณะพิมพ์ค้นหา (Controls sorting order of editor history in quick open when filtering.)'
	}
];
