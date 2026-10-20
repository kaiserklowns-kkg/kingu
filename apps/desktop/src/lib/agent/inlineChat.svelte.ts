// Inline chat (VS Code's inlineChat and terminal chat), in the IDE:
//   inlineChat.start                          ⌘I in a focused editor: ask for an edit of the
//                                             selection (or code at the cursor); the answer is
//                                             applied and highlighted, then Keep or Undo
//   workbench.action.terminal.chat.start      ⌘I in a focused panel terminal: ask for a command,
//                                             then Run it or Insert it (never run without a pick)
// Both ask the source-control AI agent the user set up (kingu.git.ai.agent; Rust `ai_generate`
// runs that CLI once, read-only). inlineChat.ts has the prompts and parsing.

import { invoke } from '@tauri-apps/api/core';
import type * as Monaco from 'monaco-editor';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { panelTerminalFocus } from '#lib/terminal/terminalCommands.svelte.ts';
import { focusedTerminal } from '#lib/terminal/registry.ts';
import { t } from '#lib/i18n/index.ts';
import { lastCommandOutput } from './chatContext.ts';
import { around, codeFromAnswer, commandFromAnswer, editorPrompt, terminalPrompt } from './inlineChat.ts';

type MonacoApi = typeof Monaco;
let monacoApi: MonacoApi | null = null;

/** The editor with keyboard focus, once Monaco is loaded. */
function focusedEditor(): Monaco.editor.ICodeEditor | null {
	return monacoApi?.editor.getEditors().find((e) => e.hasTextFocus()) ?? null;
}

const editorFocus = () => !appMode.isAgents && !panelTerminalFocus() && focusedEditor() !== null;

async function generate(prompt: string): Promise<string | null> {
	status.flash(t('inlineChat.working'), 180000);
	try {
		const answer = await invoke<string>('ai_generate', { slug: null, prompt });
		status.flash(t('inlineChat.done'), 2000);
		return answer;
	} catch (e) {
		status.flash(t('inlineChat.failed', { error: String(e) }), 10000);
		return null;
	}
}

async function editorChat() {
	const editor = focusedEditor();
	const model = editor?.getModel();
	const sel = editor?.getSelection();
	if (!editor || !model || !sel || !monacoApi) return;
	const instruction = await quick.input({ placeholder: sel.isEmpty() ? t('inlineChat.editor.placeholderGenerate') : t('inlineChat.editor.placeholder'), hint: (v) => (v.trim() ? t('inlineChat.hint') : t('inlineChat.editor.empty')) });
	editor.focus();
	if (!instruction?.trim()) return;
	const versionAsked = model.getAlternativeVersionId();
	const ctx = around(model.getValue(), sel.startLineNumber, sel.endLineNumber);
	const rel = model.uri.scheme === 'file' && workspace.root ? model.uri.path.replace(`${workspace.root.replace(/\/+$/, '')}/`, '') : model.uri.path;
	const answer = await generate(editorPrompt({ instruction, path: rel, language: model.getLanguageId(), before: ctx.before, selection: model.getValueInRange(sel), after: ctx.after }));
	if (answer === null) return;
	if (model.isDisposed() || model.getAlternativeVersionId() !== versionAsked) return void status.flash(t('inlineChat.editor.changed'), 8000);
	const code = codeFromAnswer(answer);
	if (!code) return void status.flash(t('inlineChat.empty'), 6000);
	// Applied as one undoable edit; the inverse edit is Undo's.
	editor.pushUndoStop();
	model.pushEditOperations(editor.getSelections() ?? [], [{ range: sel, text: code, forceMoveMarkers: true }], () => null);
	editor.pushUndoStop();
	const applied = model.getAlternativeVersionId();
	const end = model.getPositionAt(model.getOffsetAt({ lineNumber: sel.startLineNumber, column: sel.startColumn }) + code.length);
	const range = new monacoApi.Range(sel.startLineNumber, sel.startColumn, end.lineNumber, end.column);
	const deco = editor.createDecorationsCollection([{ range, options: { className: 'kg-ce-added', isWholeLine: true } }]);
	editor.setSelection(range);
	editor.revealRangeInCenterIfOutsideViewport(range);
	const choice = await quick.choose({
		placeholder: t('inlineChat.editor.review'),
		items: [
			{ id: 'keep', label: t('inlineChat.keep'), description: t('inlineChat.keepHint') },
			{ id: 'undo', label: t('inlineChat.undo'), description: t('inlineChat.undoHint') }
		]
	});
	deco.clear();
	editor.focus();
	// Undo (or dismissed) while nothing else changed the file: back to before the edit.
	if (choice?.id !== 'keep' && !model.isDisposed() && model.getAlternativeVersionId() === applied) editor.trigger('inlineChat', 'undo', null);
}

async function terminalChat() {
	const h = focusedTerminal('ide');
	if (!h) return;
	const instruction = await quick.input({ placeholder: t('inlineChat.terminal.placeholder'), hint: (v) => (v.trim() ? t('inlineChat.hint') : t('inlineChat.terminal.empty')) });
	if (!instruction?.trim()) return void h.focus();
	const last = h.lines ? lastCommandOutput(h.lines()) : null;
	const shown = last ? (last.command ? `$ ${last.command}\n${last.output}` : last.output) : '';
	const platform = navigator.userAgent.includes('Mac') ? 'macOS' : navigator.userAgent.includes('Windows') ? 'Windows' : 'Linux';
	const answer = await generate(terminalPrompt(instruction, navigator.userAgent.includes('Windows') ? 'PowerShell' : 'the user’s login shell (zsh or bash)', platform, shown));
	if (answer === null) return void h.focus();
	const command = commandFromAnswer(answer);
	if (!command) return (status.flash(t('inlineChat.empty'), 6000), h.focus());
	const choice = await quick.choose({
		placeholder: command,
		items: [
			{ id: 'insert', label: t('inlineChat.terminal.insert'), description: t('inlineChat.terminal.insertHint') },
			{ id: 'run', label: t('inlineChat.terminal.run'), description: command }
		]
	});
	h.focus();
	if (choice?.id === 'run') h.write(`${command}\r`);
	else if (choice?.id === 'insert') h.write(command);
}

export function registerInlineChatCommands(): () => void {
	void import('#lib/editor/monaco.ts').then((m) => (monacoApi = m.monaco));
	const off = [
		commands.register({
			id: 'inlineChat.start',
			title: 'Open Inline Chat',
			category: 'Inline Chat',
			key: 'ctrl+i',
			mac: 'cmd+i',
			scope: 'ide',
			keyWhen: () => !panelTerminalFocus() && editorFocus(),
			weight: 100,
			run: () => void editorChat()
		}),
		commands.register({
			id: 'workbench.action.terminal.chat.start',
			title: 'Open Terminal Inline Chat',
			category: 'Terminal',
			key: 'ctrl+i',
			mac: 'cmd+i',
			scope: 'ide',
			keyWhen: panelTerminalFocus,
			weight: 100,
			run: () => void terminalChat()
		})
	];
	return () => off.forEach((f) => f());
}
