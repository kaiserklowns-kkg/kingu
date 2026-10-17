// Language intelligence for the workbench (VS Code: the language client in each language
// extension). Starts a server per language on demand through Rust `lsp_start`, keeps it in sync
// with the Monaco models EditorHost owns, and exposes diagnostics and server status reactively.

import { Channel, invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import type * as Monaco from 'monaco-editor';
import { clientLog } from '#lib/client-log.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { status as statusBar } from '#lib/workbench/status.svelte.ts';
import { LanguageClient, type ServerStatus } from './client';
import {
	fromSignatureHelp,
	hoverContents,
	markerToDiagnostic,
	relOfUri,
	toDocumentHighlights,
	toLspRange,
	toMonacoTextEdits,
	toRenameLocation,
	toSignatureHelp,
	symbolPath,
	toCompletionItem,
	toLspPosition,
	toMarker,
	toMonacoRange,
	toMonacoSymbols,
	toTargets,
	uriOfRel,
	uriToPath,
	type Crumb
} from './convert';
import { configSection, countDiagnostics, DiagnosticsIndex, progressText, SERVERS, serverFor, statusText, type ProblemFile, type ServerInfo } from './model';
import type { CodeAction, Command, CompletionItem, Diagnostic, DocumentSymbol, ServerCapabilities, SymbolInformation, WorkspaceEdit } from './protocol';
import { applyWorkspaceEdit, type ApplyResult } from './workspaceEdit';

type MonacoApi = typeof Monaco;
type LspEvent = { type: 'message'; json: string } | { type: 'stderr'; line: string } | { type: 'exit'; code: number | null };
type Session = { info: ServerInfo; client: LanguageClient; id: number | null; ready: Promise<boolean> };
type Doc = { rel: string; uri: string; key: string; model: Monaco.editor.ITextModel };

const MARKER_OWNER = 'lsp';
const EXTERNAL_SCHEME = 'kingu-external';
const LOG_LIMIT = 1000;
const SYMBOLS_DELAY_MS = 400;
const CODE_ACTION_COMMAND = 'kingu.lsp.codeAction';

class Lsp {
	/** Per server key. Absent until a file of that language is opened. */
	status = new SvelteMap<string, ServerStatus>();
	problems = $state.raw<ProblemFile[]>([]);
	counts = $derived(countDiagnostics(this.problems));
	/** Language server output (stderr, logMessage), for the Output panel. */
	log = $state.raw<string[]>([]);
	/** Document symbols per workspace-relative path, for the breadcrumbs. */
	symbols = new SvelteMap<string, (DocumentSymbol | SymbolInformation)[]>();
	/** A busy server's progress for the status bar ("rust-analyzer: Indexing (40%)…"). */
	progress = $derived.by(() => {
		for (const info of SERVERS) {
			const text = progressText(info, this.status.get(info.key));
			if (text) return text;
		}
		return null;
	});
	/** Answers `workspace/configuration`, per server key (e.g. `{ 'rust-analyzer': { … } }`). */
	settings: Record<string, Record<string, unknown>> = {};

	#monaco: MonacoApi | undefined;
	#root: Promise<string> | undefined;
	#rootPath = '';
	#sessions = new Map<string, Session>();
	#docs = new Map<Monaco.editor.ITextModel, Doc>();
	#index = new DiagnosticsIndex();
	/** Which server published diagnostics for a URI, so a stopped server's problems can be cleared. */
	#origin = new Map<string, string>();
	#refreshQueued = false;
	/** Monaco providers per server key, replaced whenever that server (re)initializes. */
	#providers = new Map<string, Monaco.IDisposable[]>();
	/** Models created only so a references/definition peek can show files with no open tab. */
	#previews = new Map<string, Monaco.editor.ITextModel>();
	#symbolTimers = new Map<string, ReturnType<typeof setTimeout>>();
	#pendingLog: string[] = [];

	/** Called by EditorHost for every model it creates. */
	attach(monaco: MonacoApi, model: Monaco.editor.ITextModel, rel: string) {
		const info = serverFor(model.getLanguageId());
		if (!info || this.#docs.has(model)) return;
		this.#init(monaco);
		const doc: Doc = { rel, uri: '', key: info.key, model };
		this.#docs.set(model, doc);
		const changed = model.onDidChangeContent(() => {
			if (!doc.uri) return;
			this.#sessions.get(info.key)?.client.didChange(doc.uri, model.getValue());
			this.#scheduleSymbols(doc);
		});
		model.onWillDispose(() => {
			changed.dispose();
			this.#docs.delete(model);
			this.symbols.delete(rel);
			if (doc.uri) this.#sessions.get(info.key)?.client.didClose(doc.uri);
		});
		void this.#open(doc);
	}

	didSave(model: Monaco.editor.ITextModel) {
		const doc = this.#docs.get(model);
		if (doc?.uri) this.#sessions.get(doc.key)?.client.didSave(doc.uri);
	}

	/** Status bar entry for a Monaco language id, or null when it has no server. */
	statusFor(languageId: string): { text: string; tooltip: string; state: ServerStatus['state'] } | null {
		const info = serverFor(languageId);
		const s = info && this.status.get(info.key);
		if (!info || !s) return null;
		return { text: statusText(info, s), tooltip: s.message ?? statusText(info, s), state: s.state };
	}

	crumbs(rel: string, line: number, column: number): Crumb[] {
		const syms = this.symbols.get(rel);
		return syms ? symbolPath(syms, toLspPosition({ lineNumber: line, column })) : [];
	}

	hasServer(languageId: string) {
		return serverFor(languageId) !== undefined;
	}

	/** Stops the server for `languageId` and starts it again with every open document. */
	async restart(languageId: string) {
		const info = serverFor(languageId);
		if (!info) return;
		await this.#stop(info.key);
		// Providers are registered again once the new session reports its capabilities.
		for (const doc of this.#docs.values()) if (doc.key === info.key) void this.#open(doc);
	}

	/** Open Folder: Rust has already killed the old root's servers; forget them and the cached root. */
	reset() {
		for (const key of [...this.#sessions.keys()]) this.#forget(key);
		this.#root = undefined;
		this.#rootPath = '';
		for (const [rel, model] of [...this.#previews]) this.#dropPreview(rel, model);
		this.status.clear();
		this.symbols.clear();
	}

	// --- Sessions --------------------------------------------------------------------------------

	#init(monaco: MonacoApi) {
		if (this.#monaco) return;
		this.#monaco = monaco;
		// Go to Definition into another file: open it as a tab and put the cursor on the target.
		monaco.editor.registerCommand(CODE_ACTION_COMMAND, (_accessor, key: string, item: Command | CodeAction) => void this.#runCodeAction(key, item));
		monaco.editor.registerEditorOpener({
			openCodeEditor: (_source, resource, selection) => {
				const at = selection && 'startLineNumber' in selection ? { line: selection.startLineNumber, column: selection.startColumn } : selection ? { line: selection.lineNumber, column: selection.column } : { line: 1, column: 1 };
				if (resource.scheme === EXTERNAL_SCHEME) {
					statusBar.flash(`${resource.path} อยู่นอก workspace จึงเปิดไม่ได้`);
					return true;
				}
				if (resource.scheme !== 'file') return false;
				editors.openAt(resource.path.replace(/^\//, ''), at.line, at.column, { preview: true });
				return true;
			}
		});
	}

	async #rootDir(): Promise<string> {
		this.#root ??= invoke<{ workspace: string }>('app_info').then((i) => (this.#rootPath = i.workspace));
		return this.#root;
	}

	async #open(doc: Doc) {
		const session = await this.#session(doc.key);
		if (!session || !(await session.ready) || !this.#docs.has(doc.model)) return;
		doc.uri = uriOfRel(this.#rootPath, doc.rel);
		session.client.didOpen(doc.uri, doc.model.getLanguageId(), doc.model.getValue());
		this.#applyMarkers(doc.uri);
		this.#scheduleSymbols(doc, 0);
	}

	async #session(key: string): Promise<Session | null> {
		const existing = this.#sessions.get(key);
		if (existing) return existing;
		const info = SERVERS.find((s) => s.key === key)!;
		const root = await this.#rootDir();
		const again = this.#sessions.get(key);
		if (again) return again;

		let id: number | null = null;
		let chain: Promise<unknown> = Promise.resolve();
		// Sends are chained so the server sees them in order (separate IPC calls may not be).
		const write = (json: string) => {
			chain = chain.then(() => (id === null ? undefined : invoke('lsp_send', { id, message: json }))).catch((e) => this.#append(`${info.name}: send failed: ${e}`));
		};
		const client = new LanguageClient(info.name, write, {
			diagnostics: (uri, kind, items) => {
				this.#origin.set(uri, key);
				this.#setDiagnostics(uri, kind, items);
			},
			status: (s) => this.#setStatus(info, s),
			log: (line) => this.#append(line),
			// MessageType Error 1, Warning 2, Info 3 flash; Log 4 only goes to the Output log.
			showMessage: (type, message) => type <= 3 && statusBar.flash(`${info.name}: ${message}`),
			applyEdit: (edit) => this.applyWorkspaceEdit(edit),
			configuration: (section) => configSection(this.settings[key] ?? {}, section)
		});
		const channel = new Channel<LspEvent>();
		channel.onmessage = (ev) => {
			if (ev.type === 'message') client.rpc.handle(ev.json);
			else if (ev.type === 'stderr') this.#append(ev.line);
			else {
				this.#append(`${info.name} exited (code ${ev.code})`);
				client.exited(ev.code);
				if (this.#sessions.get(key)?.client === client) this.#forget(key);
			}
		};
		const session: Session = { info, client, id: null, ready: Promise.resolve(false) };
		this.#sessions.set(key, session);
		this.#setStatus(info, { state: 'starting' });
		session.ready = (async () => {
			try {
				id = await invoke<number>('lsp_start', { language: info.languages[0], onEvent: channel });
				session.id = id;
				const caps = await client.initialize(uriOfRel(root, '').replace(/\/$/, ''));
				clientLog('info', `${info.name} initialized`);
				if (this.#sessions.get(key) === session) this.#registerProviders(info, caps);
				return true;
			} catch (e) {
				const message = String(e);
				this.#setStatus(info, { state: message.includes('not installed') ? 'not-installed' : 'error', message });
				this.#append(message);
				clientLog('error', `language server ${key}: ${message}`);
				return false;
			}
		})();
		return session;
	}

	async #stop(key: string) {
		const s = this.#sessions.get(key);
		if (!s) return;
		this.#forget(key);
		try {
			await Promise.race([s.client.shutdown(), new Promise((r) => setTimeout(r, 2000))]);
		} catch {
			/* already gone */
		}
		if (s.id !== null) await invoke('lsp_stop', { id: s.id }).catch(() => {});
	}

	/** Drops a session and everything it published (VS Code clears a stopped server's problems). */
	#forget(key: string) {
		this.#sessions.delete(key);
		this.#providers.get(key)?.forEach((d) => d.dispose());
		this.#providers.delete(key);
		for (const uri of this.#index.clear((uri) => this.#origin.get(uri) === key)) {
			this.#origin.delete(uri);
			this.#applyMarkers(uri);
		}
		for (const d of this.#docs.values()) if (d.key === key) d.uri = '';
		this.#queueRefresh();
	}

	#setStatus(info: ServerInfo, s: ServerStatus) {
		this.status.set(info.key, s);
		if (info.key === 'typescript' && s.state === 'ready') this.#yieldBuiltinTypeScript();
	}

	/** Monaco's bundled TypeScript worker would answer hovers and completions a second time. */
	#yieldBuiltinTypeScript() {
		const ts = (this.#monaco as unknown as { typescript?: { typescriptDefaults: TsDefaults; javascriptDefaults: TsDefaults } } | undefined)?.typescript;
		for (const d of [ts?.typescriptDefaults, ts?.javascriptDefaults]) {
			d?.setModeConfiguration({
				...d.modeConfiguration,
				completionItems: false,
				hovers: false,
				definitions: false,
				diagnostics: false,
				documentSymbols: false,
				references: false,
				documentHighlights: false,
				rename: false,
				signatureHelp: false,
				documentRangeFormattingEdits: false,
				onTypeFormattingEdits: false,
				codeActions: false
			});
		}
	}

	#append(line: string) {
		this.#pendingLog.push(line);
		if (this.#pendingLog.length > 1) return;
		queueMicrotask(() => {
			this.log = [...this.log, ...this.#pendingLog].slice(-LOG_LIMIT);
			this.#pendingLog = [];
		});
	}

	// --- Diagnostics -----------------------------------------------------------------------------

	#setDiagnostics(uri: string, kind: 'push' | 'pull', items: Diagnostic[]) {
		this.#index.set(uri, kind, items);
		this.#applyMarkers(uri);
		this.#queueRefresh();
	}

	#applyMarkers(uri: string) {
		const monaco = this.#monaco;
		const rel = relOfUri(this.#rootPath, uri);
		if (!monaco || rel === null) return;
		const model = monaco.editor.getModel(monaco.Uri.file('/' + rel));
		if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, this.#index.get(uri).map(toMarker));
	}

	#queueRefresh() {
		if (this.#refreshQueued) return;
		this.#refreshQueued = true;
		queueMicrotask(() => {
			this.#refreshQueued = false;
			this.problems = this.#index.files(this.#rootPath);
		});
	}

	// --- Symbols (breadcrumbs) -------------------------------------------------------------------

	#scheduleSymbols(doc: Doc, delay = SYMBOLS_DELAY_MS) {
		clearTimeout(this.#symbolTimers.get(doc.rel));
		this.#symbolTimers.set(
			doc.rel,
			setTimeout(async () => {
				const client = this.#sessions.get(doc.key)?.client;
				if (!doc.uri || !client?.ready) return;
				try {
					const syms = await client.documentSymbols(doc.uri);
					if (this.#docs.has(doc.model)) this.symbols.set(doc.rel, syms ?? []);
				} catch {
					/* indexing; the next edit asks again */
				}
			}, delay)
		);
	}

	// --- Monaco providers ------------------------------------------------------------------------

	#lookup(model: Monaco.editor.ITextModel): { client: LanguageClient; uri: string } | null {
		const doc = this.#docs.get(model);
		const client = doc?.uri ? this.#sessions.get(doc.key)?.client : undefined;
		return doc && client?.ready ? { client, uri: doc.uri } : null;
	}

	/** Monaco location of an LSP URI: a workspace file, or an external one Monaco cannot open. */
	#monacoUri(uri: string): Monaco.Uri {
		const monaco = this.#monaco!;
		const rel = relOfUri(this.#rootPath, uri);
		return rel !== null ? monaco.Uri.file('/' + rel) : monaco.Uri.from({ scheme: EXTERNAL_SCHEME, path: uriToPath(uri) ?? uri });
	}

	/** Peek widgets need a model for every file they show; create read-only previews for files
	 * with no tab (EditorHost adopts one through `adoptPreview` when the file is opened). */
	async #ensurePreviews(rels: string[], { dropOthers = false } = {}) {
		const monaco = this.#monaco!;
		const want = new Set(rels);
		if (dropOthers) for (const [rel, model] of this.#previews) if (!want.has(rel)) this.#dropPreview(rel, model);
		const missing = [...want].filter((rel) => !monaco.editor.getModel(monaco.Uri.file('/' + rel)));
		if (!missing.length) return;
		const { languageFor } = await import('#lib/editor/monaco.ts');
		await Promise.all(
			missing.map(async (rel) => {
				const text = await invoke<string>('read_workspace_file', { rel }).catch(() => null);
				const uri = monaco.Uri.file('/' + rel);
				if (text === null || monaco.editor.getModel(uri)) return;
				this.#previews.set(rel, monaco.editor.createModel(text, languageFor(rel), uri));
			})
		);
	}

	#dropPreview(rel: string, model = this.#previews.get(rel)) {
		this.#previews.delete(rel);
		if (model && !model.isDisposed()) model.dispose();
	}

	/** EditorHost takes over a preview model when its file is opened in a tab. */
	adoptPreview(rel: string): Monaco.editor.ITextModel | null {
		const model = this.#previews.get(rel);
		this.#previews.delete(rel);
		return model && !model.isDisposed() ? model : null;
	}

	/** Applies a WorkspaceEdit (rename, code actions, `workspace/applyEdit`): files open in an editor
	 * are edited in their model (undoable, left dirty), others are rewritten on disk through the
	 * workspace-guarded Rust commands. Nothing outside the workspace is touched. */
	async applyWorkspaceEdit(edit: WorkspaceEdit): Promise<ApplyResult> {
		const written: string[] = [];
		const result = await applyWorkspaceEdit(edit, (uri) => {
			const rel = relOfUri(this.#rootPath, uri);
			if (rel === null) return `${uriToPath(uri) ?? uri} is outside the workspace`;
			const model = editors.textModel(rel);
			if (model) {
				const doc = this.#docs.get(model);
				return {
					version: doc?.uri === uri ? this.#sessions.get(doc.key)?.client.versionOf(uri) : undefined,
					read: () => model.getValue(),
					commit: (text, edits) => {
						const ops = edits ? toMonacoTextEdits(edits) : [{ range: model.getFullModelRange(), text }];
						model.pushStackElement();
						model.pushEditOperations([], ops.map((e) => ({ range: e.range, text: e.text, forceMoveMarkers: true })), () => null);
						model.pushStackElement();
					}
				};
			}
			return {
				read: () => invoke<string>('read_workspace_file', { rel }),
				commit: async (text) => {
					await invoke('fs_write_file', { rel, content: text });
					written.push(uri);
					this.#dropPreview(rel);
				}
			};
		});
		if (written.length) for (const s of this.#sessions.values()) s.client.didChangeWatchedFiles(written);
		if (!result.applied) this.#append(`workspace edit not applied: ${result.failureReason}`);
		return result;
	}

	async #runCodeAction(key: string, item: Command | CodeAction) {
		const client = this.#sessions.get(key)?.client;
		if (!client?.ready) return;
		try {
			if (typeof item.command === 'string') return void (await this.#execute(client, item as Command));
			let action = item as CodeAction;
			if (!action.edit && client.canResolveCodeAction) action = (await client.resolveCodeAction(action)) ?? action;
			if (action.edit) {
				const r = await this.applyWorkspaceEdit(action.edit);
				if (!r.applied) return statusBar.flash(`${action.title}: ${r.failureReason}`);
			}
			if (action.command) await this.#execute(client, action.command);
		} catch (e) {
			statusBar.flash(`${item.title}: ${e instanceof Error ? e.message : e}`);
		}
	}

	async #execute(client: LanguageClient, command: Command) {
		if (!(await client.executeCommand(command))) statusBar.flash(`${command.title || command.command}: not supported by the server`);
	}

	#registerProviders(info: ServerInfo, caps: ServerCapabilities) {
		const monaco = this.#monaco!;
		this.#providers.get(info.key)?.forEach((d) => d.dispose());
		const disposables: Monaco.IDisposable[] = [];
		this.#providers.set(info.key, disposables);
		const add = (d: Monaco.IDisposable) => disposables.push(d);
		const resolved = new WeakMap<Monaco.languages.CompletionItem, { client: LanguageClient; item: CompletionItem }>();
		const word = (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
			const w = model.getWordAtPosition(position);
			return w ? { range: { startLineNumber: position.lineNumber, startColumn: w.startColumn, endLineNumber: position.lineNumber, endColumn: w.endColumn }, text: w.word } : null;
		};

		for (const language of info.languages) {
			if (caps.hoverProvider)
				add(
					monaco.languages.registerHoverProvider(language, {
						provideHover: async (model, position, token) => {
							const d = this.#lookup(model);
							const hover = d && (await d.client.hover(d.uri, toLspPosition(position), token).catch(() => null));
							return hover ? { contents: hoverContents(hover), range: hover.range && toMonacoRange(hover.range) } : null;
						}
					})
				);

			if (caps.completionProvider)
				add(
					monaco.languages.registerCompletionItemProvider(language, {
						triggerCharacters: caps.completionProvider.triggerCharacters ?? [],
						provideCompletionItems: async (model, position, context, token) => {
							const d = this.#lookup(model);
							if (!d) return { suggestions: [] };
							const lspContext = { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter };
							const result = await d.client.completion(d.uri, toLspPosition(position), lspContext, token).catch(() => null);
							if (!result) return { suggestions: [] };
							const w = model.getWordUntilPosition(position);
							const fallback = { startLineNumber: position.lineNumber, startColumn: w.startColumn, endLineNumber: position.lineNumber, endColumn: w.endColumn };
							const list = Array.isArray(result) ? { isIncomplete: false, items: result } : result;
							const suggestions = list.items.map((item) => {
								const s = toCompletionItem(item, fallback, list.itemDefaults);
								resolved.set(s, { client: d.client, item: list.itemDefaults?.data !== undefined && item.data === undefined ? { ...item, data: list.itemDefaults.data } : item });
								return s;
							});
							return { suggestions, incomplete: list.isIncomplete };
						},
						resolveCompletionItem: async (suggestion, token) => {
							const r = resolved.get(suggestion);
							if (!r?.client.capabilities.completionProvider?.resolveProvider) return suggestion;
							const item = await r.client.resolveCompletion(r.item, token).catch(() => null);
							if (!item) return suggestion;
							const range = suggestion.range;
							const full = toCompletionItem(item, 'insert' in range ? range.replace : range);
							// Keep what Monaco already placed; take the fields resolve exists to fill in.
							return { ...suggestion, detail: full.detail ?? suggestion.detail, documentation: full.documentation ?? suggestion.documentation, additionalTextEdits: full.additionalTextEdits ?? suggestion.additionalTextEdits };
						}
					})
				);

			if (caps.definitionProvider)
				add(
					monaco.languages.registerDefinitionProvider(language, {
						provideDefinition: async (model, position, token) => {
							const d = this.#lookup(model);
							const result = d && (await d.client.definition(d.uri, toLspPosition(position), token).catch(() => null));
							const targets = toTargets(result);
							await this.#ensurePreviews(targets.map((t) => relOfUri(this.#rootPath, t.uri)).filter((r) => r !== null));
							return targets.map((t) => ({ uri: this.#monacoUri(t.uri), range: toMonacoRange(t.range) }));
						}
					})
				);

			if (caps.referencesProvider)
				add(
					monaco.languages.registerReferenceProvider(language, {
						provideReferences: async (model, position, context, token) => {
							const d = this.#lookup(model);
							const result = d && (await d.client.references(d.uri, toLspPosition(position), context.includeDeclaration, token).catch(() => null));
							// The peek can only show workspace files (it needs a model for each).
							const inside = (result ?? []).filter((l) => relOfUri(this.#rootPath, l.uri) !== null);
							await this.#ensurePreviews(
								inside.map((l) => relOfUri(this.#rootPath, l.uri)!),
								{ dropOthers: true }
							);
							return inside.map((l) => ({ uri: this.#monacoUri(l.uri), range: toMonacoRange(l.range) }));
						}
					})
				);

			if (caps.documentHighlightProvider)
				add(
					monaco.languages.registerDocumentHighlightProvider(language, {
						provideDocumentHighlights: async (model, position, token) => {
							const d = this.#lookup(model);
							return toDocumentHighlights(d && (await d.client.documentHighlight(d.uri, toLspPosition(position), token).catch(() => null)));
						}
					})
				);

			if (caps.documentSymbolProvider)
				add(
					monaco.languages.registerDocumentSymbolProvider(language, {
						displayName: info.name,
						provideDocumentSymbols: async (model, token) => {
							const d = this.#lookup(model);
							const syms = d && (await d.client.documentSymbols(d.uri, token).catch(() => null));
							return syms ? toMonacoSymbols(syms) : [];
						}
					})
				);

			if (caps.signatureHelpProvider)
				add(
					monaco.languages.registerSignatureHelpProvider(language, {
						signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters ?? [],
						signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters ?? [],
						provideSignatureHelp: async (model, position, token, context) => {
							const d = this.#lookup(model);
							if (!d) return null;
							const lspContext = {
								triggerKind: context.triggerKind,
								triggerCharacter: context.triggerCharacter,
								isRetrigger: context.isRetrigger,
								activeSignatureHelp: context.activeSignatureHelp && fromSignatureHelp(context.activeSignatureHelp)
							};
							const help = await d.client.signatureHelp(d.uri, toLspPosition(position), lspContext, token).catch(() => null);
							return help?.signatures?.length ? { value: toSignatureHelp(help), dispose() {} } : null;
						}
					})
				);

			if (caps.renameProvider)
				add(
					monaco.languages.registerRenameProvider(language, {
						resolveRenameLocation: async (model, position, token) => {
							const d = this.#lookup(model);
							const fallback = word(model, position);
							const reject = (rejectReason: string) => ({ range: fallback?.range ?? toMonacoRange({ start: toLspPosition(position), end: toLspPosition(position) }), text: '', rejectReason });
							if (!d) return reject(`${info.name} is not ready`);
							let prepared;
							if (d.client.canPrepareRename) {
								try {
									prepared = await d.client.prepareRename(d.uri, toLspPosition(position), token);
								} catch (e) {
									return reject(e instanceof Error ? e.message : String(e));
								}
							}
							return toRenameLocation(prepared, fallback, (r) => model.getValueInRange(r)) ?? reject("The element can't be renamed.");
						},
						provideRenameEdits: async (model, position, newName, token) => {
							const d = this.#lookup(model);
							if (!d) return { edits: [], rejectReason: `${info.name} is not ready` };
							let edit: WorkspaceEdit | null;
							try {
								edit = await d.client.rename(d.uri, toLspPosition(position), newName, token);
							} catch (e) {
								return { edits: [], rejectReason: e instanceof Error ? e.message : String(e) };
							}
							if (!edit) return { edits: [], rejectReason: 'No result.' };
							// Applied here rather than by Monaco, whose standalone bulk edit only reaches
							// open models; files without a tab are rewritten on disk.
							const r = await this.applyWorkspaceEdit(edit);
							if (!r.applied) return { edits: [], rejectReason: `Rename failed: ${r.failureReason}` };
							statusBar.flash(`Renamed to '${newName}': ${r.edits} edits in ${r.uris.length} ${r.uris.length === 1 ? 'file' : 'files'}`);
							return { edits: [] };
						}
					})
				);

			if (caps.codeActionProvider) {
				const kinds = typeof caps.codeActionProvider === 'object' ? caps.codeActionProvider.codeActionKinds : undefined;
				add(
					monaco.languages.registerCodeActionProvider(
						language,
						{
							provideCodeActions: async (model, range, context, token) => {
								const d = this.#lookup(model);
								const none = { actions: [], dispose() {} };
								if (!d) return none;
								const lspContext = { diagnostics: context.markers.map(markerToDiagnostic), only: context.only ? [context.only] : undefined, triggerKind: context.trigger };
								const items = await d.client.codeActions(d.uri, toLspRange(range), lspContext, token).catch(() => null);
								if (!items?.length) return none;
								const actions = items.map((item): Monaco.languages.CodeAction => {
									const run = { id: CODE_ACTION_COMMAND, title: item.title, arguments: [info.key, item] };
									if (typeof item.command === 'string') return { title: item.title, command: run };
									const a = item as CodeAction;
									return {
										title: a.title,
										kind: a.kind,
										isPreferred: a.isPreferred,
										disabled: a.disabled?.reason,
										diagnostics: a.diagnostics?.map((x) => toMarker(x)),
										command: run
									};
								});
								return { actions, dispose() {} };
							}
						},
						kinds ? { providedCodeActionKinds: kinds } : undefined
					)
				);
			}

			if (caps.documentFormattingProvider)
				add(
					monaco.languages.registerDocumentFormattingEditProvider(language, {
						displayName: info.name,
						provideDocumentFormattingEdits: async (model, options, token) => {
							const d = this.#lookup(model);
							const fmt = { tabSize: options.tabSize, insertSpaces: options.insertSpaces };
							return toMonacoTextEdits(d && (await d.client.formatting(d.uri, fmt, token).catch((e) => (statusBar.flash(`Format: ${e}`), null))));
						}
					})
				);

			if (caps.documentRangeFormattingProvider)
				add(
					monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
						displayName: info.name,
						provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
							const d = this.#lookup(model);
							const fmt = { tabSize: options.tabSize, insertSpaces: options.insertSpaces };
							return toMonacoTextEdits(d && (await d.client.rangeFormatting(d.uri, toLspRange(range), fmt, token).catch((e) => (statusBar.flash(`Format: ${e}`), null))));
						}
					})
				);
		}
	}
}

type TsDefaults = { modeConfiguration: object; setModeConfiguration(c: object): void };

export const lsp = new Lsp();
