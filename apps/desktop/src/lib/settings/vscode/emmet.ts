// VS Code settings: emmet.* (the built-in emmet extension; Kingu's Emmet is editor/emmet). Key,
// type, enum, default and English description are VS Code's; the Thai text is Kingu's.
// `emmet.extensionsPath` (custom snippet folders) and `emmet.optimizeStylesheetParsing` (a parser
// shortcut Kingu's line-based check does not need) are left out.
import type { SettingSchema } from '../registry';

export const EMMET_SETTINGS: SettingSchema[] = [
	{
		id: 'emmet.showExpandedAbbreviation',
		group: 'Emmet',
		type: 'string',
		default: 'always',
		enum: ['never', 'always', 'inMarkupAndStylesheetFilesOnly'],
		enumDescriptions: ['ไม่แสดง', 'แสดงในทุกภาษาที่ Emmet ใช้ได้', 'เฉพาะไฟล์ markup และ stylesheet (html, haml, pug, slim, xml, xsl, css, scss, sass, less, stylus)'],
		description: 'แสดงตัวย่อ Emmet ที่ขยายแล้วในรายการคำแนะนำ (Shows expanded Emmet abbreviations as suggestions. The option "inMarkupAndStylesheetFilesOnly" applies to html, haml, jade, slim, xml, xsl, css, scss, sass, less and stylus. The option "always" applies to all parts of the file regardless of markup/css.)'
	},
	{
		id: 'emmet.showAbbreviationSuggestions',
		group: 'Emmet',
		type: 'boolean',
		default: true,
		description: 'แสดงตัวย่อ Emmet ที่เป็นไปได้ในคำแนะนำ เช่น a: แล้วได้ a:link, a:mail (Shows possible Emmet abbreviations as suggestions. Not applicable in stylesheets or when emmet.showExpandedAbbreviation is set to "never".)'
	},
	{
		id: 'emmet.includeLanguages',
		group: 'Emmet',
		type: 'object',
		values: 'string',
		default: {},
		description: 'เปิด Emmet ในภาษาอื่น โดยจับคู่ภาษากับภาษาที่ Emmet รองรับ เช่น { "svelte": "html" } (Enable Emmet abbreviations in languages that are not supported by default. Add a mapping here between the language and Emmet supported language. For example: {"vue-html": "html", "javascript": "javascriptreact"})'
	},
	{
		id: 'emmet.variables',
		group: 'Emmet',
		type: 'object',
		values: 'string',
		default: {},
		description: 'ตัวแปรที่ snippet ของ Emmet ใช้ เช่น { "lang": "th" } (Variables to be used in Emmet snippets.)'
	},
	{
		id: 'emmet.syntaxProfiles',
		group: 'Emmet',
		type: 'json',
		schema: { type: 'object' },
		default: {},
		description: 'โปรไฟล์ของแต่ละ syntax เช่น { "html": { "attr_quotes": "single", "self_closing_tag": "xhtml" } } (Define profile for specified syntax or use your own profile with specific rules.)'
	},
	{
		id: 'emmet.excludeLanguages',
		group: 'Emmet',
		type: 'array',
		items: 'string',
		default: ['markdown'],
		description: 'ภาษาที่ไม่ขยายตัวย่อ Emmet (An array of languages where Emmet abbreviations should not be expanded.)'
	},
	{
		id: 'emmet.triggerExpansionOnTab',
		group: 'Emmet',
		type: 'boolean',
		default: false,
		description: 'กด Tab เพื่อขยายตัวย่อ Emmet แม้ไม่มีรายการคำแนะนำ (When enabled, Emmet abbreviations are expanded when pressing TAB, even when completions do not show up. When disabled, completions that show up can still be accepted by pressing TAB.)'
	},
	{
		id: 'emmet.useInlineCompletions',
		group: 'Emmet',
		type: 'boolean',
		default: false,
		description: 'แสดงตัวย่อที่ขยายแล้วเป็นข้อความจางในบรรทัด (inline completion) (If true, Emmet will use inline completions to suggest expansions. To prevent the non-inline completion item provider from showing up as often while this setting is true, turn editor.quickSuggestions to inline or off for the other item.)'
	},
	{
		id: 'emmet.preferences',
		group: 'Emmet',
		type: 'json',
		schema: { type: 'object' },
		default: {},
		description: 'ค่าที่ปรับพฤติกรรมของ Emmet เช่น { "css.intUnit": "rem", "bem.elementSeparator": "__" } (Preferences used to modify behavior of some actions and resolvers of Emmet.)'
	},
	{
		id: 'emmet.showSuggestionsAsSnippets',
		group: 'Emmet',
		type: 'boolean',
		default: false,
		description: 'แสดงคำแนะนำของ Emmet เป็น snippet จึงเรียงตาม editor.snippetSuggestions (If true, then Emmet suggestions will show up as snippets allowing you to order them as per editor.snippetSuggestions setting.)'
	}
];
