// User and workspace snippets in the editor (VS Code: contrib/snippets): the snippets service
// (user files from the active profile through Rust, `.vscode/*.code-snippets` of the folder),
// IntelliSense suggestions, Tab completion (`editor.tabCompletion: onlySnippets`), the Surround
// With / Start with code actions (`editor.snippets.codeActions.enabled`) and the commands Insert
// Snippet, Surround with Snippet, Fill File with Snippet and Configure Snippets.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type * as Monaco from 'monaco-editor';
import { clientLog } from '#lib/client-log.ts';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { openModels } from '#lib/workbench/editorModels.ts';
import { externalPath, isExternalKey } from '#lib/workbench/externalFiles.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick, type PickItem } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { isUntitled, untitledName } from '#lib/workbench/untitled.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { activeCodeEditor, monacoApi, writableEditor } from '../activeEditor.ts';
import { globalSnippetFileName, isWorkspaceSnippetsPath, languageOfFile, matchSnippets, parseSnippetFile, selectSnippets, snippetFileTemplate, snippetLabels, snippetPreview, tabCompletionSnippets, userSnippetsKey, type Snippet } from './snippetFiles.ts';
import { prepareSnippet, type FileVariables } from './snippetSyntax.ts';

type MonacoApi = typeof Monaco;
type UserFile = { name: string; content: string };
type SnippetController = { insert(template: string, opts?: { overwriteBefore?: number; overwriteAfter?: number; undoStopBefore?: boolean; undoStopAfter?: boolean }): void };

const WORKSPACE_DIR = '.vscode';
const SURROUND_COMMAND = 'kingu.snippets.surroundWith';
const START_WITH_COMMAND = 'kingu.snippets.startWith';

const snippetId = (s: Snippet) => `${s.source}\u0000${s.file}\u0000${s.name}\u0000${s.prefix}`;

class SnippetStore {
	user = $state.raw<Snippet[]>([]);
	workspace = $state.raw<Snippet[]>([]);
	/** User snippet file names (`typescript.json`, `mine.code-snippets`). */
	userFiles = $state.raw<string[]>([]);
	/** Workspace snippet files (`.vscode/x.code-snippets`). */
	workspaceFiles = $state.raw<string[]>([]);
	readonly all: Snippet[] = $derived([...this.user, ...this.workspace]);
	#errors = new Map<string, string>();

	#report(file: string, error: string | undefined) {
		if (!error) return void this.#errors.delete(file);
		// Once per broken version of a file, like VS Code's log entry.
		if (this.#errors.get(file) === error) return;
		this.#errors.set(file, error);
		clientLog('info', `snippets ${file}: ${error}`);
	}

	async loadUser() {
		let files: UserFile[];
		try {
			files = await invoke<UserFile[]>('snippets_user_list');
		} catch (e) {
			clientLog('info', `user snippets: ${e}`);
			return;
		}
		this.userFiles = files.map((f) => f.name);
		this.user = files.flatMap((f) => {
			const { snippets, error } = parseSnippetFile(f.content, f.name, 'user');
			this.#report(f.name, error);
			return snippets;
		});
	}

	async loadWorkspace() {
		if (!workspace.root) {
			this.workspaceFiles = [];
			this.workspace = [];
			return;
		}
		const entries = await invoke<{ name: string; is_dir: boolean }[]>('fs_list_dir', { rel: WORKSPACE_DIR }).catch(() => []);
		const rels = entries.filter((e) => !e.is_dir && e.name.endsWith('.code-snippets')).map((e) => `${WORKSPACE_DIR}/${e.name}`);
		const loaded = await Promise.all(rels.map(async (rel) => [rel, await invoke<string>('read_workspace_file', { rel }).catch(() => '')] as const));
		this.workspaceFiles = rels;
		this.workspace = loaded.flatMap(([rel, text]) => {
			const { snippets, error } = parseSnippetFile(text, rel, 'workspace');
			this.#report(rel, error);
			return snippets;
		});
	}

	find(id: string): Snippet | undefined {
		return this.all.find((s) => snippetId(s) === id);
	}

