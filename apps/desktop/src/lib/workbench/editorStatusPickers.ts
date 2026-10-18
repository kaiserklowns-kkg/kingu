// The pickers behind the editor items of the status bar, as in VS Code: indentation
// (ChangeIndentationAction), end of line (ChangeEOLAction), encoding (ChangeEncodingAction) and
// language mode (ChangeLanguageAction).

import { editors } from './editors.svelte';
import { quick } from './quick.svelte';
import { status } from './status.svelte';

/** Monaco's indentation actions, in VS Code's order. */
const INDENT_ACTIONS = [
	{ id: 'editor.action.indentUsingSpaces', label: 'Indent Using Spaces' },
	{ id: 'editor.action.indentUsingTabs', label: 'Indent Using Tabs' },
	{ id: 'editor.action.changeTabDisplaySize', label: 'Change Tab Display Size' },
	{ id: 'editor.action.detectIndentation', label: 'Detect Indentation from Content' },
	{ id: 'editor.action.indentationToSpaces', label: 'Convert Indentation to Spaces' },
	{ id: 'editor.action.indentationToTabs', label: 'Convert Indentation to Tabs' },
	{ id: 'editor.action.trimTrailingWhitespace', label: 'Trim Trailing Whitespace' }
];

export function pickIndentation() {
	quick.pick({
		placeholder: 'Select Action',
		items: INDENT_ACTIONS.map((a) => ({ id: a.id, label: a.label })),
		// Monaco opens its own size picker for the first three; let the quick input close first.
		onAccept: (item) => setTimeout(() => editors.trigger(item.id), 0)
	});
}

export function pickEol() {
	quick.pick({
		placeholder: 'Select End of Line Sequence',
		items: [
			{ id: 'LF', label: 'LF' },
			{ id: 'CRLF', label: 'CRLF' }
		],
		activeId: editors.eol,
		onAccept: (item) => editors.setEol(item.id as 'LF' | 'CRLF')
	});
}

/** Kingu reads and writes files as UTF-8 only, so both actions offer just that. */
export function pickEncoding() {
	const choose = (action: string) =>
		quick.pick({
			placeholder: `Select File Encoding to ${action}`,
			items: [{ id: 'utf8', label: 'UTF-8', description: 'utf8 · Current' }],
			activeId: 'utf8',
			onAccept: () => status.flash('ไฟล์นี้เป็น UTF-8 อยู่แล้ว')
		});
	quick.pick({
		placeholder: 'Select Action',
		items: [
			{ id: 'reopen', label: 'Reopen with Encoding' },
			{ id: 'save', label: 'Save with Encoding' }
		],
		onAccept: (item) => setTimeout(() => choose(item.id === 'reopen' ? 'Reopen' : 'Save'), 0)
	});
}

/** The language a file name would get on its own (VS Code's "Auto Detect" falls back to this). */
function languageForPath(path: string): string {
	const name = path.split('/').pop()?.toLowerCase() ?? '';
	const byExt = editors.languages().find((l) => l.extensions.some((e) => name.endsWith(e.toLowerCase())));
	return byExt?.id ?? 'plaintext';
}

export function pickLanguage() {
	const current = editors.language;
	const langs = [...editors.languages()].sort((a, b) => a.name.localeCompare(b.name));
	const path = editors.active ?? '';
	quick.pick({
		placeholder: 'Select Language Mode',
		items: [
			{ id: '@auto', label: 'Auto Detect' },
			...langs.map((l, i) => ({
				id: l.id,
				label: l.name,
				description: l.id === current ? `(${l.id}) - Configured Language` : `(${l.id})`,
				separator: i === 0 ? 'languages (identifier)' : undefined
			}))
		],
		activeId: current,
		onAccept: (item) => editors.setLanguage(item.id === '@auto' ? languageForPath(path) : item.id)
	});
}
