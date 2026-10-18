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

type MonacoModule = typeof import('#lib/editor/monaco.ts');

const NO_EDITOR = 'ไม่มีตัวแก้ไขข้อความที่เปิดอยู่ (No text editor active at this time)';

function active(): { path: string; entry: ModelEntry } | null {
	const path = editors.focusedFile;
	const entry = path ? getEntry(path) : undefined;
	return path && entry && !entry.model.isDisposed() ? { path, entry } : null;
}

async function noEditor() {
	await quick.choose({ placeholder: NO_EDITOR, items: [{ id: '', label: NO_EDITOR }] });
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
	if (model.getValueLength() > 0) items.push({ id: AUTO, label: 'ตรวจหาอัตโนมัติ (Auto Detect)' });
	const fileKey = associationKey(a.path);
	if (isWorkspaceTextFile(a.path)) items.push({ id: CONFIGURE, label: `Configure File Association for '${fileKey.replace(/^\*/, '')}'...` });
	languageNames(ids).forEach(({ id, name }, i) =>
		items.push({ id, label: name, description: id === current ? `(${id}) - Configured Language` : `(${id})`, separator: i === 0 ? 'languages (identifier)' : undefined })
	);
	const pick = await quick.choose({ placeholder: 'เลือกภาษา (Select Language Mode)', items, activeId: current });
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
	const pick = await quick.choose({ placeholder: `เลือกภาษาที่จะใช้กับ '${key.replace(/^\*/, '')}' (Select Language Mode to Associate with '${key.replace(/^\*/, '')}')`, items, activeId: currentAssociation });
	if (!pick) return;
	const current = (settings.inspect('files.associations', 'user') as Record<string, string> | undefined) ?? {};
	await settings.set('files.associations', { ...current, [key]: pick.id }, 'user').catch((e) => status.flash(`ตั้งค่า files.associations ไม่ได้: ${e}`, 8000));
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
	const pick = await quick.choose({ placeholder: 'เลือกตัวขึ้นบรรทัดใหม่ (Select End of Line Sequence)', items, activeId: model.getEOL() === '\n' ? 'LF' : 'CRLF' });
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
		{ id: 'spaces', label: 'Indent Using Spaces', description: 'เยื้องด้วยช่องว่าง', separator: 'change view' },
		{ id: 'tabs', label: 'Indent Using Tabs', description: 'เยื้องด้วยแท็บ' },
		{ id: 'display', label: 'Change Tab Display Size', description: 'ความกว้างของแท็บ' },
		{ id: 'detect', label: 'Detect Indentation from Content', description: 'ตรวจจากเนื้อหาไฟล์', separator: 'convert file' },
		{ id: 'editor.action.indentationToSpaces', label: 'Convert Indentation to Spaces' },
		{ id: 'editor.action.indentationToTabs', label: 'Convert Indentation to Tabs' },
		{ id: 'editor.action.trimTrailingWhitespace', label: 'Trim Trailing Whitespace' }
	];
	const pick = await quick.choose({ placeholder: 'เลือกการทำงาน (Select Action)', items });
	if (!pick || model.isDisposed()) return;
	const configured = { tabSize: settings.get<number>('editor.tabSize'), insertSpaces: settings.get<boolean>('editor.insertSpaces') };
	if (pick.id === 'detect') model.detectIndentation(configured.insertSpaces, configured.tabSize);
	else if (pick.id.startsWith('editor.action.')) editors.trigger(pick.id);
	else {
		const size = await quick.choose({
			placeholder: 'เลือกขนาดแท็บของไฟล์นี้ (Select Tab Size for Current File)',
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
		status.flash('ไฟล์นี้ใช้ UTF-8 เสมอ');
		return;
	}
	const action = await quick.choose({
		placeholder: 'เลือกการทำงาน (Select Action)',
		items: [
			{ id: 'reopen', label: 'เปิดใหม่ด้วย Encoding (Reopen with Encoding)' },
			{ id: 'save', label: 'บันทึกด้วย Encoding (Save with Encoding)' }
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
		placeholder: reopen ? 'เลือก encoding ที่จะเปิดไฟล์ (Select File Encoding to Reopen File)' : 'เลือก encoding ที่จะบันทึก (Select File Encoding to Save with)',
		items: encodingPicks(configured, guessed),
		activeId: a.entry.encoding
	});
	if (!pick) return;
	if (reopen) {
		// VS Code: a dirty file has to be saved (or reverted) before it can be decoded again.
		if (editors.isDirty(a.path)) {
			status.flash('ไฟล์มีการแก้ไขที่ยังไม่บันทึก: บันทึกก่อนแล้วจึงเปิดใหม่ด้วย encoding อื่น', 8000);
			return;
		}
		await revertFile(a.path, pick.id).catch((e) => status.flash(`เปิดใหม่ไม่สำเร็จ: ${e}`, 8000));
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