	/** Loads both and keeps them current: profile switches and edits of the user files (Rust watches
	 * the config dir), `.vscode/*.code-snippets` changes in the folder, window focus. */
	install(): () => void {
		void this.loadUser();
		let unlisten: (() => void) | undefined;
		let gone = false;
		listen<string>('settings://changed', (e) => (e.payload === 'snippets' || e.payload === 'profiles') && void this.loadUser()).then((u) => (gone ? u() : (unlisten = u)));
		const offFiles = workspace.onFilesChanged((paths) => paths.some(isWorkspaceSnippetsPath) && void this.loadWorkspace());
		const stop = $effect.root(() => {
			$effect(() => {
				void workspace.root;
				void this.loadWorkspace();
			});
		});
		return () => {
			gone = true;
			unlisten?.();
			offFiles();
			stop();
		};
	}
}

export const snippetStore = new SnippetStore();

/** The tab key of a model (a workspace file, untitled, external, settings…). */
const keyOfModel = (model: Monaco.editor.ITextModel) => openModels().find(([, m]) => m === model)?.[0];

/** The file and folder variables of a model's file. */
function fileVariables(model: Monaco.editor.ITextModel): FileVariables & { abs: string } {
	const root = workspace.root;
	const key = keyOfModel(model);
	if (key && isUntitled(key)) return { path: '', relativePath: '', workspaceFolder: root, untitledName: untitledName(key), abs: untitledName(key) };
	if (key && isExternalKey(key)) {
		const abs = externalPath(key);
		return { path: abs, relativePath: abs, workspaceFolder: root, abs };
	}
	if (key && !key.includes('://') && root) return { path: `${root}/${key}`, relativePath: key, workspaceFolder: root, abs: `${root}/${key}` };
	const name = (key ?? model.uri.path).replace(/^.*\//, '');
	return { path: name, relativePath: name, workspaceFolder: root, abs: name };
}

/** The snippets for the model's language and file. */
function snippetsFor(model: Monaco.editor.ITextModel, opts: { includeNoPrefix?: boolean } = {}): Snippet[] {
	return selectSnippets(snippetStore.all, model.getLanguageId(), fileVariables(model).abs, opts);
}

const sourceLabel = (s: Snippet) => (s.source === 'workspace' ? t('editing.snippets.source.workspace') : s.language ? t('editing.snippets.source.user') : t('editing.snippets.source.globalUser'));

/** Inserts a snippet body at the editor's selections (Monaco's snippet controller). */
export function insertSnippetText(editor: Monaco.editor.ICodeEditor, body: string, opts?: { overwriteBefore?: number }) {
	const model = editor.getModel();
	const controller = editor.getContribution<Monaco.editor.IEditorContribution & SnippetController>('snippetController2');
	if (!model || !controller) return;
	editor.focus();
	controller.insert(prepareSnippet(body, fileVariables(model)), opts);
}

/** VS Code's snippet picker: grouped by where the snippets come from. */
async function pickSnippet(snippets: Snippet[]): Promise<Snippet | undefined> {
	if (!snippets.length) {
		status.flash(t('editing.snippets.none'));
		return undefined;
	}
	const ordered = [...snippets.filter((s) => s.source === 'user'), ...snippets.filter((s) => s.source === 'workspace')];
	const items: PickItem[] = ordered.map((s, i) => ({
		id: snippetId(s),
		label: s.prefix || s.name,
		description: [s.prefix ? s.name : '', s.description].filter(Boolean).join(' · ') || undefined,
		separator: i === 0 || ordered[i - 1].source !== s.source ? (s.source === 'user' ? t('editing.snippets.userGroup') : t('editing.snippets.workspaceGroup')) : undefined
	}));
	const item = await quick.choose({ placeholder: t('editing.snippets.select'), items });
	return item ? snippetStore.find(item.id) : undefined;
}

type InsertArgs = { snippet?: string; langId?: string; name?: string };

/** Insert Snippet: a pick, or the keybinding's `args` (`{ "snippet": "…" }` or `{ "langId", "name" }`). */
async function insertSnippetCommand(args?: unknown) {
	const editor = writableEditor();
	const model = editor?.getModel();
	if (!editor || !model) return;
	const a = (args && typeof args === 'object' ? args : {}) as InsertArgs;
	if (typeof a.snippet === 'string') return insertSnippetText(editor, a.snippet);
	if (typeof a.name === 'string') {
		const lang = typeof a.langId === 'string' ? a.langId : model.getLanguageId();
		const found = selectSnippets(snippetStore.all, lang, fileVariables(model).abs, { includeNoPrefix: true }).find((s) => s.name === a.name);
		if (found) return insertSnippetText(editor, found.body);
		return status.flash(t('editing.snippets.notFound', { name: a.name }));
	}
	const pick = await pickSnippet(snippetsFor(model, { includeNoPrefix: true }));
	if (pick) insertSnippetText(editor, pick.body);
}

const surroundable = (model: Monaco.editor.ITextModel) => snippetsFor(model, { includeNoPrefix: true }).filter((s) => s.usesSelection);

async function surroundWithCommand() {
	const editor = writableEditor();
	const model = editor?.getModel();
	if (!editor || !model || editor.getSelection()?.isEmpty()) return;
	const list = surroundable(model);
	if (!list.length) return status.flash(t('editing.snippets.noSurround'));
	const pick = await pickSnippet(list);
	if (pick) insertSnippetText(editor, pick.body);
}

/** Fill File with Snippet: the file templates of every language; the file takes the snippet's language. */
async function fillFileCommand() {
	const editor = writableEditor();
	const model = editor?.getModel();
	const api = monacoApi();
	if (!editor || !model || !api) return;
	const templates = selectSnippets(snippetStore.all, undefined, fileVariables(model).abs, { fileTemplates: true, includeNoPrefix: true });
	if (!templates.length) return status.flash(t('editing.snippets.noTemplates'));
	const spread = templates.flatMap((s) => (s.scopes.length ? s.scopes.map((lang) => ({ lang, s })) : [{ lang: '', s }])).sort((a, b) => a.lang.localeCompare(b.lang));
	const names = new Map(api.languages.getLanguages().map((l) => [l.id, l.aliases?.[0] ?? l.id]));
	const items: PickItem[] = spread.map(({ lang, s }, i) => ({
		id: String(i),
		label: s.prefix || s.name,
		description: s.description || undefined,
		separator: i === 0 || spread[i - 1].lang !== lang ? (lang ? (names.get(lang) ?? lang) : t('editing.snippets.anyLanguage')) : undefined
	}));
	const item = await quick.choose({ placeholder: t('editing.snippets.select'), items });
	if (!item) return;
	const { lang, s } = spread[Number(item.id)];
	// The language first, so the comment variables resolve against it.
	if (lang && names.has(lang)) api.editor.setModelLanguage(model, lang);
	editor.setSelection(model.getFullModelRange());
	insertSnippetText(editor, s.body);
}

async function openUserFile(name: string, kind: 'language' | 'global', languageId?: string) {
	try {
		const text = await invoke<string | null>('snippets_user_read', { name });
		if (text === null) {
			await invoke('snippets_user_write', { name, content: snippetFileTemplate(kind, languageId) });
			await snippetStore.loadUser();
		}
		editors.open(userSnippetsKey(name), { preview: false });
	} catch (e) {
		notifications.error(t('editing.snippets.openFailed', { error: String(e) }));
	}
}

async function openWorkspaceFile(file: string) {
	const rel = `${WORKSPACE_DIR}/${file}`;
	try {
		const exists = await invoke<string>('read_workspace_file', { rel }).then(
			() => true,
			() => false
		);
		if (!exists) {
			await invoke('fs_create_dir', { rel: WORKSPACE_DIR }).catch(() => {});
			await invoke('fs_create_file', { rel });
			await invoke('fs_write_file', { rel, content: snippetFileTemplate('global') });
			await snippetStore.loadWorkspace();
		}
		editors.open(rel, { preview: false });
	} catch (e) {
		notifications.error(t('editing.snippets.openFailed', { error: String(e) }));
	}
}

/** The name for a new `.code-snippets` file, checked against the existing ones. */
async function askFileName(existing: readonly string[]): Promise<string | undefined> {
	const value = await quick.input({
		placeholder: t('editing.snippets.fileName'),
		hint: (v) => {
			if (!v.trim()) return t('editing.snippets.fileNameHint');
			const name = globalSnippetFileName(v);
			if (!name) return t('editing.snippets.badName', { name: v.trim() });
			return existing.includes(name) ? t('editing.snippets.exists', { name }) : t('editing.snippets.create', { name });
		}
	});
	const name = value && globalSnippetFileName(value);
	if (!name) return undefined;
	if (existing.includes(name)) {
		status.flash(t('editing.snippets.exists', { name }));
		return undefined;
	}
	return name;
}

/** Configure Snippets: open an existing file, make a global one (user or folder), or a language's. */
async function configureSnippetsCommand() {
	await Promise.all([snippetStore.loadUser(), snippetStore.loadWorkspace()]);
	// The language list is Monaco's: loaded here when no editor has opened yet.
	const api = monacoApi() ?? (await import('#lib/editor/monaco.ts')).monaco;
	const current = activeCodeEditor()?.getModel()?.getLanguageId();
	const items: PickItem[] = [];
	const existing = [...snippetStore.userFiles.map((f) => ({ id: `user:${f}`, label: f, description: languageOfFile(f) ? t('editing.snippets.source.user') : t('editing.snippets.source.globalUser') })), ...snippetStore.workspaceFiles.map((f) => ({ id: `ws:${f}`, label: f.slice(WORKSPACE_DIR.length + 1), description: t('editing.snippets.source.workspace') }))];
	existing.forEach((e, i) => items.push({ ...e, separator: i === 0 ? t('editing.snippets.existing') : undefined }));
	items.push({ id: 'new:global', label: t('editing.snippets.newGlobal'), separator: t('editing.snippets.new') });
	const folder = workspace.root?.replace(/^.*\//, '');
	if (folder) items.push({ id: 'new:workspace', label: t('editing.snippets.newFolder', { folder }) });
	const languages = api.languages
		.getLanguages()
		.filter((l) => l.aliases?.length)
		.map((l) => ({ id: l.id, name: l.aliases![0] }))
		.sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : a.name.localeCompare(b.name)));
	for (const l of languages) {
		const has = snippetStore.userFiles.includes(`${l.id}.json`);
		if (has) continue;
		items.push({ id: `lang:${l.id}`, label: `${l.name} (${l.id})`, description: l.id === current ? t('editing.snippets.detected') : undefined });
	}
	const item = await quick.choose({ placeholder: t('editing.snippets.configurePlaceholder'), items });
	if (!item) return;
	const [kind, value] = [item.id.slice(0, item.id.indexOf(':')), item.id.slice(item.id.indexOf(':') + 1)];
	if (kind === 'user') return openUserFile(value, languageOfFile(value) ? 'language' : 'global', languageOfFile(value));
	if (kind === 'ws') return void editors.open(value, { preview: false });
	if (kind === 'lang') return openUserFile(`${value}.json`, 'language', value);
	if (value === 'global') {
		const name = await askFileName(snippetStore.userFiles);
		if (name) await openUserFile(name, 'global');
	} else {
		const name = await askFileName(snippetStore.workspaceFiles.map((f) => f.slice(WORKSPACE_DIR.length + 1)));
		if (name) await openWorkspaceFile(name);
	}
}

