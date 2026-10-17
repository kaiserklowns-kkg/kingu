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
	hoverContents,
	relOfUri,
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
import { countDiagnostics, DiagnosticsIndex, SERVERS, serverFor, statusText, type ProblemFile, type ServerInfo } from './model';
import type { CompletionItem, Diagnostic, DocumentSymbol, SymbolInformation } from './protocol';

type MonacoApi = typeof Monaco;
type LspEvent = { type: 'message'; json: string } | { type: 'stderr'; line: string } | { type: 'exit'; code: number | null };
type Session = { info: ServerInfo; client: LanguageClient; id: number | null; ready: Promise<boolean> };
type Doc = { rel: string; uri: string; key: string; model: Monaco.editor.ITextModel };

const MARKER_OWNER = 'lsp';
const EXTERNAL_SCHEME = 'kingu-external';
const LOG_LIMIT = 1000;
const SYMBOLS_DELAY_MS = 400;

class Lsp {
	/** Per server key. Absent until a file of that language is opened. */
	status = new SvelteMap<string, ServerStatus>();
	problems = $state.raw<ProblemFile[]>([]);
	counts = $derived(countDiagnostics(this.problems));
	/** Language server output (stderr, logMessage), for the Output panel. */
	log = $state.raw<string[]>([]);
	/** Document symbols per workspace-relative path, for the breadcrumbs. */
	symbols = new SvelteMap<string, (DocumentSymbol | SymbolInformation)[]>();

	#monaco: MonacoApi | undefined;
	#root: Promise<string> | undefined;
	#rootPath = '';
	#sessions = new Map<string, Session>();
	#docs = new Map<Monaco.editor.ITextModel, Doc>();
	#index = new DiagnosticsIndex();
	/** Which server published diagnostics for a URI, so a stopped server's problems can be cleared. */
	#origin = new Map<string, string>();
	#refreshQueued = false;
	#registered = new Set<string>();
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
		// Providers stay registered: they look up whichever session is current.
		for (const doc of this.#docs.values()) if (doc.key === info.key) void this.#open(doc);
	}

	// --- Sessions --------------------------------------------------------------------------------

	#init(monaco: MonacoApi) {
		if (this.#monaco) return;
		this.#monaco = monaco;
		// Go to Definition into another file: open it as a tab and put the cursor on the target.
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
			showMessage: (type, message) => type <= 2 && statusBar.flash(`${info.name}: ${message}`)
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
				this.#registerProviders(info, caps.completionProvider?.triggerCharacters ?? []);
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
			d?.setModeConfiguration({ ...d.modeConfiguration, completionItems: false, hovers: false, definitions: false, diagnostics: false, documentSymbols: false });
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

	#registerProviders(info: ServerInfo, triggerCharacters: string[]) {
		const monaco = this.#monaco!;
		const resolved = new WeakMap<Monaco.languages.CompletionItem, { client: LanguageClient; item: CompletionItem }>();
		for (const language of info.languages) {
			if (this.#registered.has(language)) continue;
			this.#registered.add(language);

			monaco.languages.registerHoverProvider(language, {
				provideHover: async (model, position, token) => {
					const d = this.#lookup(model);
					const hover = d && (await d.client.hover(d.uri, toLspPosition(position), token).catch(() => null));
					return hover ? { contents: hoverContents(hover), range: hover.range && toMonacoRange(hover.range) } : null;
				}
			});

			monaco.languages.registerCompletionItemProvider(language, {
				triggerCharacters,
				provideCompletionItems: async (model, position, context, token) => {
					const d = this.#lookup(model);
					if (!d) return { suggestions: [] };
					const lspContext = { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter };
					const result = await d.client.completion(d.uri, toLspPosition(position), lspContext, token).catch(() => null);
					if (!result) return { suggestions: [] };
					const word = model.getWordUntilPosition(position);
					const fallback = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn };
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
			});

			monaco.languages.registerDefinitionProvider(language, {
				provideDefinition: async (model, position, token) => {
					const d = this.#lookup(model);
					const result = d && (await d.client.definition(d.uri, toLspPosition(position), token).catch(() => null));
					return toTargets(result).map((t) => {
						const rel = relOfUri(this.#rootPath, t.uri);
						const uri = rel !== null ? monaco.Uri.file('/' + rel) : monaco.Uri.from({ scheme: EXTERNAL_SCHEME, path: uriToPath(t.uri) ?? t.uri });
						return { uri, range: toMonacoRange(t.range) };
					});
				}
			});

			monaco.languages.registerDocumentSymbolProvider(language, {
				displayName: info.name,
				provideDocumentSymbols: async (model, token) => {
					const d = this.#lookup(model);
					const syms = d && (await d.client.documentSymbols(d.uri, token).catch(() => null));
					return syms ? toMonacoSymbols(syms) : [];
				}
			});
		}
	}
}

type TsDefaults = { modeConfiguration: object; setModeConfiguration(c: object): void };

export const lsp = new Lsp();
