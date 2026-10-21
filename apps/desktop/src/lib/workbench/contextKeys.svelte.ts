// Live context keys for `when` clauses (VS Code: IContextKeyService). Read on demand when a key
// is pressed, from DOM focus and workbench state, instead of being pushed on every change.

import type { Context } from './contextKey';
import { editors } from './editors.svelte';
import { isMac } from './keys';
import { layout } from './layout.svelte';
import { appMode } from './mode.svelte';
import { quick } from './quick.svelte';
import { isDiffKey } from './scm';

/** What the focused Monaco editor knows (set by editorActions.svelte.ts once Monaco loads). */
export type EditorContext = { hasSelection: boolean; multipleSelections: boolean; langId: string; readOnly: boolean };
let focusedEditor: () => EditorContext | null = () => null;
export function setEditorContextProvider(fn: () => EditorContext | null) {
	focusedEditor = fn;
}

/** Extra keys other parts contribute (notifications center, explorer…). */
const providers: (() => Record<string, unknown>)[] = [];
export function contributeContextKeys(fn: () => Record<string, unknown>): () => void {
	providers.push(fn);
	return () => {
		const i = providers.indexOf(fn);
		if (i >= 0) providers.splice(i, 1);
	};
}

const extname = (path: string) => {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot) : '';
};

export function currentContext(): Context {
	const el = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);
	const inMonaco = !!el?.closest('.monaco-editor');
	const editorTextFocus = inMonaco && (el?.tagName === 'TEXTAREA' || el?.classList.contains('native-edit-context') === true || el?.closest('.view-lines') !== null);
	const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
	const terminalFocus = !!el?.closest('.xterm');
	const ed = inMonaco ? focusedEditor() : null;
	const active = editors.active;
	const tab = active ? editors.tabs.find((t) => t.path === active) : undefined;
	const ctx: Record<string, unknown> = {
		isMac,
		isLinux: !isMac && typeof navigator !== 'undefined' && navigator.userAgent.includes('Linux'),
		isWindows: typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows'),
		editorFocus: inMonaco,
		editorTextFocus,
		textInputFocus: editorTextFocus || (typing && !terminalFocus),
		inputFocus: typing,
		editorHasSelection: ed?.hasSelection ?? false,
		editorHasMultipleSelections: ed?.multipleSelections ?? false,
		editorReadonly: ed?.readOnly ?? false,
		editorLangId: ed?.langId ?? editors.language,
		terminalFocus,
		inQuickOpen: quick.visible,
		filesExplorerFocus: !!el?.closest('[data-context="explorer"]'),
		explorerViewletFocus: !!el?.closest('[data-context="explorer"]'),
		listFocus: !!el?.closest('[role="tree"], [role="listbox"]'),
		sideBarVisible: layout.sidebarVisible,
		panelVisible: layout.panelVisible,
		auxiliaryBarVisible: layout.auxVisible,
		auxiliaryBarMaximized: layout.auxMaximized,
		activeViewlet: `workbench.view.${layout.sideView}`,
		activePanel: `workbench.panel.${layout.panelTab}`,
		activeEditor: active ? (isDiffKey(active) ? 'workbench.editors.textDiffEditor' : 'workbench.editors.files.textFileEditor') : null,
		activeEditorIsDirty: tab?.dirty ?? false,
		activeEditorIsNotPreview: tab ? !tab.preview : false,
		activeEditorIsPinned: tab?.sticky ?? false,
		activeEditorGroupEmpty: !active,
		multipleEditorGroups: editors.groups.length > 1,
		editorIsOpen: !!active,
		resourceFilename: active ? active.slice(active.lastIndexOf('/') + 1) : '',
		resourceExtname: active ? extname(active) : '',
		resourceScheme: active?.startsWith('untitled:') ? 'untitled' : 'file',
		isAgentsMode: appMode.isAgents
	};
	for (const p of providers) Object.assign(ctx, p());
	return ctx;
}