/** The snippet commands; returns the unregister function. */
export function installSnippetCommands(): () => void {
	const uninstallStore = snippetStore.install();
	const textEditor = () => editors.active !== null;
	const unregister = [
		commands.register({ id: 'editor.action.insertSnippet', title: 'Insert Snippet', category: 'Snippets', when: textEditor, run: (args) => insertSnippetCommand(args) }),
		commands.register({ id: 'editor.action.surroundWithSnippet', title: 'Surround with Snippet...', category: 'Snippets', when: textEditor, run: surroundWithCommand }),
		commands.register({ id: 'workbench.action.populateFileFromSnippet', title: 'Fill File with Snippet', category: 'Snippets', when: textEditor, run: fillFileCommand }),
		commands.register({ id: 'workbench.action.openSnippets', title: 'Configure Snippets', category: 'Snippets', run: configureSnippetsCommand })
	];
	return () => {
		unregister.forEach((u) => u());
		uninstallStore();
	};
}

let providersInstalled = false;

/** The snippet suggestions and code actions, registered once Monaco is loaded. */
function installProviders(monaco: MonacoApi) {
	if (providersInstalled) return;
	providersInstalled = true;
	monaco.languages.registerCompletionItemProvider('*', {
		provideCompletionItems(model, position, context) {
			const list = snippetsFor(model);
			if (!list.length) return { suggestions: [] };
			const line = model.getLineContent(position.lineNumber);
			const wordAt = (column: number) => {
				const w = model.getWordAtPosition({ lineNumber: position.lineNumber, column });
				return w ? { start: w.startColumn, end: w.endColumn } : null;
			};
			const trigger = context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter : undefined;
			const matches = matchSnippets(list, line, position.column, wordAt, trigger);
			const labels = snippetLabels(matches);
			const vars = fileVariables(model);
			const lang = model.getLanguageId();
			const suggestions = matches.map((m, i): Monaco.languages.CompletionItem => {
				const ln = position.lineNumber;
				return {
					label: { label: labels[i], description: m.snippet.name },
					kind: monaco.languages.CompletionItemKind.Snippet,
					detail: `${m.snippet.description || m.snippet.name} (${sourceLabel(m.snippet)})`,
					documentation: { value: '```' + lang + '\n' + snippetPreview(m.snippet) + '\n```' },
					insertText: prepareSnippet(m.snippet.body, vars),
					insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
					sortText: `a-${m.snippet.prefix}`,
					filterText: m.snippet.prefix,
					range: { insert: new monaco.Range(ln, m.startColumn, ln, position.column), replace: new monaco.Range(ln, m.startColumn, ln, m.replaceEndColumn) }
				};
			});
			return { suggestions };
		}
	});

	const codeActionKind = 'surround';
	monaco.languages.registerCodeActionProvider(
		'*',
		{
			provideCodeActions(model, range) {
				const none = { actions: [], dispose() {} };
				if (!settings.get<boolean>('editor.snippets.codeActions.enabled')) return none;
				const actions: Monaco.languages.CodeAction[] = [];
				const MAX = 4;
				if (!range.isEmpty()) {
					const list = surroundable(model);
					for (const s of list.slice(0, MAX)) actions.push({ title: s.name, kind: codeActionKind, command: { id: SURROUND_COMMAND, title: s.name, arguments: [snippetId(s)] } });
					if (list.length > MAX) actions.push({ title: t('editing.snippets.more'), kind: codeActionKind, command: { id: SURROUND_COMMAND, title: '' } });
				} else if (model.getValueLength() === 0) {
					const list = selectSnippets(snippetStore.all, model.getLanguageId(), fileVariables(model).abs, { fileTemplates: true, includeNoPrefix: true });
					for (const s of list.slice(0, MAX)) actions.push({ title: t('editing.snippets.startWith', { name: s.name }), kind: codeActionKind, command: { id: START_WITH_COMMAND, title: s.name, arguments: [snippetId(s)] } });
					if (list.length > MAX) actions.push({ title: t('editing.snippets.startWithMore'), kind: codeActionKind, command: { id: START_WITH_COMMAND, title: '' } });
				}
				return { actions, dispose() {} };
			}
		},
		{ providedCodeActionKinds: [codeActionKind] }
	);
	monaco.editor.registerCommand(SURROUND_COMMAND, (_accessor, id?: string) => {
		const snippet = id ? snippetStore.find(id) : undefined;
		const editor = writableEditor();
		if (!snippet) return void surroundWithCommand();
		if (editor) insertSnippetText(editor, snippet.body);
	});
	monaco.editor.registerCommand(START_WITH_COMMAND, (_accessor, id?: string) => {
		const snippet = id ? snippetStore.find(id) : undefined;
		const editor = writableEditor();
		const model = editor?.getModel();
		if (!snippet || !editor || !model) return void fillFileCommand();
		editor.setSelection(model.getFullModelRange());
		insertSnippetText(editor, snippet.body);
	});
}

