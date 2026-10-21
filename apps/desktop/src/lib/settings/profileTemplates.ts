// Profile templates for New Profile… (VS Code's built-in profile templates, simplified): the
// settings each starts with. VS Code's templates also install extensions; Kingu's languages are
// built in, so a template is only its settings.json. Pure.

export type ProfileTemplate = { id: string; name: string; settings: Record<string, unknown> };

export const PROFILE_TEMPLATES: readonly ProfileTemplate[] = [
	{
		id: 'python',
		name: 'Python',
		settings: {
			'editor.formatOnSave': true,
			'editor.rulers': [88],
			'files.trimTrailingWhitespace': true,
			'[python]': { 'editor.tabSize': 4, 'editor.insertSpaces': true }
		}
	},
	{
		id: 'dataScience',
		name: 'Data Science',
		settings: {
			'editor.minimap.enabled': false,
			'editor.wordWrap': 'on',
			'workbench.editor.enablePreview': false,
			'files.trimTrailingWhitespace': true,
			'[python]': { 'editor.tabSize': 4 }
		}
	},
	{
		id: 'docWriter',
		name: 'Doc Writer',
		settings: {
			'editor.wordWrap': 'on',
			'editor.minimap.enabled': false,
			'editor.lineNumbers': 'off',
			'editor.fontSize': 15,
			'editor.quickSuggestions': { other: false, comments: false, strings: false },
			'files.autoSave': 'afterDelay',
			'workbench.startupEditor': 'readme'
		}
	},
	{
		id: 'nodejs',
		name: 'Node.js',
		settings: {
			'editor.formatOnSave': true,
			'editor.tabSize': 2,
			'files.trimTrailingWhitespace': true,
			'files.insertFinalNewline': true,
			'files.exclude': { '**/node_modules': true }
		}
	},
	{
		id: 'angular',
		name: 'Angular',
		settings: {
			'editor.formatOnSave': true,
			'editor.tabSize': 2,
			'files.insertFinalNewline': true,
			'[html]': { 'editor.tabSize': 2 },
			'[typescript]': { 'editor.tabSize': 2 }
		}
	},
	{
		id: 'java',
		name: 'Java General',
		settings: {
			'editor.formatOnSave': true,
			'editor.tabSize': 4,
			'editor.rulers': [120],
			'files.trimTrailingWhitespace': true
		}
	}
];

/** A template's settings.json text. */
export const templateSettingsText = (t: ProfileTemplate) => JSON.stringify(t.settings, null, '\t') + '\n';

/** The setting ids a template sets, with language blocks (`[python]`) opened. */
export function templateSettingIds(t: ProfileTemplate): string[] {
	return Object.entries(t.settings).flatMap(([k, v]) => (/^\[.+\]$/.test(k) && v && typeof v === 'object' ? Object.keys(v) : [k]));
}

/** "Temp 1", "Temp 2"…: the first free name for a temporary profile. */
export function temporaryProfileName(taken: readonly string[], base = 'Temp'): string {
	const used = new Set(taken.map((n) => n.toLowerCase()));
	for (let i = 1; ; i++) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}
