// The editor items of the status bar as commands (VS Code: editorStatus.ts ChangeLanguageAction,
// ChangeEOLAction, ChangeEncodingAction and the indentation picker; indentation.ts for tab sizes).
// They act on the focused file's shared text model and use the workbench quick input.

import { invoke } from '@tauri-apps/api/core';
import type * as Monaco from 'monaco-editor';
import { languageFor, languageNames } from '#lib/editor/languages.ts';
import { isWorkspaceTextFile } from '#lib/settings/resources.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { getEntry, revertFile, saveFile, type ModelEntry } from './editorModels';
import { quick, type PickItem } from './quick.svelte';
import { status } from './status.svelte';
import { textFiles } from './textFileService.svelte';
import { associationKey, encodingPicks, indentLabel, tabSizePicks } from './textFiles';
import { t } from '#lib/i18n/index.ts';

type MonacoModule = typeof import('#lib/editor/monaco.ts');


function active(): { path: string; entry: ModelEntry } | null {
	const path = editors.focusedFile;
	const entry = path ? getEntry(path) : undefined;
	return path && entry && !entry.model.isDisposed() ? { path, entry } : null;
}

async function noEditor() {
	const text = t('workbench.editorStatus.noEditor');
	await quick.choose({ placeholder: text, items: [{ id: '', label: text }] });
}

/** Keeps the status bar items in step with the model they describe. */
export function refreshStatus(model: Monaco.editor.ITextModel) {
	if (active()?.entry.model !== model) return;
	editors.language = model.getLanguageId();
	editors.eol = model.getEOL() === '\n' ? 'LF' : 'CRLF';
	editors.indent = indentLabel(model.getOptions());
}

// --- Change Language Mode

const AUTO = '\0auto';
const CONFIGURE = '\0configure';

export async function changeLanguageMode() {
	const a = active();
	if (!a) return noEditor();
	const m: MonacoModule = await import('#lib/editor/monaco.ts');
	const { model } = a.entry;
	const current = model.getLanguageId();
	const ids = m.monaco.languages.getLanguages().map((l) => l.id);
	const items: PickItem[] = [];
	if (model.getValueLength() > 0) items.push({ id: AUTO, label: t('workbench.editorStatus.autoDetect') });
	const fileKey = associationKey(a.path);
	if (isWorkspaceTextFile(a.path)) items.push({ id: CONFIGURE, label: t('workbench.editorStatus.configureAssociation', { pattern: fileKey.replace(/^\*/, '') }) });
	languageNames(ids).forEach(({ id, name }, i) =>
		items.push({ id, label: name, description: id === current ? `(${id}) - Configured Language` : `(${id})`, separator: i === 0 ? 'languages (identifier)' : undefined })
	);
	const pick = await quick.choose({ placeholder: t('workbench.editorStatus.selectLanguage'), items, activeId: current });
	if (!pick) return;
	if (pick.id === CONFIGURE) return configureFileAssociation(m, a.path);
	let language = pick.id;
	if (pick.id === AUTO) {
		const known = new Set(ids);
		language = languageFor(a.path, { associations: settings.get('files.associations'), firstLine: model.getLineContent(1), known: (id) => known.has(id) });
		a.entry.explicitLanguage = false;
	} else a.entry.explicitLanguage = true;
	m.monaco.editor.setModelLanguage(model, language);
	refreshStatus(model);
}

/** VS Code's configureFileAssociation: `*.ext` (or the file name) → the picked language in the user settings. */
async function configureFileAssociation(m: MonacoModule, path: string) {
	const key = associationKey(path);
	const base = path.split('/').pop() ?? path;
	const currentAssociation = languageFor(base);
	const items: PickItem[] = languageNames(m.monaco.languages.getLanguages().map((l) => l.id)).map(({ id, name }) => ({
		id,
		label: name,
		description: id === currentAssociation ? 'Current Association' : undefined
	}));
	const pick = await quick.choose({ placeholder: t('workbench.editorStatus.selectAssociation', { pattern: key.replace(/^\*/, '') }), items, activeId: currentAssociation });
	if (!pick) return;
	const current = (settings.inspect('files.associations', 'user') as Record<string, string> | undefined) ?? {};
	await settings.set('files.associations', { ...current, [key]: pick.id }, 'user').catch((e) => status.flash(t('workbench.editorStatus.associationFailed', { error: String(e) }), 8000));
}

// --- End of Line

export async function changeEOL() {
	const a = active();
	if (!a) return noEditor();
	const m: MonacoModule = await import('#lib/editor/monaco.ts');
	const { model } = a.entry;
	const items: PickItem[] = [
		{ id: 'LF', label: 'LF' },
		{ id: 'CRLF', label: 'CRLF' }
	];
	const pick = await quick.choose({ placeholder: t('workbench.editorStatus.selectEol'), items, activeId: model.getEOL() === '\n' ? 'LF' : 'CRLF' });
	if (!pick || model.isDisposed()) return;
	const { EndOfLineSequence } = m.monaco.editor;
	// Undoable and marks the file dirty, like VS Code's pushEOL.
	model.pushStackElement();
	model.pushEOL(pick.id === 'LF' ? EndOfLineSequence.LF : EndOfLineSequence.CRLF);
	model.pushStackElement();
	refreshStatus(model);
}