/**
 * Per editor: Tab inserts the snippet whose prefix ends the text left of the cursor when
 * `editor.tabCompletion` is `onlySnippets` (VS Code TabCompletionController; with `on`, Monaco's
 * own Tab completion covers snippets too).
 */
export function attachSnippets(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor) {
	installProviders(monaco);
	const hasSnippets = editor.createContextKey<boolean>('kingu.hasSnippetCompletions', false);
	let active: Snippet[] = [];
	const update = () => {
		active = [];
		const model = editor.getModel();
		const sel = editor.getSelection();
		if (model && sel && editor.getOption(monaco.editor.EditorOption.tabCompletion) === 'onlySnippets') {
			const before = model.getLineContent(sel.positionLineNumber).slice(0, sel.positionColumn - 1);
			active = tabCompletionSnippets(snippetsFor(model), before, sel.isEmpty() ? null : model.getValueInRange(sel));
		}
		hasSnippets.set(active.length > 0);
	};
	editor.onDidChangeCursorSelection(update);
	editor.onDidChangeModel(update);
	editor.onDidChangeConfiguration((e) => e.hasChanged(monaco.editor.EditorOption.tabCompletion) && update());
	editor.addCommand(
		monaco.KeyCode.Tab,
		() => {
			if (active.length === 1) {
				const [s] = active;
				insertSnippetText(editor, s.body, { overwriteBefore: s.prefix.length });
			} else if (active.length > 1) editor.trigger('tabCompletion', 'editor.action.triggerSuggest', {});
		},
		'editorTextFocus && kingu.hasSnippetCompletions && !editorTabMovesFocus && !inSnippetMode && !suggestWidgetVisible && !inlineSuggestionVisible && !editorReadonly'
	);
}
