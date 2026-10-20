// Monaco's editor actions as workbench commands (VS Code: EditorAction → CommandsRegistry and
// MenuId.CommandPalette). Each action keeps its VS Code id (`editor.action.commentLine`…), shows
// in the palette with Monaco's key, and keybindings.json can bind it to another key (the window
// key listener runs it) or remove Monaco's default (`-editor.action.commentLine`).

import type * as Monaco from 'monaco-editor';
import { commands } from './commands.svelte';
import { setEditorContextProvider } from './contextKeys.svelte';
import { editors } from './editors.svelte';
import { keybindings } from './keybindings.svelte';
import { isMac } from './keys';
import { toMonacoKeybinding } from './monacoKeys';

type MonacoApi = typeof Monaco;

/** Monaco actions that would fight the workbench (its own command palette). */
const SKIP = new Set(['editor.action.quickCommand']);

let installed = false;

/** The default key Monaco binds to `id` (e.g. `cmd+/`), from the editor's keybinding service. */
function monacoKey(editor: Monaco.editor.ICodeEditor, id: string): string | undefined {
	const service = (editor as unknown as { _standaloneKeybindingService?: { lookupKeybinding(id: string): { getUserSettingsLabel(): string | null } | undefined } })._standaloneKeybindingService;
	try {
		return service?.lookupKeybinding(id)?.getUserSettingsLabel() ?? undefined;
	} catch {
		return undefined;
	}
}

/** Called once Monaco and the first editor exist. */
export function installEditorActions(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor) {
	if (installed) return;
	installed = true;

	setEditorContextProvider(() => {
		const ed = monaco.editor.getEditors().find((e) => e.hasTextFocus() || e.hasWidgetFocus());
		const model = ed?.getModel();
		if (!ed || !model) return null;
		const sels = ed.getSelections() ?? [];
		return {
			hasSelection: sels.some((s) => !s.isEmpty()),
			multipleSelections: sels.length > 1,
			langId: model.getLanguageId(),
			readOnly: ed.getOption(monaco.editor.EditorOption.readOnly)
		};
	});

	const existing = new Set(commands.all.map((c) => c.id));
	const actionIds = new Set<string>();
	// getActions (all registered) rather than getSupportedActions: support depends on the model shown.
	const all = (editor as unknown as { getActions?: () => Monaco.editor.IEditorAction[] }).getActions?.() ?? editor.getSupportedActions();
	for (const action of all) {
		actionIds.add(action.id);
		// A command the workbench registered for a menu (menus.ts EDITOR_ACTIONS) shows Monaco's key too.
		const own = existing.has(action.id) ? commands.get(action.id) : undefined;
		if (own && !own.key && !own.mac && !own.ownerKey && !own.scope) own.ownerKey = () => monacoKey(monaco.editor.getEditors()[0] ?? editor, action.id);
		if (SKIP.has(action.id) || existing.has(action.id) || !action.label) continue;
		commands.register({
			id: action.id,
			title: action.label,
			when: () => editors.active !== null,
			ownerKey: () => monacoKey(monaco.editor.getEditors()[0] ?? editor, action.id),
			run: () => editors.trigger(action.id)
		});
	}

	// keybindings.json removals of Monaco's defaults, re-applied whenever the file changes.
	let rules: Monaco.IDisposable | null = null;
	$effect.root(() => {
		$effect(() => {
			const { removed } = keybindings.user;
			rules?.dispose();
			const list: Monaco.editor.IKeybindingRule[] = [];
			for (const [id, keys] of removed) {
				if (!actionIds.has(id)) continue;
				if (keys === 'all') list.push({ keybinding: 0, command: `-${id}` });
				else
					for (const key of keys) {
						const kb = toMonacoKeybinding(key, monaco, isMac);
						if (kb !== null) list.push({ keybinding: kb, command: `-${id}` });
					}
			}
			rules = list.length ? monaco.editor.addKeybindingRules(list) : null;
		});
	});
}