// --- Indentation

export async function changeIndentation() {
	const a = active();
	if (!a) return noEditor();
	const { model } = a.entry;
	const items: PickItem[] = [
		{ id: 'spaces', label: t('workbench.editorStatus.indentSpaces'), separator: t('workbench.editorStatus.changeView') },
		{ id: 'tabs', label: t('workbench.editorStatus.indentTabs') },
		{ id: 'display', label: t('workbench.editorStatus.tabDisplaySize') },
		{ id: 'detect', label: t('workbench.editorStatus.detectIndent'), separator: t('workbench.editorStatus.convertFile') },
		{ id: 'editor.action.indentationToSpaces', label: t('workbench.editorStatus.toSpaces') },
		{ id: 'editor.action.indentationToTabs', label: t('workbench.editorStatus.toTabs') },
		{ id: 'editor.action.trimTrailingWhitespace', label: t('workbench.editorStatus.trimWhitespace') }
	];
	const pick = await quick.choose({ placeholder: t('workbench.editorStatus.selectAction'), items });
	if (!pick || model.isDisposed()) return;
	const configured = { tabSize: settings.get<number>('editor.tabSize'), insertSpaces: settings.get<boolean>('editor.insertSpaces') };
	if (pick.id === 'detect') model.detectIndentation(configured.insertSpaces, configured.tabSize);
	else if (pick.id.startsWith('editor.action.')) editors.trigger(pick.id);
	else {
		const size = await quick.choose({
			placeholder: t('workbench.editorStatus.selectTabSize'),
			items: tabSizePicks(configured.tabSize, model.getOptions().tabSize),
			activeId: String(Math.min(model.getOptions().tabSize, 8))
		});
		if (!size || model.isDisposed()) return;
		const n = Number(size.id);
		if (pick.id === 'display') model.updateOptions({ tabSize: n });
		else model.updateOptions({ tabSize: n, indentSize: n, insertSpaces: pick.id === 'spaces' });
	}
	refreshStatus(model);
}

// --- Encoding

export async function changeEncoding() {
	const a = active();
	if (!a) return noEditor();
	if (!isWorkspaceTextFile(a.path)) {
		status.flash(t('workbench.editorStatus.alwaysUtf8'));
		return;
	}
	const action = await quick.choose({
		placeholder: t('workbench.editorStatus.selectAction'),
		items: [
			{ id: 'reopen', label: t('workbench.editorStatus.reopenWithEncoding') },
			{ id: 'save', label: t('workbench.editorStatus.saveWithEncoding') }
		]
	});
	if (!action) return;
	const reopen = action.id === 'reopen';
	// The encoding guessed from the content goes first, as VS Code reads the file with guessing on.
	const guessed = await invoke<{ kind: string; encoding?: string }>('textfile_read', { rel: a.path, options: { autoGuess: true, acceptBinary: true, acceptLarge: true } })
		.then((r) => r.encoding)
		.catch(() => undefined);
	const configured = settings.get<string>('files.encoding');
	const pick = await quick.choose({
		placeholder: reopen ? t('workbench.editorStatus.selectReopenEncoding') : t('workbench.editorStatus.selectSaveEncoding'),
		items: encodingPicks(configured, guessed),
		activeId: a.entry.encoding
	});
	if (!pick) return;
	if (reopen) {
		// VS Code: a dirty file has to be saved (or reverted) before it can be decoded again.
		if (editors.isDirty(a.path)) {
			status.flash(t('workbench.editorStatus.saveBeforeReopen'), 8000);
			return;
		}
		await revertFile(a.path, pick.id).catch((e) => status.flash(t('workbench.editorStatus.reopenFailed', { error: String(e) }), 8000));
	} else await saveFile(a.path, { encoding: pick.id });
	textFiles.syncEncoding(a.path);
}

export function registerEditorStatusCommands(): () => void {
	const hasEditor = () => active() !== null;
	const list = [
		commands.register({ id: 'workbench.action.editor.changeLanguageMode', title: 'Change Language Mode', key: 'cmd+k m', when: hasEditor, run: changeLanguageMode }),
		commands.register({ id: 'workbench.action.editor.changeEOL', title: 'Change End of Line Sequence', when: hasEditor, run: changeEOL }),
		commands.register({ id: 'workbench.action.editor.changeEncoding', title: 'Change File Encoding', when: hasEditor, run: changeEncoding }),
		commands.register({ id: 'changeEditorIndentation', title: 'Change Indentation', category: 'Editor', when: hasEditor, run: changeIndentation })
	];
	return () => list.forEach((u) => u());
}
